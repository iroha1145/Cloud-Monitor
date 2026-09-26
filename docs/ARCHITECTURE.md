# Cloud Monitor v2 架构说明

## 数据流

```
OpenWebUI ──Filter──► 本地 openwebui-monitor (SQLite, 端口 7878)
                          │  GET /api/v1/sync/meta        ← 数据源实例 + 最大 id（新接口）
                          │  GET /api/v1/sync/records     ← id 游标分页（新接口）
                          │  GET /api/v1/users
                  sync-agent v2（本机 Docker）
                          │  POST 云端 /api/v1/sync/push   Bearer CLOUD_API_KEY
                          ▼
              Cloud-monitor hub v2（服务器 Docker, SQLite）
                          ├─ GET /            网页看板（openwebui-monitor 前端原样托管）
                          └─ GET /api/v1/usage|users|records|devices  只读 API
```

可选支路：sync-agent 后台线程 `POST <token-monitor hub>/api/ingest`，
把 today/month/allTime 用量摘要按 token-monitor 的标准字段推送。

## 同步协议 v2（协议版本号 2）

### 游标模式（首选）

本地 monitor 提供 `/api/v1/sync/meta`（source_instance_id + max_record_id）
与 `/api/v1/sync/records?after_id=&snapshot_max_id=&limit=`（`WHERE id > ? AND
id <= ? ORDER BY id ASC LIMIT ?`）。每轮：

1. 读 meta，固定本轮快照上界 `snapshot_max_id`（期间新增记录留到下一轮）。
2. 从持久化游标开始按批拉取（默认 200 条/批）。
3. 每批推送成功且响应校验通过后，**立即**把游标推进到批内最大 id 并落盘
   ——云端故障只重推未确认批次，不再每分钟重复读整个窗口。
4. 无新数据时发送心跳（records=[]，携带 users），云端据此刷新
   last_seen_at 并同步用户改名/角色/邮箱。

旧版 monitor（无 /sync 接口）自动回退时间窗口模式并打印一次性性能警告。

### 响应校验（不通过则不推进游标）

```
success == true
device_id == 本设备
source_instance_id == 本轮来源
received == 发送条数
inserted + duplicates + conflicts == received
conflicts == 0
```

### 幂等与冲突

云端唯一键 `UNIQUE(device_id, source_instance_id, local_id)`。每条记录入库时
计算内容指纹（user_id/nickname/model_name/tokens/created_at 的 SHA-256）：

- 同键同指纹 → `duplicates`（正常重推，幂等）
- 同键不同指纹 → `conflicts`（本地库被改写或时钟错乱；云端保留原数据，
  agent 收到 conflicts>0 不推进游标并报错，交由人工判断）

### 设备身份与数据源实例

- **device_id**：`DEVICE_ID` 环境变量优先；否则首次生成 UUID 持久化到
  状态卷。容器重建、hostname 变化都不影响身份。
- **source_instance_id**：标识"本地这份数据库文件"。由本地 monitor 生成
  并存库；数据库重建后是新 UUID。agent 检测到实例变化即重置游标全量同步，
  因此重建后 local_id 从 1 重新计数不会与旧记录冲突或被去重吞掉。
- **状态文件**（`agent-state.json`）：`schema_version` 严格校验；损坏时
  备份为 `*.corrupt-<时间戳>` 并拒绝静默重置身份（未显式配置 DEVICE_ID
  时直接退出，提示人工处理）。

### 错误分类与降级

- **临时**（429/5xx/网络错误）：同轮内指数退避 + 随机抖动重试
  （1s/2s/4s + jitter），失败下轮再来。
- **永久**（400/401/403/404 等 4xx）：不重试，进入降级模式（间隔 ×10），
  状态文件记录 `last_permanent_error`，Docker 健康检查判定为不健康。

## 云端数据模型（schema v2，PRAGMA user_version=2）

