# Cloud Monitor — 云端 Token 消耗看板（v2）

把本机 [OpenWebUI-Monitor](https://github.com/iroha1145/OpenWebUI-Monitor) 的数据
可靠地同步到云端服务器，由服务器统一存储并以网页展示详细 Token 消耗。
前端复用 OpenWebUI-Monitor 的现有页面（未做任何改动），只动后端。

v2 相对 v1 的核心改进：**并发安全的 SQLite 事务**、**稳定的设备/数据源身份**
（容器重建/本地库重建都不再产生重复或丢数据）、**id 游标增量同步**
（每批确认后才推进游标）、**云端响应严格校验**、**token-monitor 桥接协议
按官方字段重写**、**默认安全**（HTTPS 强制、密钥分离、非 root 容器、
默认关闭 CORS/docs）。细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

```
┌──────────── 本机 ────────────┐          ┌─────────── 云端服务器 ───────────┐
│ OpenWebUI → openwebui-monitor │  游标增量  │  Cloud-monitor hub (Docker)     │
│               (本地, 后端新增  │ ────────► │   POST /api/v1/sync/push 幂等   │
│                /sync/* 接口)  │  心跳+校验 │   冲突检测 / 事务 / WAL          │
│  sync-agent v2 (Docker)       │          │   网页 / = 现有前端, 只读 API     │
│   可选: → token-monitor hub   │          │   SQL 分页 + SQL 聚合            │
└───────────────────────────────┘          └─────────────────────────────────┘
```

## 目录结构

```
Cloud-monitor/
├── hub/        云端后端（FastAPI + SQLite，部署在服务器）
│   ├── backend/hub/      config / auth / db / models / services / main
│   ├── frontend/         从 openwebui-monitor 原样复制（零改动）
│   ├── tests/            29 项 pytest（并发/回滚/迁移/鉴权/10万条分页聚合…）
│   └── Dockerfile / docker-compose.yml（非 root、只读、健康检查）
├── agent/      本机同步代理 v2
│   ├── sync_agent.py         游标增量同步 + 心跳 + 响应校验 + 退避降级
│   ├── token_monitor_bridge.py 可选：标准字段推送到 token-monitor hub
│   ├── healthcheck.py        Docker 健康检查
│   ├── tests/                28 项 pytest（身份/状态损坏/时区/设备隔离…）
│   └── Dockerfile / docker-compose.yml
└── docs/
    ├── ARCHITECTURE.md     v2 协议与数据模型
    └── patches/openwebui-monitor-sync-api.patch  本地 monitor 的新接口补丁
```

## 一、云端服务器部署（hub）

```bash
git clone https://github.com/iroha1145/Cloud-Monitor.git
cd Cloud-Monitor/hub
cp .env.example .env
# 必填：API_KEY（写入密钥，openssl rand -hex 32）与 ACCESS_TOKEN（只读密钥，
# 必须与 API_KEY 不同）。弱值/默认值/过短值会拒绝启动。
docker compose up -d --build
curl http://127.0.0.1:7878/api/v1/health
```

- 默认只绑定 `127.0.0.1:7878`，公网访问请经 Nginx/Caddy HTTPS 反代。
- 数据持久化在 `cloud-hub-data` 卷（`/data/cloud-monitor.sqlite3`）。
- 旧 v1 数据库首次打开时自动迁移（见 ARCHITECTURE），不清空数据。

## 二、本机部署（agent）

```bash
cd Cloud-monitor/agent
cp .env.example .env
#   LOCAL_MONITOR_URL / LOCAL_API_KEY   本地 monitor 地址与只读密钥
#   CLOUD_HUB_URL / CLOUD_API_KEY       云端地址（公网必须 HTTPS）与写入密钥
#   DEVICE_ID / DEVICE_NAME / HOST_PLATFORM  建议显式配置
docker compose up -d --build
docker compose logs -f sync-agent
```

不用 Docker 也可裸跑（`LOCAL_MONITOR_URL=http://127.0.0.1:7878`）。

**本地 monitor 需要新接口**（`/api/v1/sync/meta`、`/api/v1/sync/records`）：
- 本地仓库已含该补丁（提交 19134c7）；
- 若部署的是旧版，应用 `docs/patches/openwebui-monitor-sync-api.patch`；
- 无法升级时 agent 自动回退时间窗口模式（打印一次性能警告，功能不受影响）。

## 三、可选：对接 token-monitor 多设备同步

```env
TOKEN_MONITOR_HUB_URL=https://<token-monitor-hub>
TOKEN_MONITOR_SECRET=<共享密钥>
TOKEN_MONITOR_DEVICE_ID=        # 默认 openwebui:<DEVICE_ID>，与 Cloud 身份隔离
TIME_ZONE=Asia/Tokyo            # today/month 边界时区
```

payload 使用 token-monitor 的标准周期字段（models/clientModels/
outputTokens/unclassifiedTokens 等，`capabilities.tokenComponents=false`，
costUsd 恒为 0——OpenWebUI-Monitor 不计费）。上游 4xx 时桥接自动停用，
5xx 下个周期重试，均不影响主同步。

## 环境变量速查

### hub（服务器）

| 变量 | 说明 | 默认 |
|---|---|---|
| `API_KEY` | 写入密钥（必填，弱值拒绝启动） | — |
| `ACCESS_TOKEN` | 只读密钥（必填，须与 API_KEY 不同） | — |
| `ALLOW_SHARED_TOKEN` | 显式允许两密钥共用 | `false` |
| `DEVICE_KEYS_JSON` | 每设备写密钥，绑定 device.id | 空 |
| `CORS_ORIGINS` | 允许跨域来源，默认不启用 CORS | 空 |
| `DOCS_ENABLED` | 开放 /docs /redoc /openapi.json | `false` |
| `MAX_RECORDS_PER_PUSH` | 单次 push 上限（≤500） | `500` |

### agent（本机）

| 变量 | 说明 | 默认 |
|---|---|---|
| `CLOUD_HUB_URL` | 云端地址（必填，公网强制 HTTPS） | — |
| `CLOUD_API_KEY` | 云端写入密钥 | — |
| `DEVICE_ID` / `DEVICE_NAME` / `HOST_PLATFORM` | 设备身份（建议显式配置） | 状态卷 UUID / 空 |
| `SOURCE_INSTANCE_ID` | 数据源实例（一般自动获取） | 自动 |
| `SYNC_INTERVAL_SECONDS` / `BATCH_SIZE` | 间隔与批量（≤500） | `60` / `200` |
| `ALLOW_INSECURE_HTTP` | 显式放行明文 HTTP（仅限特殊场景） | `false` |
| `HEALTH_STALE_SECONDS` | 健康检查阈值 | `3600` |

## 云端 API

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/v1/sync/push` | `API_KEY` 或设备密钥 | 幂等推送，返回 inserted/duplicates/conflicts |
| GET | `/api/v1/usage` | `ACCESS_TOKEN` | SQL 聚合（by_user/by_model/by_device） |
| GET | `/api/v1/users` | `ACCESS_TOKEN` | 用户列表（含 created_at 保真） |
| GET | `/api/v1/records` | `ACCESS_TOKEN` | SQL 分页明细，支持 device_id 过滤 |
| GET | `/api/v1/devices` | `ACCESS_TOKEN` | 设备与同步健康状态 |
| GET | `/api/v1/health` | 无 | 健康检查（含 protocol_version） |
| GET | `/` | 无 | 网页看板（现有前端） |

## 测试

```bash
cd hub   && PYTHONPATH=backend python -m pytest tests/ -q   # 29 项
cd agent && python -m pytest tests/ -q                       # 28 项
```

已通过的整体验证：三套 pytest 共 89 项；32 线程×200 批×100 条并发压测
零异常恰好 20000 条；10 万条记录 SQL 分页/聚合与 Python 基准一致；
真实数据端到端（全量 1628 → 幂等心跳 → 增量 1 条 → 本地库重建后
source 轮换、local_id=1 重新入库不被吞）。
