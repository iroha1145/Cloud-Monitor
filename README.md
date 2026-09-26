# Cloud Monitor

把本机 [token-monitor](https://github.com/Javis603/token-monitor) 的用量接到自己的服务器。widget 在设置里把 hub 指过来，浏览器打开面板就能看今日、本月、累计。

**假数据演示（不用装）：** https://iroha1145.github.io/Cloud-Monitor/

官方 hub 按固定提交 `b925865` 原样放进 tm-core 容器，协议行为跟官方一致。前面是 Python 网关：鉴权、校验、1MiB 实测限流，并把快照写入 SQLite。官方 `devices.json` 只留每台设备最新状态，没有历史点；长期趋势和日归档是我们自己补的。

另有一条 [OpenWebUI-Monitor](https://github.com/iroha1145/OpenWebUI-Monitor) 记录同步（纯 API，没有独立页面）。两条链路密钥分开，互碰不到。

```
┌───────────── 本机 ─────────────┐      ┌────────── 云端（docker compose）──────────┐
│ token-monitor widget           │ 原生  │ ┌────────────────────────────────────┐   │
│  hub = 服务器                  │──────►│ │ tm-core（官方 hub @b925865，未改）  │   │
│  密钥 = TOKEN_MONITOR_SECRET   │ 协议  │ │ 规范化 / 合并 / 聚合 / 过期 / SSE  │   │
│  widget：实时 / 10 / 20 / 30 分 │      │ │ devices.json（官方原生持久化）     │   │
│  headless agent 默认 5 分钟     │      │ └──────────────△─────────────────────┘   │
└────────────────────────────────┘      │ Python 网关：鉴权 + 校验 + 1MiB 限流      │
                                        │ SQLite 5 分钟桶 + 用量面板                │
                                        │ OpenWebUI 记录链路（另一套密钥）          │
                                        └──────────────────────────────────────────┘
```

## 面板里有什么

- 概览：今日 tokens、费用、连接状态、近 30 天趋势
- 模型分布：环形图；悬停看 tokens、占比、该模型费用、缓存率
- 客户端分布：用 token-monitor 的 logo；条内是上报的真实构成；各行轨道等宽
- 工具 × 模型矩阵、最近会话
- 设备、配额与订阅
- 活动热力图（日、周、月，格子保持正方形）
- 提供商状态：只出今日有上报的提供商，数据来自各官方状态页（Anthropic、OpenAI、Cursor、DeepSeek、Kimi）。GLM 没有官方 Statuspage，不出卡
- 日归档：最多 370 天
- 夜间模式
- 检索更新：从 GitHub Releases / origin/main 对比当前版本；实机面板可后台升级

旧路径 `/tm/` 会 301 到 `/`。

## 快速开始

服务器上推荐用安装脚本。管道执行时 stdin 不是终端，必须带 `--mode`，否则脚本会拒绝往下走：

```bash
curl -fsSL https://raw.githubusercontent.com/iroha1145/Cloud-Monitor/main/install.sh | sudo bash -s -- --mode demo
```

再跑一次同一脚本，改 `--mode live`（或在服务器上交互选「实机」），就会关掉演示，改用 `ACCESS_TOKEN` 登录。

已经克隆过仓库：

```bash
sudo ./install.sh            # 交互选择
sudo ./install.sh --mode demo
sudo ./install.sh --mode live
```

也可以手动：

```bash
git clone https://github.com/iroha1145/Cloud-Monitor.git
cd Cloud-Monitor/hub
cp .env.example .env
# 三个互不相同、各不少于 32 个随机字符的密钥：
#   API_KEY / ACCESS_TOKEN（OpenWebUI 链路）
#   TOKEN_MONITOR_SECRET（token-monitor 链路）
# 演示预览设 CM_DEMO=true，实机保持 false
docker compose up -d --build
curl http://127.0.0.1:7878/api/health
```

容器存活检查走 `/api/v1/health/live`。部署是否就绪走 `/api/v1/health/ready`（SQLite、tm-core、快照）。

公网访问请在前面挂 HTTPS 反代。**SSE 必须关掉代理缓冲**（nginx 示例）：

```nginx
location /api/stats/stream {
    proxy_pass http://127.0.0.1:7878;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 24h;
}
```

其余路径按普通反代即可。如果还想限制上传体积，可另加 `client_max_body_size 1m;`。

## 接本机 token-monitor

设置 → 多设备同步：

- hub 填 `https://<服务器>`
- 密钥填 `TOKEN_MONITOR_SECRET`

widget 按自己的同步间隔推送，本机不用再装别的。然后打开 `https://<服务器>/`，用 `ACCESS_TOKEN` 进面板。

## 协议支持

内置服务端固定为 Token Monitor **v0.62.0**（`dcccfb01557e2786888fd5479552f392ac6c0d32`），源码保持上游原样。
本次对齐新增服务商和每日额度、Claude 重置券明细、第三方用量摘要，以及会话上下文和处理状态。
MiMo、Kilo 的旧工具名会统一到新名称，避免旧设备累计量再次加入。网页仍兼容未提供新字段的旧客户端。

| 官方端点 | 状态 | 谁处理 |
|---|---|---|
| `GET /api/health` | 官方形状（含 hubBuild） | 透传 tm-core；上游不可达时 503 |
| `POST /api/ingest` | 默认完整回应；请求头 `X-Token-Monitor-Response: minimal` 可取精简回应 | 内部始终保存完整确认，再向客户端返回 ok / deviceId |
| `GET /api/stats` | 支持 | 透传（聚合 / 过期 / stale 跟官方一致） |
| `GET /api/stats/stream` | SSE（首帧 snapshot、更新广播、30s `: hb`）；请求头 `X-Token-Monitor-Stream: 2` 启用 freshness 事件 | 按字节透传；旧客户端继续收到完整 stats |
| `GET /api/devices` | `{devices:[...]}` | 透传 |
| `DELETE /api/devices/:id` | `{ok,deviceId}` | 透传，并清 SQLite 快照 |
| `GET /api/history` | 支持 | 透传 |
| `GET/PUT /api/subscriptions` | 含 stale_write 409、非法币种 400 | 透传 |
| `GET /api/v1/tm/overview` | Cloud 扩展 | `ACCESS_TOKEN`；官方 stats + SQLite 时间序列 |
| `GET /api/v1/tm/subscriptions` | Cloud 扩展 | `ACCESS_TOKEN` |
| `GET /api/v1/tm/provider-status` | Cloud 扩展 | `ACCESS_TOKEN`；allowlist 并发拉状态页 |
| `GET/POST /api/v1/system/update` | Cloud 扩展 | `ACCESS_TOKEN`；检索 GitHub Releases，POST 把目标 ref 交给宿主机监视器 |
| `OPTIONS`（官方 204） | 未单独处理 | 要用再加 |
| Worker 专属 `/api/public/*` | 不适用 | 官方 Node hub 也没有 |

## 和官方 hub 差在哪

协议本身不另搞一套。tm-core 是官方代码的逐字节副本：规范化、设备合并（含 limitsOnly）、聚合、`periodWindows` 过期、按 `syncUploadIntervalMs` 判 stale、SSE、订阅、`devices.json` 原子写。差分测试对同一载荷序列断言两边输出等价。

固定版本校验可运行 `python3 hub/tm-core/sync_vendor.py --check`；从已下载的同版官方源码恢复使用 `--source <源码目录>`。校验包含固定提交、完整依赖、许可证与文件哈希，不会自动联网追随上游主分支。版本专用样例和回归覆盖旧数据启动、新字段、工具改名及升级后的持久化。

网关多出来的是防护和面板用的数据：

- `TOKEN_MONITOR_SECRET` 与 OpenWebUI 链路密钥隔离（TM 密钥写不了记录，反过来也不行）
- 转发前校验：负数、bool、NaN、Infinity、超 64 位、非法 IANA 时区、原型污染键、数量超限、过度未来时间一律 400。官方只卡 1MiB 体积
- ASGI receive 层按实际字节限 1MiB（分块、没有或伪造 Content-Length 也算）
- SQLite 5 分钟桶时间序列，以及上面的 `/api/v1/tm/*` 接口
- ingest 先保存完整待发送载荷，再按同设备顺序转发，得到本次确认后才按 `stats.devices` 落快照。网络错误、408/425/429/5xx 由后台有界重试，未确认时仍返回失败状态，不冒充成功；`Retry-After` 会保留。快照失败只重放已确认记录，不再向核心重复发送。
- 活动请求默认最多 1000 条，完整待发送载荷最多 16 MiB；并发入队也计入容量。最多尝试 8 次或保留 1 小时，以先到者为准。失败终结后保留原因，并在网页提示历史可能缺口。详细顺序、幂等窗口和时间边界见 [架构说明](docs/ARCHITECTURE.md#待发送与快照补写的恢复边界)。
- 官方是单进程；这里是 compose 里 python + node 两个容器
- 普通响应超过 1 KiB 时按客户端接受的编码压缩；实时事件流保持不压缩、不缓冲。

升级云端需先备份两个数据卷，再通过现有云监控更新流程发布。本机 Token Monitor 升级不会替换云端内核。若曾使用旧名称上传 MiMo 或 Kilo，升级后应核对工具累计量和历史快照；过去已写入的快照不会自动扣减，也不会因本次升级被清空。

## 数据怎么留、时区、隐私、备份

- **保留：** 近 7 天按设备本地日、5 分钟桶 UPSERT（同桶留最后一次）；更早每天每设备一个锚点；370 天硬删。清理按阈值触发（至少间隔 10 分钟），不在每次 ingest 扫全表。只更新 limits 的请求不写 token 历史点
- **时区：** 快照日归属看设备 `periodWindows`（today.key → timeZone+updatedAt → endsAt 反推 → UTC 回退并留空标注）。非法时区网关直接 400。面板活动统计默认 `DASHBOARD_TIME_ZONE=Asia/Tokyo`
- **隐私：** `devices.json` 可能带 limits 里的账户邮箱、计划名、订阅金额（官方字段，在 TM 密钥后面）。SQLite 快照只存 token / 成本聚合和客户端、模型名，不含账户身份。面板用 `ACCESS_TOKEN`
- **备份：** `hub/scripts/backup.sh <目录>` 备份 `tm-core-data`（devices.json）和 `cloud-hub-data`（SQLite）。恢复用 `hub/scripts/restore.sh <备份目录>`。脚本会带上同目录的 compose override，并按实际卷名写入，避免把备份截空或写到另一套卷上

## OpenWebUI-Monitor 记录同步

这是第二条链路，跟上面的 token-monitor 主路径无关。

```bash
cd Cloud-Monitor/agent
cp .env.example .env
# LOCAL_MONITOR_URL / LOCAL_API_KEY   本地 monitor 与只读密钥
# CLOUD_HUB_URL / CLOUD_API_KEY       云端地址（公网必须 HTTPS）与写入密钥
docker compose up -d --build
```

本地 monitor 需要 `/api/v1/sync/meta` 和 `/api/v1/sync/records` 游标接口（本地仓库已含提交 `19134c7`，或打 `docs/patches/openwebui-monitor-sync-api.patch`）。旧版会退回时间窗口模式。agent 还有一个可选的反向桥接，把 OpenWebUI 用量摘要以 `openwebui:<device>` 身份推给任意 token-monitor hub，细节见 `docs/ARCHITECTURE.md`。走上面主路径时不需要它。

## 环境变量（hub）

| 变量 | 说明 | 默认 |
|---|---|---|
| `API_KEY` | 记录写入密钥（弱值拒绝启动） | — |
| `ACCESS_TOKEN` | 只读密钥（面板 / 查询），须与 API_KEY 不同 | — |
| `TOKEN_MONITOR_SECRET` | token-monitor 接入密钥（空 = 停用） | 空 |
| `CM_DEMO` | `true` 时 `/` 直接进演示面板 | `false` |
| `DEVICE_KEYS_JSON` | 每设备写密钥（记录链路） | 空 |
| `CORS_ORIGINS` / `DOCS_ENABLED` | 默认都关 | 关 |
| `MAX_RECORDS_PER_PUSH` | 记录单批上限 | `500` |
| `DASHBOARD_TIME_ZONE` | 面板活动统计时区 | `Asia/Tokyo` |
| `PROVIDER_STATUS_ENABLED` | 官方状态页 | `true` |
| `PROVIDER_STATUS_CACHE_SECONDS` | 状态页缓存 TTL（SWR） | `300` |
| `PROVIDER_STATUS_TIMEOUT_SECONDS` | 单页超时（总预算 3s） | `2.5` |
| `CM_VERSION` / `CM_GIT_SHA` | 面板显示的当前版本（install / 在线更新写入） | `dev` / 空 |
| `CM_GITHUB_REPO` | 检索用的 GitHub `owner/name` | `iroha1145/Cloud-Monitor` |
| `GITHUB_TOKEN` | 可选，提高 GitHub API 限额 | 空 |
| `CM_UPDATE_DIR` | 容器内更新请求目录（需挂载到宿主机） | `/update` |

agent 变量见 `agent/.env.example`。

## 在线更新

面板顶栏「检索更新」会向 GitHub 拉最新 Release 和 `origin/main` 的 tip，和当前 `CM_VERSION` / `CM_GIT_SHA` 比较。真正升级不在容器里做（cloud-hub 只读、没有 git、也没有 docker.sock），而是把目标 ref 写进 `hub/update-control/request.json`，由宿主机上的 `update-watcher.sh` 调用 `self-update.sh`：`git fetch` + 快进 `main` 或检出 tag，再 `docker compose up -d --build`。

安装脚本需用 `sudo` 运行：宿主状态目录为 `root:999 0750`，共享锁和状态文件为
`root:999 0640`，容器只读挂载该目录。提交与取消共用宿主文件锁；宿主已经领取
更新时取消返回 409，取消先取得锁时宿主不会继续执行。取消回执写入可写控制目录，
重启后仍能显示；提交写入失败也在可写目录留下回执，不改宿主状态文件。
旧部署若共享锁缺失或不可读，可保留下一次升级提交入口，但取消
会返回 503 并提示重跑安装脚本；新版宿主脚本也会修复旧锁权限。

用 `install.sh` 安装或再跑一遍即可创建该目录并启动监视器（有 systemd 就用服务，否则 nohup）。只 `docker compose up`、没跑过安装脚本的话，检索仍然可用，点更新会返回 503。演示页（含 GitHub Pages）只走假数据界面，不会改服务器。

## 界面开发

新版面板源代码位于 `hub/dashboard/`，包含手机底部导航、模型纵向指标、缓存明细浮窗、设备与订阅卡片，以及日／周／月活动和每日归档。Docker 构建会自动编译前端；直接运行 Python 后端时，先执行 `cd hub/dashboard && npm ci && npm run build`，才会使用新版界面。未构建的源码环境仍保留原静态页面。

本地开发、演示构建、登录存储和完整测试命令见 [面板开发说明](hub/dashboard/README.md)。GitHub Pages 采用独立演示构建，不读取保存的访问密钥，也不会请求生产数据或更新服务。

## 测试

Python ≥ 3.9 即可（macOS 自带的 3.9 也行；镜像和 CI 用 3.12）。两套测试目录的 conftest 模块名相同，要分开跑，不要合成一条 pytest：

```bash
cd hub   && PYTHONPATH=backend python -m pytest tests/ -q
cd agent && python -m pytest tests/ -q
```

hub 测试覆盖 provider-status（Mock 网络）、history/daily SQL 分页、100×370 查询计划、activity 覆盖率、乱序快照压缩，以及前端契约 fixture 导出。

## 安卓 APK（原生客户端）

仓库提供原生安卓客户端，直接读取面板数据。最低支持安卓14（Android 14），仅支持64位设备，并按安卓17规范构建。总览、设备、模型、额度、历史五个页面沿用新版网页的设计与统计规则；手机使用底部导航，大屏使用侧边导航。支持深色外观、大字体、趋势日期选择及会话筛选。更多菜单中的服务器更新检查只读取版本信息。

1. **Actions → build-apk → Run workflow**（改 `android/` 的 PR 也会自动构建）。
2. 下载 Artifact `cloud-monitor-apk`（未配置正式签名时为 `cloud-monitor-apk-debug`）。
3. 安装后可先看内置演示数据，或填写面板地址 + `ACCESS_TOKEN` 连实机。趋势图可拖动查看日期，明细在原生底部面板中展开。

包名 `io.github.iroha1145.cloudmonitor`。详见 [docs/android/README.md](docs/android/README.md)。

网页面板仍带最小 PWA 支持（manifest + 图标），可「添加到主屏幕」；独立 App 请用上面的原生 APK。

## 友情链接

- [LINUX DO](https://linux.do/)