```sql
devices(id PK, name, platform, agent_version, first_seen_at, last_seen_at)
users(id PK, email, name, role, created_at, updated_at)
    -- 首次插入保留本地 created_at；更新不覆盖原始 created_at
usage_records(
  id PK AUTOINCREMENT,
  device_id, source_instance_id, local_id,
  user_id, nickname, model_name,
  input_tokens, output_tokens, created_at,
  fingerprint,               -- 内容指纹，duplicates/conflicts 判定依据
  UNIQUE(device_id, source_instance_id, local_id)
)
-- 组合索引 (created_at,id) (device_id,created_at) (user_id,created_at) (model_name,created_at)
```

### 从 v1 迁移（不清空数据）

首次以新代码打开旧库时自动执行：补 `source_instance_id`（存量全部标
`legacy`）与 `fingerprint` 列并回填指纹、删除旧唯一索引
`(device_id, local_id)`、创建新唯一索引与组合索引、写 user_version。
迁移幂等，重复打开不会破坏数据。

## 并发模型

单连接 + `threading.RLock`：FastAPI 同步路由在线程池中并发调用也全部串行
持锁执行。写路径 `apply_sync_push` 在 `BEGIN IMMEDIATE` 显式事务内完成
device/users/records 三类写入，任何异常整体 ROLLBACK（无半批数据）。

`users` 每次最多 500 条；代理将更大的用户列表分块发送，全部分块成功后才
记录用户摘要和同步时间。`records` 仍遵循 `MAX_RECORDS_PER_PUSH`。
超限请求返回 400，设备、用户和用量均不写入。

就绪检查的数据库部分共用一秒预算，覆盖进程内互斥锁和 SQLite 写锁等待；
超时返回结构化 503，不回滚其他线程的事务。探测结束后恢复普通写入的
30 秒数据库等待设置。`/api/v1/health/live` 只检查进程响应，不访问数据库。
PRAGMA：`journal_mode=WAL`、`synchronous=NORMAL`、`busy_timeout=30000`、
`foreign_keys=ON`。应用关闭时（FastAPI shutdown）关闭连接。
单 Uvicorn worker，不开多进程共享连接。

压测：32 线程 × 200 批 × 100 条 = 20000 条，零异常、恰好 20000 行
（`test_concurrent_push_32_threads_200_batches`）。

## 读接口兼容性与性能

`/api/v1/records` 改为 SQL `COUNT(*) + LIMIT/OFFSET` 分页；`/api/v1/usage`
改为 SQL `GROUP BY` 聚合（totals/by_user/by_model/by_device/time_range），
10 万条记录下首页只取 20 行、聚合与 Python 基准逐项一致
（`test_records_sql_pagination_on_100k`、`test_usage_sql_aggregation_matches_python_baseline`）。
返回 JSON 结构与 v1 完全一致，前端零改动。

`by_user` 的昵称优先取 users 表当前名字（用户改名即时生效），为空时回退
到该用户最新一条非空记录昵称——修复了 v1 倒序遍历最终留下最旧昵称的问题。

## token-monitor 桥接 v2

⚠ v1 文档中「hub 端会克隆并保留未识别字段（perModel 即利用这一点）」的
表述是**错误**的：保留的是设备记录级字段，周期对象内部结构按官方字段解析，
杜撰字段不会被使用。v2 已按 token-monitor @5be24d3 源码核对重写：

```jsonc
{
  "deviceId": "openwebui:<device-id>",   // 独立设备 ID，不与真 agent 冲突
  "hostname": "<DEVICE_NAME>",            // 不用容器 hostname
  "platform": "<HOST_PLATFORM>",          // 不用容器平台
  "agentRuntime": "headless-agent",
  "capabilities": {"tokenComponents": false},  // 我们没有缓存读写数据
  "updatedAt": "<UTC ISO>",
  "periodWindows": {"timeZone": "Asia/Tokyo",
                    "today": {"key": "YYYY-MM-DD", "endsAt": "<UTC>"},
                    "month": {"key": "YYYY-MM", "endsAt": "<UTC>"}},
  "today"|"month"|"allTime": {
    "totalTokens": input + output,
    "outputTokens": output,
    "unclassifiedTokens": input,          // input 归为未分类
    "costUsd": 0,
    "clients": {"openwebui": total},
    "clientModels": {"openwebui": models},
    "models": {"<model>": total},
    "modelOutputs": {"<model>": output},
    "modelUnclassifiedTokens": {"<model>": input},
    "modelCosts": {}, "clientCosts": {}, "clientModelCosts": {},
    "clientOutputs": {...}, "clientUnclassifiedTokens": {...}
  }
}
```

