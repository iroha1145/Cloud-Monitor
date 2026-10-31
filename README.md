# Cloud Monitor

把你电脑上 [Token Monitor](https://github.com/Javis603/token-monitor) 统计的 AI 用量同步到自己的服务器，随时用网页或手机查看今天、本月和累计烧了多少 Token、花了多少钱。

👉 **在线演示（免安装直接看效果）：** https://iroha1145.github.io/Cloud-Monitor/

---

## 它是怎么工作的？

官方 Token Monitor 自带的同步服务只保留每台设备的「当前最新状态」，没法看长期历史趋势和每日账单。Cloud Monitor 在完全兼容官方同步协议的基础上，补齐了**长期历史存储**、**双密钥安全防护**和一套**全平台可视化面板**。

```text
┌──────────── 你的电脑 ────────────┐        ┌──────────── 你的服务器（Docker Compose）────────────┐
│ Token Monitor 桌面端 / Agent     │  原生  │  Python 网关 (cloud-hub)                            │
│                                  │  同步  │  ├─ 校验请求、区分「上传密钥」与「面板登录密钥」     │
│  Hub 地址: https://你的域名       │ ─────► │  ├─ 每 5 分钟存一份 SQLite 快照（补齐历史曲线与归档）│
│  同步密钥: TOKEN_MONITOR_SECRET  │  协议  │  └─ 托管响应式 Web 面板（桌面 + 手机适配）          │
└──────────────────────────────────┘        │         │                                          │
                                            │         ▼ 内部转发                                  │
                                            │  官方内核 (tm-core @ v0.83.0 原版代码)              │
                                            │  └─ 多设备合并、配额计算、实时 SSE 推送             │
                                            └────────────────────────────────────────────────────┘
```

- **100% 官方协议兼容**：底层直接运行未修改的官方 Token Monitor Hub（当前固定为 `v0.83.0`），桌面端无需安装任何额外插件，填上地址和密钥就能同步。
- **读写密钥分离**：上传数据用 `TOKEN_MONITOR_SECRET`，看面板用 `ACCESS_TOKEN`，两把密钥必须不同，互不混用。
- **纯净轻量**：仅专注 Token Monitor 数据同步与展示（已移除旧版 Open WebUI 采集组件），一套 `docker compose` 即可跑起全部服务。

---

## 面板里能看什么？

- **用量总览与趋势**：今日 / 本月 / 累计 Token 与费用、近 7 / 30 天按模型堆叠的消耗曲线。
- **模型分析**：各模型花销占比、缓存命中率、平均输出速率；点击任意模型可展开查看**会话级明细**（上下文占用、缓存剩余时间、输入输出构成）。
- **客户端与项目统计**：按 AI 编程工具（Claude Code、Cursor、Codex、Windsurf、Cline、Roo Code、Goose、CatPaw 等）查看消耗构成；按本地项目查看今日/本月/累计花销；提供「客户端 × 模型」交叉矩阵。
- **设备、配额与订阅**：查看多台电脑的在线状态、各平台实时额度窗口（Claude、Cursor、Codex、StepFun、Notion AI 等）以及月度订阅账单汇总。
- **活跃度与每日归档**：按你当前浏览器时区展示日 / 周 / 月活跃热力图与 24 小时分布；支持最多 **370 天**的每日历史账单分页回溯与 CSV 导出。
- **官方服务商状态**：自动拉取你今日在用的大模型官方状态页（OpenAI、Anthropic、Cursor、DeepSeek、Kimi、Grok），一眼看出是不是官方崩了。
- **全端体验**：支持跟随系统深色模式；桌面端配备可拖拽磁吸菜单，手机端配备三档贴底抽屉，并提供原生 Android 客户端。

---

## 3 分钟快速部署

### 方式一：一键安装脚本（推荐）

在服务器上运行安装脚本，会自动生成随机密钥、写入配置并启动容器：

```bash
# 先装成演示模式看看效果（免密访问假数据）
curl -fsSL https://raw.githubusercontent.com/iroha1145/Cloud-Monitor/main/install.sh | sudo bash -s -- --mode demo

# 确认没问题后，切换为正式实机模式（开启密码保护与真实数据接入）
curl -fsSL https://raw.githubusercontent.com/iroha1145/Cloud-Monitor/main/install.sh | sudo bash -s -- --mode live
```

> 如果已经把仓库克隆到了本地，也可以直接运行 `sudo ./install.sh` 根据菜单提示操作。重复运行脚本**不会**覆盖你已有的密钥和历史数据。

### 方式二：手动 Docker Compose 启动

```bash
git clone https://github.com/iroha1145/Cloud-Monitor.git
cd Cloud-Monitor/hub
cp .env.example .env
```

编辑 `hub/.env`，填入两把**不同**且长度不少于 32 位的随机密钥（可用 `openssl rand -hex 32` 生成）：

```ini
ACCESS_TOKEN=你的面板登录密钥（至少32位）
TOKEN_MONITOR_SECRET=你的数据同步密钥（至少32位，不能和上面相同）
CM_DEMO=false
```

启动服务并检查健康状态：

```bash
docker compose up -d --build
curl http://127.0.0.1:7878/api/health
```

### 配置 HTTPS 反向代理（Nginx 示例）

服务默认只监听本机 `127.0.0.1:7878`。公网访问请用 Nginx / Caddy 挂上 HTTPS，注意 **`/api/stats/stream` 实时流接口需要关闭代理缓冲**：

```nginx
location /api/stats/stream {
    proxy_pass http://127.0.0.1:7878;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 24h;
}

location / {
    proxy_pass http://127.0.0.1:7878;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 1m;
}
```

---

## 连接你的电脑

1. 打开你电脑上的 **Token Monitor → 设置 → 多设备同步**：
   - **Hub 地址**：填 `https://你的服务器域名`
   - **同步密钥**：填 `TOKEN_MONITOR_SECRET`
2. 浏览器打开 `https://你的服务器域名`，输入 `ACCESS_TOKEN` 登录，就能看到实时同步过来的数据了。

---

## 给朋友开独立账号（多租户）

想把服务器分享给朋友用，但不想混合各自的数据？你可以直接用内置脚本给朋友开独立账号——**大家共用同一个网址，靠各自的密钥区分身份，数据完全隔离**：

```bash
# 1. 给朋友 alice 创建一个独立账号
sudo python3 hub/scripts/tenant.py add alice

# 2. 重启容器让配置生效
sudo docker compose --project-directory hub up -d --force-recreate
```

终端会打印出属于 `alice` 的两把专属密钥（`access_token` 用来看面板，`tm_secret` 填进她电脑的 Token Monitor），发给她就能直接用。

其他常用管理命令：

```bash
sudo python3 hub/scripts/tenant.py list          # 查看所有用户列表
sudo python3 hub/scripts/tenant.py show alice    # 查看 alice 的密钥
sudo python3 hub/scripts/tenant.py rotate alice  # 为 alice 更换新密钥
sudo python3 hub/scripts/tenant.py remove alice  # 停用账号（保留历史数据文件）
```

---

## 日常维护：更新与备份

### 面板一键更新
如果是通过 `install.sh` 安装的服务，宿主机上会自动配置更新守护进程。你只需在网页面板右上角点击 **「检索更新」**，发现新版本后直接点更新，服务器就会在后台自动拉取最新代码并重建容器。

### 备份与恢复
所有数据（含主账号和所有朋友账号的 SQLite 数据库与 `devices.json`）都可以用一行命令打包备份：

```bash
# 在线热备份到指定目录
./hub/scripts/backup.sh /path/to/backup-dir

# 从备份目录恢复（会短暂重启服务）
./hub/scripts/restore.sh /path/to/backup-dir
```

> 注意：数据备份不包含 `hub/.env` 里的密钥配置，请另外妥善保存 `.env` 文件。

### 常用环境变量（`hub/.env`）

| 变量名 | 作用说明 | 默认值 |
|---|---|---|
| `ACCESS_TOKEN` | 面板登录密码（必填，≥32 位随机字符，不可与同步密钥相同） | — |
| `TOKEN_MONITOR_SECRET` | 桌面端上传同步密钥（≥32 位随机字符；留空则停用主账号上传） | 空 |
| `TOKEN_MONITOR_SYNC_SESSION_TITLES` | 设为 `true` 时允许同步会话标题 | `false` |
| `TENANTS_JSON` | 多用户配置 JSON（推荐用上面的 `tenant.py` 自动管理） | 空 |
| `CM_DEMO` | 设为 `true` 时首页直接展示免密演示面板 | `false` |
| `DASHBOARD_TIME_ZONE` | 当客户端未上报时区时的默认兜底时区（网页日常会自动按浏览器时区显示） | `Asia/Tokyo` |
| `PROVIDER_STATUS_ENABLED` | 是否开启大模型官方状态页监控 | `true` |

---

## 原生安卓客户端（APK）

除了直接把网页「添加到手机主屏幕」（支持 PWA）外，仓库还提供使用 Jetpack Compose 编写的原生 Android 客户端（支持 Android 14+，64 位设备）：

1. 打开 GitHub 仓库的 **Actions → build-apk → Run workflow**。
2. 构建完成后下载 `cloud-monitor-apk`（或 `cloud-monitor-apk-debug`）安装到手机。
3. 打开 App 可直接体验内置演示，或输入服务器地址与 `ACCESS_TOKEN` 查看实机数据。

更多签名与构建说明见 [docs/android/README.md](docs/android/README.md)。

---

## 本地开发与目录说明

```text
Cloud-Monitor/
├── hub/
│   ├── backend/        # Python FastAPI 网关（鉴权、入站校验、SQLite 时序快照、面板接口）
│   ├── tm-core/        # 官方 Token Monitor Hub (v0.83.0) 固定版本容器
│   ├── dashboard/      # React + TypeScript + Vite 网页面板源码
│   ├── scripts/        # 备份恢复、多租户管理、宿主机在线更新脚本
│   └── tests/          # 后端与全链路差分测试（pytest）
├── android/            # Jetpack Compose 原生安卓客户端源码
├── docs/               # 架构细节与数据契约文档
└── install.sh          # 服务器一键安装与更新守护配置脚本
```

- **开发前端面板**：
  ```bash
  cd hub/dashboard
  npm ci
  npm run dev          # 启动本地预览（默认带演示数据，地址 http://127.0.0.1:5188）
  npm test             # 运行前端单元测试
  npm run build        # 编译生产构建到 hub/frontend/app/
  ```
  前端详细说明见 [hub/dashboard/README.md](hub/dashboard/README.md)。

- **运行后端测试**：
  ```bash
  cd hub
  PYTHONPATH=backend python3 -m pytest tests/ -q
  ```
- **深入了解底层架构**：如果你关心重试队列、5 分钟分桶规则或官方协议差分测试，可以阅读 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 友情链接

- [LINUX DO](https://linux.do/)
