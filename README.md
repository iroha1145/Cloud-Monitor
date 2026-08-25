# Cloud Monitor — token-monitor 的云端用量面板

**在线演示（假数据，无需安装）：** https://iroha1145.github.io/Cloud-Monitor/

把**本机 [token-monitor](https://github.com/Javis603/token-monitor) 的数据搬到云端**：
官方 hub 实现被原样 vendored（固定提交 b925865，逐字节未改）作为**协议权威**运行在
tm-core 容器中，本机 widget 在设置里把 hub 指向你的服务器即可原生直连；Python
网关在其前侧做鉴权隔离、严格载荷校验、1MiB 实测限流，并把数据沉淀为 SQLite
长期时间序列，配合 `/` 网页面板随处查看（今日/本月/累计、按模型/客户端、
缓存拆分、多设备、近 30 天按模型堆叠趋势、日/周/月活动热力图，以及
工具×模型矩阵、项目、配额、订阅、会话明细面板；旧 `/tm/` 301 跳转）。

同时保留另一条链路：本机 [OpenWebUI-Monitor](https://github.com/iroha1145/OpenWebUI-Monitor)
的详细调用记录同步（纯 API 链路，无独立页面）。两条链路密钥完全隔离。

```
┌───────────── 本机 ─────────────┐      ┌────────── 云端服务器（docker compose）──────────┐
│ token-monitor widget           │ 原生  │ ┌────────────────────────────────────────┐   │
│  设置 hub=服务器 密钥=SECRET    │──────►│ │ tm-core（vendored 官方 hub, 未修改）     │   │
│  widget 同步间隔 实时/10/20/30分 │ 协议  │ │  规范化/合并/聚合/过期/SSE/订阅          │   │
│  headless agent 默认 5 分钟     │      │ │  devices.json 持久化（官方原生行为）     │   │
└────────────────────────────────┘      │ └──────────────△─────────────────────────┘   │
                                        │ Python 网关: 鉴权隔离+严格校验+1MiB 限流      │
                                        │ SQLite 5 分钟桶历史(设备本地日) / 用量面板    │
                                        │ OpenWebUI 记录链路(另一套密钥, 纯 API)        │
                                        └──────────────────────────────────────────────┘
```

## 协议支持矩阵

| 官方端点 | 状态 | 处理方 |
|---|---|---|
| `GET /api/health` | ✅ 官方形状原样（含 hubBuild） | 透传 tm-core；上游不可达时 503 明确失败 |
| `POST /api/ingest` | ✅ 官方形状（ok/deviceId/stats） | 前置严格校验 → 透传 → 快照联动 |
| `GET /api/stats` | ✅ | 透传（聚合/过期/stale 全部官方语义） |
| `GET /api/stats/stream` | ✅ SSE（snapshot 首帧/ingest·delete·subscriptions 广播/30s 心跳 `: hb`） | 字节级透传 |
| `GET /api/devices` | ✅ `{devices:[...]}` | 透传 |
| `DELETE /api/devices/:id` | ✅ `{ok,deviceId}` | 透传 + 清理 SQLite 快照 |
| `GET /api/history` | ✅ | 透传 |
| `GET /api/v1/tm/overview` | ✅ Cloud 扩展 | ACCESS_TOKEN；官方 stats + SQLite 时间序列 |
| `GET /api/v1/tm/subscriptions` | ✅ Cloud 扩展 | ACCESS_TOKEN |
| `GET /api/v1/tm/provider-status` | ✅ Cloud 扩展 | ACCESS_TOKEN；allowlist 并发状态页 |
| `GET /api/v1/tm/history/daily` | ✅ Cloud 扩展 | ACCESS_TOKEN；370 天本地日 SQL 分页 |
| `GET/PUT /api/subscriptions` | ✅（含 stale_write 409 / 非法币种 400） | 透传 |
| `OPTIONS`（官方 204） | ⚠️ 未特殊处理 | 如有需要可加 |
| Worker 专属 `/api/public/*` | ❌ 不适用 | 官方 Node hub 亦无此端点 |

## 与官方 hub 的差异（如实列出）

- **协议行为本身无差异**：tm-core 是官方代码逐字节副本（规范化、设备合并含
  limitsOnly 语义、聚合、periodWindows 过期、按 syncUploadIntervalMs 的
  stale 判定、SSE、订阅、devices.json 持久化）。差分测试对同一载荷序列
  断言两者输出等价。
- **网关增加的防护**：`TOKEN_MONITOR_SECRET` 与 OpenWebUI 链路密钥完全隔离
  （TM 密钥碰不到记录写入/读取，反之亦然）；转发前严格校验（负数/bool/
  NaN/Infinity/超 64 位/非法 IANA 时区/原型污染键/数量超限/过度未来时间
  一律 400，官方仅限 1MiB 体积）；ASGI receive 层 1MiB 实测限流（分块、
  无/伪造 Content-Length 均按实际字节判定）。
- **网关增加的能力**：SQLite 5 分钟桶长期时间序列（官方 devices.json 只保留
  每设备最新状态，不含历史点）；`/api/v1/tm/overview` 面板接口、
  `/api/v1/tm/subscriptions` 只读订阅、`/api/v1/tm/provider-status`
  （官方状态页 allowlist）、`/api/v1/tm/history/daily`（370 天设备本地日
  分页）（ACCESS_TOKEN）；v1 旧表自动迁移。
- **部署形态**：官方 hub 单进程；本方案为 compose 内 python + node 两容器。

## 本轮加固（v4：可靠性/口径/供应链）

- **快照可靠性（事务发件箱）**：ingest 先记 pending outbox → 转发 → 从本次
  响应的 stats.devices 取规范化记录写快照并标记 done（同请求闭环，不再
  额外 GET /api/devices）。快照失败不静默丢失：outbox 留待后台/启动重放
  （幂等，不重复建桶），`/api/v1/health`、ready、overview 暴露
  pending_outbox / snapshot_degraded / last_snapshot_error；pending 超上限
  （默认 1000）返回 503 背压。
- **健康检查**：`/api/v1/health/live`（存活）、`/api/v1/health/ready`
  （SQLite 读写 + tm-core + 快照状态；任一组件失败 503）。Docker
  HEALTHCHECK 改用 ready；compose 为 `depends_on: service_healthy`。
  tm-core 不可达时代理接口统一 503（不散落 500），延迟启动由后台线程
  自动重试初始化与旧数据回填。
- **活动时间口径**：`DASHBOARD_TIME_ZONE`（默认 Asia/Tokyo）。hourly 只收
  换算后日期等于仪表盘今日的桶；coverage 按设备求和后钳制 0–100%；
  `attribution_mode` 为 none/delta/delta-low-coverage/delta-with-reset
  （本地日开始处的自然首桶不是自动 low-coverage）。activity.daily 近 7 天
  用 5 分钟桶、更早用日锚点，与 `/api/v1/tm/history/daily` 共用查询核心
  （写入 docs/TM_OVERVIEW_CONTRACT.md）。快照压缩按时间 `ROW_NUMBER`，
  截止时间为毫秒 UTC `Z`。
- **会话主键**：`deviceId:client:sessionId`，跨设备同 client:sessionId
  不再互相删除；返回 sessions_meta（total/returned/omitted_count/
  session_details_incomplete）。
- **供应链**：`hub/scripts/backup.sh` / `restore.sh`（两卷一致性备份恢复，
  含时间点校验）；vendor SHA-256 manifest（CI 逐文件校验）；
  `requirements-lock.txt` 哈希锁定；基础镜像固定补丁版本；统一安全
  响应头（CSP/nosniff/no-referrer/frame-ancestors）。

## 数据保留 / 时区语义 / 隐私 / 备份

- **保留**：SQLite 快照近 7 天 5 分钟级（按设备本地日 5 分钟桶 UPSERT，
  同桶保留最后值），之后每日每设备保留一个锚点，370 天硬删除；清理按
  阈值触发（≥10 分钟一次），不逐 ingest 全表扫描。limits-only 更新不产生
  token 历史点。devices.json 由官方代码原子写，保留每设备最新完整状态。
- **时区**：快照日归属按设备 `periodWindows`（today.key → timeZone+updatedAt
  → endsAt 反推 → UTC 回退并留空标注）；非法时区在网关 400 拒绝。
- **隐私**：devices.json 可能含 limits 的账户邮箱/计划名与订阅金额（官方
  字段，位于 TM 密钥保护之后）；SQLite 快照只存 token/成本聚合与客户端/
  模型名，不含账户身份。面板经 ACCESS_TOKEN 访问。
- **备份**：备份 `tm-core-data` 卷（devices.json）与 `cloud-hub-data` 卷
  （cloud-monitor.sqlite3）即可完整恢复。

## 快速开始（token-monitor 上云）

**服务器（推荐安装脚本）**：

```bash
curl -fsSL https://raw.githubusercontent.com/iroha1145/Cloud-Monitor/main/install.sh | sudo bash -s -- --mode demo
```

管道执行时 stdin 不是终端，必须用 `--mode demo` / `--mode live` 显式指定（否则脚本会以“非交互环境”拒绝）。之后再跑一次同一脚本换 `--mode live`（或在服务器上交互运行），即可关掉演示、改用 `ACCESS_TOKEN` 登录。

已克隆仓库时：

```bash
sudo ./install.sh            # 交互选择
sudo ./install.sh --mode demo
sudo ./install.sh --mode live
```

也可手动：

```bash
git clone https://github.com/iroha1145/Cloud-Monitor.git
cd Cloud-Monitor/hub
cp .env.example .env
# 必填三个互不相同、各≥32 随机字符的密钥：
#   API_KEY / ACCESS_TOKEN（OpenWebUI 链路） + TOKEN_MONITOR_SECRET（TM 链路）
# 演示预览把 CM_DEMO=true，实机保持 false
docker compose up -d --build
curl http://127.0.0.1:7878/api/health   # {"ok":true,"role":"hub",...}
```

公网访问在前面挂 HTTPS 反代；**SSE 路径必须关闭代理缓冲**（nginx 示例）：

```nginx
location /api/stats/stream {
    proxy_pass http://127.0.0.1:7878;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 24h;
}
# 其余路径常规反代；如需纵深防御可另加 client_max_body_size 1m;
```

**本机 token-monitor**：设置 → 多设备同步 → hub 填 `https://<服务器>`，
密钥填 `TOKEN_MONITOR_SECRET`。widget 按其同步间隔（实时/10/20/30 分钟，
headless agent 默认 5 分钟）推送，无需本机任何额外组件。

**随处查看**：`https://<服务器>/`，输入 `ACCESS_TOKEN`（旧 `/tm/` 已 301 跳转）。

## OpenWebUI-Monitor 记录同步（第二条链路）


```bash
cd Cloud-monitor/agent && cp .env.example .env
#   LOCAL_MONITOR_URL / LOCAL_API_KEY   本地 monitor 地址与只读密钥
#   CLOUD_HUB_URL / CLOUD_API_KEY       云端地址（公网必须 HTTPS）与写入密钥
docker compose up -d --build
```

本地 monitor 需要 `/api/v1/sync/meta|records` 游标接口（本地仓库已含提交
19134c7，或应用 `docs/patches/openwebui-monitor-sync-api.patch`）；旧版自动
回退时间窗口模式。agent 端还有一个**可选**的反向桥接（把 OpenWebUI 用量
摘要以 `openwebui:<device>` 身份推给任意 token-monitor hub），详见
ARCHITECTURE——token-monitor 走上面主路径时不需要它。

## 环境变量速查（hub）

| 变量 | 说明 | 默认 |
|---|---|---|
| `API_KEY` | 记录写入密钥（弱值拒绝启动） | — |
| `ACCESS_TOKEN` | 只读密钥（面板/查询用，须与 API_KEY 不同） | — |
| `TOKEN_MONITOR_SECRET` | token-monitor 接入密钥（空=停用该接入） | 空 |
| `CM_DEMO` | `true` 时 `/` 直接进演示面板（假数据） | `false` |
| `DEVICE_KEYS_JSON` | 每设备写密钥（记录链路） | 空 |
| `CORS_ORIGINS` / `DOCS_ENABLED` | 默认均关闭 | 关 |
| `MAX_RECORDS_PER_PUSH` | 记录单批上限 | `500` |
| `DASHBOARD_TIME_ZONE` | 面板活动统计时区 | `Asia/Tokyo` |
| `PROVIDER_STATUS_ENABLED` | Cloud 扩展：官方状态页 | `true` |
| `PROVIDER_STATUS_CACHE_SECONDS` | 状态页缓存 TTL（SWR） | `300` |
| `PROVIDER_STATUS_TIMEOUT_SECONDS` | 单页超时（总预算 3s） | `2.5` |

agent（OpenWebUI 链路）的环境变量见 `agent/.env.example`。

## 测试

Python ≥ 3.9 即可（macOS 系统自带的 3.9 也行；Docker 镜像与 CI 用 3.12）。
两套测试目录的 conftest 模块名相同，需分开跑、不能合并为一条 pytest 命令：

```bash
cd hub   && PYTHONPATH=backend python -m pytest tests/ -q
cd agent && python -m pytest tests/ -q
```

hub 测试覆盖 provider-status（Mock 网络）、history/daily SQL 分页、
100×370 查询计划、activity 覆盖率、乱序快照压缩与前端契约 fixture 导出。