- 时区边界用 `zoneinfo.ZoneInfo` 按 `TIME_ZONE`（默认 Asia/Tokyo）计算，
  月末/年末/夏令时切换均已测试。
- 启动时 `GET /api/health` 校验 `ok`/`role` 并记录 hubBuild。
- 408/425/429、5xx 与网络错误按退避间隔重试，并读取 `Retry-After`；
  其他确定性 4xx 进入更长间隔重试，不会永久停用桥接。
- `TOKEN_MONITOR_DEVICE_ID` 若与 Cloud 设备 ID 相同则拒绝启动桥接。

## 安全

- 启动校验：`API_KEY` 非空、非弱默认值（changeme 等）、长度 ≥12；
  `ACCESS_TOKEN` 必须与 `API_KEY` 分离（共用需显式 `ALLOW_SHARED_TOKEN=true`）。
- `DEVICE_KEYS_JSON` 支持每设备写密钥，服务端校验密钥与 device.id 绑定。
- 公网 `CLOUD_HUB_URL` / `TOKEN_MONITOR_HUB_URL` 强制 HTTPS（本机地址或
  显式 `ALLOW_INSECURE_HTTP=true` 除外）。
- CORS 默认关闭（`CORS_ORIGINS` 配置才启用）；`/docs` `/redoc`
  `/openapi.json` 默认关闭（`DOCS_ENABLED=true` 开启）。
- 请求体大小限制（默认 2MB）；输入经 Pydantic 严格校验（长度上限、
  整数不带 bool、token 非负且有上限防溢出 SQLite 64 位、created_at
  非法/超前 48h 拒绝、start_time>end_time 返回 400）。
- Docker：非 root 用户、`cap_drop: ALL`、`no-new-privileges`、只读根文件
  系统 + tmpfs、hub 默认只绑 `127.0.0.1:7878`（公网经 HTTPS 反代）。

# 附：token-monitor 云端接入层（tm_hub）

## 定位反转说明

用户的核心诉求：**本机 token-monitor 的数据在云端网页随处可查**。因此主路径
不是"把数据推给 token-monitor 的 hub"，而是反过来——**Cloud-monitor hub
实现 token-monitor 的服务端协议**，本机 widget 原生同步直连云端：

```
token-monitor widget ──(设置 hub=云端地址 + TOKEN_MONITOR_SECRET)──►
    POST /api/ingest ──► tm_devices(最新全量 payload) + tm_snapshots(轻量历史)
    GET  /api/health /api/stats /api/devices[/:id]  ← 官方协议兼容
    GET  /api/v1/tm/overview ← 网格面板专用（ACCESS_TOKEN）
    网页 /tm/ ← tm-frontend（v2 形态；现已被 / 用量面板取代，/tm/ 301 跳转）
```

## 与官方 hub 的兼容策略

- 健康检查**不含 hubBuild**：按官方文档，无 hubBuild 的响应被视为 legacy
  Hub 并"remains otherwise compatible"，这是最稳妥的兼容姿态。
- 鉴权同时接受 `Authorization: Bearer <secret>` 与
  `X-Token-Monitor-Secret: <secret>`（与官方一致）。
- payload 宽容解析：周期对象接受顶层或 `periods{}` 内嵌两种形态；token
  拆分（cacheRead/cacheWrite/output/unclassified）、clients、clientModels
  全部保留；未识别字段存进 `payload` JSON 原文，不丢失。
- **不支持 SSE 广播**：官方 hub 向 widget 实时推送 stats；本层定位是持久
  化与远程网页查看，widget 自身显示仍依赖本地数据。若需要 widget 间实时
  同步，官方的 widget-hosted hub / Node hub / Worker 仍可并行使用。

## 数据模型与保留策略

```sql
tm_devices(device_id PK, 主机/OS/agent 元信息, first/last_seen_at,
           payload TEXT /* 最新完整摘要 JSON */)
tm_snapshots(id, device_id, received_at, day,
             today 的 total/output/cache_read/cache_write/unclassified/cost,
             month_total, month_cost, all_time_total, all_time_cost,
             models_json /* 今日模型分布 */)
```

