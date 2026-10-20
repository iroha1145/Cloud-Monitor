# Cloud Monitor 架构说明

Token Monitor 本机组件使用原生同步协议连接云端；Python 网关提供鉴权、持久化和面板接口，官方核心处理协议。

## 数据流与分工

```
Token Monitor widget/headless agent ──官方同步协议──► Python 网关（鉴权/严格校验/1MiB 实测限流）
                                   │ 转发
                                   ▼
                          tm-core（官方 v0.74.0 @cbed591，逐字节未改）
                            规范化 / 设备合并(含 limitsOnly) / 多设备聚合 /
                            periodWindows 过期 / syncUploadIntervalMs stale /
                            history / limits / SSE 广播 / subscriptions /
                            sync/content（设置与可选会话标题同步）/
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

固定版本测试 `tests/test_tm_v070_core.py` 校验当前固定版本（v0.74.0）与内核构建号，并验证 v0.70 引入的 CatPaw（`catpaw`）/ FX（`fx`）/ MiniMax Code（`mcode`）/ Factory Droid 客户端、会话实时状态（`waitingForInput`、`liveActivity`、`promptCache`、流式输出速率与父子会话关联）、内容同步端点（`/api/sync/*`）及上报合并；`tests/test_tm_v064_core.py` 与 `tests/test_tm_v062_core.py` 继续验证旧客户端载荷。样例与预期独立提交，不通过当前内核生成预期。
完整依赖与来源哈希由 `tm-core/upstream-v074.json` 固定，`tm-core/sync_vendor.py --check` 校验；生成清单不能替代版本契约检查。Git 保留 vendor 原始字节，跨平台检出不能改变来源哈希。

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

## 配置与部署

- `ACCESS_TOKEN` 是面板登录密钥；`TOKEN_MONITOR_SECRET` 是 Token Monitor 同步密钥，留空时停用主实例同步。配置的密钥均至少 32 字符、不得为弱默认值，各用途和各租户之间不得复用。
- `TENANTS_JSON` 为每人配置独立同步密钥和访问密钥；网关与官方核心分别使用 `tenants/<用户>/` 下的数据库和设备文件。服务共用两个容器。
- 跨域默认关闭；`CORS_ORIGINS` 指定来源后启用。接口文档默认关闭，由 `DOCS_ENABLED` 控制。
- 容器使用普通用户、只读根目录、临时文件系统和受限能力。网关默认只绑定 `127.0.0.1:7878`，公网经安全超文本传输协议（HTTPS）反向代理；事件流需关闭代理缓冲。
- `install.sh` 仅为新安装生成两把密钥，重复执行保留已有密钥与租户配置；同步密钥已有空值也保留。在线更新保留 `.env` 和两个数据卷。
- 新数据库只创建 Token Monitor 使用的表。已有数据库中的历史表原样保留，不主动删除；设备删除和历史保留策略仍按各自 Token Monitor 功能执行。
- `hub/scripts/backup.sh` 对两个数据卷及全部已落盘租户执行备份，SQLite 使用一致性快照；`restore.sh` 验证备份后恢复。业务数据备份不含密钥，`.env` 应另外安全保存。

数据库就绪检查共用一秒预算，覆盖进程内互斥锁和 SQLite 写锁等待；超时返回结构化 503。`/api/v1/health/live` 只检查进程响应。SQLite 使用写前日志（WAL），单个 Uvicorn 工作进程管理连接。
