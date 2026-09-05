# 原生安卓客户端（Jetpack Compose）

APK 由 `.github/workflows/build-apk.yml` 在 GitHub Actions 云端构建，本机无需 JDK / Android SDK。客户端使用原生界面框架，对标手机版网页的设计，并直接请求 `/api/v1/tm/*`。

Release 会开 R8 压缩与资源收缩；图标只用到的十来个矢量路径，不打包 `material-icons-extended`。

## 最低要求

- 安卓14（Android 14，API 34）及以上；编译与目标系统为安卓17（API 37）
- 64 位：`arm64-v8a` 或 `x86_64`（不含 32 位）

## 云端出包

1. **Actions → build-apk → Run workflow**（PR 改动 `android/` 时也会自动跑）。
2. 完成后下载 Artifact：`cloud-monitor-apk` 或调试签名的 `cloud-monitor-apk-debug`。
3. 传到手机安装。首次打开可点「体验演示」，或填面板 HTTPS 地址 + `ACCESS_TOKEN`。局域网 HTTP 可用，登录页会提示明文风险。

访问密钥写入系统密钥库加密存储；若设备无法启用密钥库，本次登录不会把密钥写进磁盘。

顶栏更多菜单可检查服务器更新（只读）：展示当前版本、最新 Release 与 notes，**不会**向服务器 `POST` 应用更新。折线图支持7／30天、词元／费用切换，可横向拖动或用前后日期按钮查看记录；点按曲线或日期打开原生明细面板。手机采用底部导航，宽屏采用侧边导航。系统「关闭动画」时入场/生长动效会短路。

## 签名

| 场景 | 结果 |
|---|---|
| 未配置 keystore Secret | CI 生成临时调试 keystore，每次指纹不同，Artifact 名带 `-debug`，仅供测试 |
| 配置了 keystore Secret | 用你的正式 keystore 签名，指纹固定 |

正式签名需要：

- `ANDROID_KEYSTORE_B64`：keystore 的 base64。macOS 用 `openssl base64 -A -in release.keystore`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_PASSWORD`（可省略，默认与 keystore 密码相同）
- `ANDROID_KEY_ALIAS`（默认 `cloudmonitor`）

**keystore 必须备份**：丢了就无法覆盖安装更新。

`versionCode` 取 `20000 + github.run_number`，`versionName` 取仓库根目录 `VERSION`。

产物只上传 Artifact，不创建 GitHub Release，避免干扰面板「检索更新」。

## 本地构建（可选）

需要 Java 17、安卓17 SDK 和构建工具36。

```bash
cd android
./gradlew assembleDebug lintDebug testDebugUnitTest
./gradlew connectedDebugAndroidTest
./gradlew assembleRelease
```

包名：`io.github.iroha1145.cloudmonitor`。

设计与数据规则见 [安卓工作台设计](../ANDROID_WORKBENCH_DESIGN.md)。云端会在安卓14与17模拟器上执行界面测试，并上传检查报告与截图。安卓17连接局域网服务器时会请求系统的附近设备权限；公网地址不需要这项权限。