每次 ingest 追加一条轻量快照并清理：近 7 天全分辨率（5 分钟级），更早每
(设备, 天) 只保留最后一个，硬上限 370 天。面板趋势 = 每天最后一个快照的
today_total 汇总（近似当日用量）。

---

# 附二：官方协议权威架构（v3，替代前文"tm_hub 兼容层"描述）

> 前文「token-monitor 云端接入层（tm_hub）」一节描述的手写近似实现已被
> 整体替换；本文以 vendored 官方实现为准。前文的《桥接 v2》仍适用于
> agent 侧可选反向桥接（OpenWebUI 摘要 → 外部 token-monitor hub）。

## 分工（方案 A：官方代码为唯一协议权威）

```
widget/agent ──官方同步协议──► Python 网关（鉴权/严格校验/1MiB 实测限流）
                                   │ 转发
                                   ▼
                          tm-core（官方 v0.62.0 @dcccfb0，逐字节未改）
                            规范化 / 设备合并(含 limitsOnly) / 多设备聚合 /
                            periodWindows 过期 / syncUploadIntervalMs stale /
                            history / limits / SSE 广播 / subscriptions /
                            devices.json 原子持久化
                                   ▲
                          Python 网关 ingest 成功后读回合并记录
                                   │
                          SQLite tm_snapshot_buckets（5 分钟桶 × 设备本地日）
                                   │
                          /api/v1/tm/overview + / 用量面板
                          （趋势按模型堆叠/活动热力图/会话/项目/配额/订阅）
```

差分测试（tests/test_tm_differential.py）对同一载荷序列（widget 风格、
headless agent 风格、官方 mergeDeviceRecord 生成的载荷、partial、
limits-only、trackedClients 变化、窗口过期、删除）断言：经 Cloud 全链路
与直连官方 hub 的 stats/devices/history/ingest 响应核心字段等价。

另有固定版本测试 `tests/test_tm_v062_core.py` 和独立提交的 v0.62 载荷/旧存储样例，不通过当前内核生成预期。
完整依赖与来源哈希由 `tm-core/upstream-v062.json` 固定，`tm-core/sync_vendor.py --check` 校验；生成清单不能替代版本契约检查。

## 关键语义（全部由官方代码执行，网关不重造）

- **过期**：`isPeriodExpired` —— periodWindows.{today,month}.endsAt 到期即
  不参与聚合；无窗口时按记录 UTC 日/月兜底；allTime 永不过期。stale 按
  `staleAfterMsForSyncUpload(syncUploadIntervalMs)` 每设备独立判定。
- **合并**：`mergeDeviceRecord` —— limitsOnly:true 继承 periods/窗口等；
  省略 limits/history 时保留旧值；trackedClients 收缩时保留未跟踪客户端
  用量；partial 更新不带 month/allTime 时按官方语义归零（组件与总量矛盾
  时以组件归一）。
- **订阅**：条目必须含 provider+startDate（topup 需 topUps）；过期
  baseUpdatedAt → 409 stale_write；非法币种 → 400。
- **SSE**：首帧 `event: snapshot`；请求头 `X-Token-Monitor-Stream: 2` 可启用
  仅更新设备新鲜度的 `event: freshness`。旧客户端保持完整 `event: stats`。
  核心合并短时间内的上传广播；删除和订阅变更仍发布完整统计，30s `: hb` 心跳。
  网关只转发已支持的版本 2，字节级透传、不压缩，设置 `x-accel-buffering: no`。
- **精简回执**：外部 `X-Token-Monitor-Response: minimal` 不传给内部核心。
  转发队列收到完整 `stats.devices`、持久保存本请求的规范化记录后，外层才将
  成功回应裁为 `ok/deviceId`。错误及 Retry-After 保持原状；本地快照写入失败
  仍由已确认记录重放。`tests/test_tm_v062_gateway.py` 验证这一顺序。
