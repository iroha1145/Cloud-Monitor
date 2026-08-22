# Cloud Monitor — token-monitor 的云端用量面板

把**本机 [token-monitor](https://github.com/Javis603/token-monitor) 的数据搬到云端**：
hub 实现了 token-monitor 的服务端同步协议，本机 widget 在设置里把 hub 指向你的
服务器即可，数据持久化进 SQLite，随时随地打开网页查看用量（今日/本月/累计、
按模型/客户端、缓存拆分、多设备、近 30 天趋势）。

同时保留另一条链路：本机 [OpenWebUI-Monitor](https://github.com/iroha1145/OpenWebUI-Monitor)
的详细调用记录也可同步到同一台服务器（`/` 看板，前端原样复用、零改动）。
两条链路共用一套部署与鉴权体系，互不影响。

```
┌───────────── 本机 ─────────────┐          ┌────────── 云端服务器（Docker）──────────┐
│ token-monitor widget           │  原生同步  │  Cloud-monitor hub                     │
│  设置 hub=服务器 密钥=SECRET    │ ────────► │   /api/ingest  ← token-monitor 协议     │
│  （每 5 分钟自动推送，零改造）   │           │   SQLite 持久化 + 快照历史（官方 hub 是  │
│                                │           │   内存态，本层补上留存与网页）           │
│ openwebui-monitor + sync-agent │  游标增量  │   /api/v1/sync/push ← 详细记录同步      │
└────────────────────────────────┘           │   网页: /tm/ = token 用量面板           │
                                             │        /    = OpenWebUI 记录看板        │
                                             └────────────────────────────────────────┘
```

## 快速开始（token-monitor 上云，推荐路径）

**服务器**：

```bash
git clone https://github.com/iroha1145/Cloud-Monitor.git
cd Cloud-Monitor/hub
cp .env.example .env
# 必填：API_KEY / ACCESS_TOKEN（强随机，二者不同）
# 填上：TOKEN_MONITOR_SECRET（自选一个强随机值，下步 widget 要用）
docker compose up -d --build
curl http://127.0.0.1:7878/api/health   # {"ok":true,"role":"hub",...}
```

公网访问请在前面挂 Nginx/Caddy 做 HTTPS 反代（如 `https://tm.example.com`）。

**本机 token-monitor**（widget 或无头 agent 均可）：

1. 打开 token-monitor 设置 → 多设备同步（Multi-device sync）
2. hub 地址填 `https://tm.example.com`
3. 密钥填服务器上配置的 `TOKEN_MONITOR_SECRET`

完成。widget 会按原有节奏（默认 5 分钟）推送设备摘要，云端自动积累历史。

**随处查看**：浏览器打开 `https://tm.example.com/tm/`，输入 `ACCESS_TOKEN`
即可看到今日/本月/累计 token 与成本、缓存读/写拆分、模型与客户端分布、
设备在线状态、近 30 天趋势。

与官方 hub 的差别：官方 Node hub 只在内存保留每台设备最新一份摘要（重启
即失、无网页）；本层持久化 + 快照历史（近 7 天 5 分钟级、之后每日一个，
保留 370 天）+ 网页面板。不支持 SSE 实时广播，widget 自身显示仍走本地数据。

## 目录结构

```
Cloud-monitor/
├── hub/
│   ├── backend/hub/
│   │   ├── tm_hub.py        token-monitor 服务端协议（ingest/health/stats/devices）
│   │   └── …                OpenWebUI 记录同步（config/auth/db/models/services/main）
│   ├── tm-frontend/         /tm/ 用量面板（独立新页面）
│   ├── frontend/            OpenWebUI 记录看板（原样复制，零改动）
│   ├── tests/               42 项 pytest
│   └── Dockerfile / docker-compose.yml
├── agent/                   本机 OpenWebUI 同步代理（token-monitor 路径不需要它）
└── docs/{ARCHITECTURE.md, patches/}
```

## 云端 API 一览

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/ingest` | `TOKEN_MONITOR_SECRET` | token-monitor 设备摘要推送（持久化） |
| GET | `/api/health` | 无 | token-monitor 兼容健康检查 |
| GET | `/api/stats` | `TOKEN_MONITOR_SECRET` | token-monitor 兼容聚合统计 |
| GET/DELETE | `/api/devices[/:id]` | `TOKEN_MONITOR_SECRET` | 设备管理 |
| GET | `/api/v1/tm/overview` | `ACCESS_TOKEN` | 网格面板数据（含趋势） |
| POST | `/api/v1/sync/push` | `API_KEY`/设备密钥 | OpenWebUI 记录幂等推送 |
| GET | `/api/v1/usage\|users\|records\|devices` | `ACCESS_TOKEN` | OpenWebUI 记录查询 |
| GET | `/tm/`、`/` | 页面内输入密钥 | 两个网页看板 |

## 附：OpenWebUI-Monitor 记录同步（第二条链路）

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
| `DEVICE_KEYS_JSON` | 每设备写密钥（记录链路） | 空 |
| `CORS_ORIGINS` / `DOCS_ENABLED` | 默认均关闭 | 关 |
| `MAX_RECORDS_PER_PUSH` | 记录单批上限 | `500` |

agent（OpenWebUI 链路）的环境变量见 `agent/.env.example`。

## 测试

```bash
cd hub   && PYTHONPATH=backend python -m pytest tests/ -q   # 42 项
cd agent && python -m pytest tests/ -q                       # 28 项
```

整体验证：102 项 pytest 全绿；32 线程并发压测零异常；10 万条 SQL 分页/聚合
与基准一致；token-monitor 双设备真实风格 payload（含缓存拆分）端到端入库、
聚合与面板展示正常。

