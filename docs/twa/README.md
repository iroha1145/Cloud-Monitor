# 安卓 APK（TWA）构建与部署指南

APK 由 `.github/workflows/build-apk.yml` 在 GitHub Actions 云端构建，本机无需安装 JDK / Android SDK。

## 工作流怎么工作

- TWA 工程从仓库内模板 `twa/twa-manifest.json`（包名 `io.github.iroha1145.cloudmonitor`）生成，**构建过程不访问线上面板**——面板还没部署新前端也能先出包。
- Bubblewrap 需要联网下载启动图标：CI 在 runner 本地把 `hub/frontend` 起成静态服务（127.0.0.1:8788）提供 `icons/icon-512.png` 与 `icons/maskable-512.png`。
- `@bubblewrap/cli` 钉版本 1.25.0；`~/.bubblewrap/config.json` 预写 JDK/SDK 路径，全程非交互。
- 签名密码只经环境变量 `BUBBLEWRAP_KEYSTORE_PASSWORD` / `BUBBLEWRAP_KEY_PASSWORD` 传入，不写进 manifest。
- 产物只上传为 **Artifact**（`cloud-monitor-apk` 或调试签名的 `cloud-monitor-apk-debug`），不创建 GitHub Release——避免 `apk-v*` 这类 tag 被面板的「检索更新」误当成最新软件版本。

## 使用步骤

1. 保证面板可通过 HTTPS 域名访问（TWA 硬性要求；构建时不需要，但 APK 运行时需要）。
2. 仓库 **Settings → Secrets and variables → Actions → Variables** 新建 `TWA_HOST_URL`，如 `https://panel.example.com`（不带末尾斜杠）。
3. **Actions → build-apk → Run workflow**（`host` 输入可临时覆盖 Variable）。
4. 构建完成后从 Artifact 下载 APK 安装。
5. 按「assetlinks.json」一节部署校验文件，消除地址栏。

## 签名

| 场景 | 结果 |
|---|---|
| 未配置 keystore Secret | CI 生成临时调试 keystore，每次构建指纹都不同，Artifact 名带 `-debug` 后缀，仅供测试 |
| 配置了 keystore Secret | 用你的正式 keystore 签名，指纹固定 |

正式签名需要三个 Secret：

- `ANDROID_KEYSTORE_B64`：keystore 的 base64。**macOS 没有带 `-w0` 的 base64**，用：
  ```bash
  openssl base64 -A -in release.keystore > release.keystore.b64   # macOS / 通用
  base64 -w0 release.keystore > release.keystore.b64              # Linux
  ```
- `ANDROID_KEYSTORE_PASSWORD`：keystore 密码。
- `ANDROID_KEY_ALIAS`：默认 `cloudmonitor`。

**keystore 必须备份**：丢了就无法覆盖安装更新，只能换包名重装。

以后上 Google Play 还要注意：Play 启用 Play App Signing 后，`assetlinks.json` 里要填的是 **Play 签名证书**的指纹（Play Console → 设置 → 应用签名），不是上传 keystore 的指纹。

## assetlinks.json（消除地址栏）

1. 从构建日志「打印签名指纹」步骤复制 `SHA256:` 指纹。
2. 复制 `docs/twa/assetlinks.json.example` 为 `assetlinks.json`，替换指纹（标准 Digital Asset Links **数组**格式，域名由部署主机决定）。
3. 放到面板服务器的 `data/assetlinks.json`（网关自动在 `/.well-known/assetlinks.json` 暴露，按请求读取，放入即生效、无需重启）。也可用环境变量 `ASSETLINKS_FILE` 指定其他路径。
4. 校验：
   ```bash
   curl -fsS https://<域名>/.well-known/assetlinks.json     # 必须返回 application/json + HTTP 200
   adb shell pm verify-app-links --re-verify io.github.iroha1145.cloudmonitor
   ```
   或用 Google 的 [Statement List Validator](https://developers.google.com/digital-asset-links/tools/generator)。
   如果整站经 nginx 反代，无需额外配置（路径会透传给网关）。

## 已知边界（有意为之的最小实现）

- **没有 Service Worker**：离线打开是安卓默认离线页，不满足 PWA 质量标准；TWA 不依赖 SW 也能全屏运行。需要离线能力时再补。
- **登录密钥存储**：浏览器标签页里仍用 sessionStorage（关标签页即清除）；在 TWA / 安装到主屏（`display-mode: standalone`）下自动改用 localStorage，避免进程被系统回收后每次都要重输密钥。退出登录或卸载应用即清除。
- **不要把 `TWA_HOST_URL` 指向 GitHub Pages 演示站**：演示站只是静态 demo（mock 数据），且无 `/.well-known/assetlinks.json`。
- PWA manifest 已带 `id`/`short_name`（≤12 字符）/ `any`+`maskable` 图标；改动这些或包名、签名后需重新构建 APK 并更新 assetlinks 指纹。