- **压缩**：普通响应通过 Starlette 标准压缩器处理（1 KiB、level 1），协商前
  合并重复 Accept-Encoding 头并尊重 q=0；事件流排除在外。跨域允许的新协商头
  仍仅限配置的来源。

## 快照分桶（网关自有，官方无此数据）

`UNIQUE(device_id, local_day, bucket_start)`，桶起点 = 生产者时间
（payload.updatedAt）floor 5 分钟，同桶 UPSERT 保留最后。local_day 回退链：
today.key → timeZone+updatedAt 本地日 → endsAt 反推 → UTC（tz 留空标注）。
保留：近 7 天全量、更早每日一锚点、370 天硬删；阈值触发清理（≥10 分钟）。
v1 tm_devices/tm_snapshots 迁移：快照搬入桶表，设备 payload 启动时回灌
官方 hub，旧表原样保留不删。

## 待发送与快照补写的恢复边界

网关将两个阶段分开持久化：完整载荷尚未获得核心确认时，由
`tm_forwarding` 负责转发；确认结果保存后，完整载荷释放，`tm_outbox`
只负责本地快照补写。原始输入本身不能证明上游接受，不能用它直接伪造历史。

- 同一设备按持久 `ingest_sequence` 顺序发送。前台、后台、设备删除和旧表
  回灌共用设备占用状态；较早请求未确认时，后来请求不能越过它。
  无法立即发送的请求返回 503，并给出重试间隔；只有已确认请求返回成功。
  旧表回灌不会覆盖核心中已存在的设备。设备删除会留下旧表迁移的删除标记，
  防止未完成的迁移再次恢复该设备；已确认的快照补写也会在写事务内重查
  请求状态，删除先完成时不再使用提前取出的旧任务。
- 408/425/429、5xx 和网络错误可重试。默认退避为 5、10、20、40、80、160、
  300 秒，并遵守更长的 `Retry-After`。每条最多尝试 8 次或等待 1 小时，
  以先到者为准；超过保留期的重试要求会导致终结，不会提前重试。
- 活动任务默认上限 1000 条，完整转发载荷的 UTF-8 总量上限 16 MiB；
  入队与容量预占在同一事务中完成。`snapshot_backpressure` 表示没有暂存
  这次请求，客户端仍须稍后重试。设备占用集合可回收并有固定上限，
  不让每个等待请求都占住同步线程。
- 完整输入摘要用于有界幂等。有显式 `updatedAt` 的同一输入在记录保留期内
  复用原请求，确认过的输入只读取当前统计用于响应，不重新发送或重写旧历史。
  没有时间戳的输入只合并同接收本地日仍活动的相同请求；完成后新的心跳
  会产生新的采样时间和序号。这不是永久幂等或按生产时间拒绝旧数据的协议。
- 缺省采样时间在入队时冻结，显式设备时间保留。发送时补时间不能突破核心
  的 1 MiB 正文限制；恰好装满且没有时间戳的合法请求仍按原完整正文首发。
  若此类请求没有核心可识别的日期窗口，重试又已跨日，则终结为
  `forward_sample_time_missing_across_day`，明确保留缺口，而不把昨日用量
  送成今日用量。历史分桶和服务器接收时间沿用最初入队的依据。
- 进程中断可能发生在核心已接收、确认尚未保存之间；在途请求有五分钟
  恢复等待，同设备的后来请求仍被它阻挡。确认保存和释放完整载荷在同一
  数据库事务内完成；失败提交会回滚，后续请求不会加入未提交的旧事务。
- 新转发状态只适用于保存了完整载荷的请求。升级旧库的未确认记录没有这份
  依据，五分钟后隔离，不自动重发，也不生成快照。终结后按 `terminal_at`
  再保留两小时，包含原因和载荷摘要；旧终结行迁移时也获得完整保留窗口。
  网页对等待确认、等待快照及已终结缺口分别提示，不能只靠就绪检查表达历史缺口。

离线超过上述次数、时间或容量边界不承诺无损。规范化、组件合并及当前统计
仍由固定版本的官方核心负责；快照只使用本次请求确认的记录，额度更新不额外
生成用量快照。完整待发送载荷可能含官方身份或订阅字段，应像原数据库一样
保护存储和备份；网页不会原样展示内部失败文本。
