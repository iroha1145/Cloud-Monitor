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
- 上游 4xx → 桥接永久停用；5xx/网络错误 → 记录日志下个周期重试。
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
