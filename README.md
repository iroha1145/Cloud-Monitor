# Cloud Monitor — 云端 Token 消耗看板

把本机 [OpenWebUI-Monitor](https://github.com/iroha1145/OpenWebUI-Monitor) 的数据
增量上传到云端服务器，由服务器统一存储并以网页展示详细 Token 消耗。
前端复用 OpenWebUI-Monitor 的现有页面（未做任何改动），只新增后端同步链路。

```
┌──────────── 本机 ────────────┐          ┌─────────── 云端服务器 ───────────┐
│ OpenWebUI → openwebui-monitor │  增量推送  │  Cloud-monitor hub (Docker)     │
│               (本地, 不改动)   │ ────────► │   POST /api/v1/sync/push        │
│  sync-agent (Docker)          │  幂等去重  │   SQLite (device_id + local_id) │
│   可选: → token-monitor hub   │          │   网页 / = 现有前端, 只读 API     │
└───────────────────────────────┘          └─────────────────────────────────┘
```

## 目录结构

```
Cloud-monitor/
├── hub/        云端后端（FastAPI + SQLite，Docker 部署在服务器）
│   ├── backend/hub/      config / auth / db / services / main
│   ├── frontend/         从 openwebui-monitor 原样复制，未改动
│   ├── tests/            pytest（8 项：推送/幂等/鉴权/过滤/限额…）
│   ├── Dockerfile
│   └── docker-compose.yml
├── agent/      本机同步代理（Python，Docker 部署在本机）
│   ├── sync_agent.py         增量拉取本地 records/users → 推送云端
│   ├── token_monitor_bridge.py 可选：把用量摘要推到 token-monitor hub
│   ├── Dockerfile
│   └── docker-compose.yml
└── docs/ARCHITECTURE.md   架构与同步协议细节
```

## 一、云端服务器部署（hub）

```bash
# 上传 Cloud-monitor/ 到服务器后：
cd Cloud-monitor/hub
cp .env.example .env
# 编辑 .env，设置强随机 API_KEY（推送与读取共用；ACCESS_TOKEN 可单独作为只读密钥）
docker compose up -d --build

# 验证
curl http://127.0.0.1:7878/api/v1/health          # {"ok":true,"role":"cloud-hub"}
curl -H "Authorization: Bearer <API_KEY>" http://127.0.0.1:7878/api/v1/devices
```

数据持久化在 docker 卷 `cloud-hub-data` 中（`/data/cloud-monitor.sqlite3`）。
建议在前面挂 Nginx/Caddy 做 HTTPS 反代后再暴露公网。

## 二、本机部署（agent）

agent 只读取本地 monitor 的只读接口，不写入本地数据库，可随时启停。

```bash
cd Cloud-monitor/agent
cp .env.example .env
# 编辑 .env:
#   LOCAL_MONITOR_URL=http://host.docker.internal:7878   (Docker 内访问宿主机)
#   LOCAL_API_KEY=<本地 monitor 的 ACCESS_TOKEN 或 API_KEY>
#   CLOUD_HUB_URL=https://your-server.example.com
#   CLOUD_API_KEY=<与 hub 端 API_KEY 相同>
docker compose up -d --build
docker compose logs -f sync-agent
```

不用 Docker 也可裸跑：`pip install -r requirements.txt && python sync_agent.py`
（`LOCAL_MONITOR_URL` 改为 `http://127.0.0.1:7878`）。

首次运行会全量同步历史数据（默认每批 200 条、单批上限 500 条），
之后按 `SYNC_INTERVAL_SECONDS`（默认 60s）增量同步；网络失败自动在下个周期重试，
云端按 `(device_id, local_id)` 唯一索引去重，重复推送不会产生重复数据。

## 三、可选：对接 token-monitor 多设备同步

配置以下环境变量后，agent 会把「今日 / 本月 / 全部」的 OpenWebUI 用量摘要
按 token-monitor 的设备摘要格式推送到它的 hub，与其多设备同步体系对接：

```env
TOKEN_MONITOR_HUB_URL=http://<token-monitor-hub>:17321
TOKEN_MONITOR_SECRET=<共享密钥>
TOKEN_MONITOR_INTERVAL_SECONDS=300
```

payload 遵循其 `POST /api/ingest` wire format（`deviceId` + `today/month/allTime`
的 `totalTokens/costUsd/clients` 结构，附带 `perModel` 明细）。OpenWebUI-Monitor
不计费，因此 `costUsd` 恒为 0。桥接失败只记日志，不影响主同步。

## 环境变量速查

### hub（服务器）

| 变量 | 说明 | 默认 |
|---|---|---|
| `API_KEY` | 推送与读取的共享密钥（必填） | — |
| `ACCESS_TOKEN` | 只读密钥，留空沿用 `API_KEY` | `API_KEY` |
| `MAX_RECORDS_PER_PUSH` | 单次 push 记录上限 | `500` |

### agent（本机）

| 变量 | 说明 | 默认 |
|---|---|---|
| `LOCAL_MONITOR_URL` | 本地 monitor 地址 | `http://host.docker.internal:7878` |
| `LOCAL_API_KEY` | 本地读取密钥 | 空 |
| `CLOUD_HUB_URL` | 云端 hub 地址（必填） | — |
| `CLOUD_API_KEY` | 云端 `API_KEY` | — |
| `DEVICE_ID` / `DEVICE_NAME` | 设备标识（留空按主机名自动生成，多机需不同） | 自动 |
| `SYNC_INTERVAL_SECONDS` | 同步间隔 | `60` |
| `BATCH_SIZE` | 单批推送条数（≤500） | `200` |
| `STATE_PATH` | 水位线状态文件 | `/data/agent-state.json` |

## 云端 API

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/v1/sync/push` | `API_KEY` | 设备推送 `{device, users, records}`，幂等 |
| GET | `/api/v1/usage` | `ACCESS_TOKEN` | 汇总（含 `by_user/by_model/by_device`） |
| GET | `/api/v1/users` | `ACCESS_TOKEN` | 用户列表及 token 合计 |
| GET | `/api/v1/records` | `ACCESS_TOKEN` | 分页明细，支持 `device_id` 等过滤 |
| GET | `/api/v1/devices` | `ACCESS_TOKEN` | 已接入设备与同步状态 |
| GET | `/api/v1/health` | 无 | 健康检查 |
| GET | `/` | 无 | 网页看板（现有前端） |

## 测试

```bash
cd hub && PYTHONPATH=backend python -m pytest tests/ -q
```

本仓库已通过端到端验证：真实数据全量同步 1627 条、幂等重跑 0 新增、
增量新增 1 条正确入库、token-monitor 桥接 payload 结构正确。
