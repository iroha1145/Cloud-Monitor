# 原生安卓客户端（Jetpack Compose）

APK 由 `.github/workflows/build-apk.yml` 在 GitHub Actions 云端构建，本机无需 JDK / Android SDK。这是原生 Material 客户端，直接请求 `/api/v1/tm/*`，不是 WebView / TWA 套壳。

Release 会开 R8 压缩与资源收缩；图标只用到的十来个矢量路径，不打包 `material-icons-extended`。

## 最低要求

- Android 9（API 28）及以上
- 64 位：`arm64-v8a` 或 `x86_64`（不含 32 位）

## 云端出包

1. **Actions → build-apk → Run workflow**（PR 改动 `android/` 时也会自动跑）。
2. 完成后下载 Artifact：`cloud-monitor-apk` 或调试签名的 `cloud-monitor-apk-debug`。
3. 传到手机安装。首次打开可点「先看演示数据」，或填面板 HTTPS 地址 + `ACCESS_TOKEN`。局域网 HTTP 可用，登录页会提示明文风险。

访问密钥写入系统密钥库加密存储；若设备无法启用密钥库，本次登录不会把密钥写进磁盘。

顶栏可检索更新（只读）：展示当前版本、最新 Release 与 notes，**不会**向服务器 `POST` 应用更新。图表用长按代替网页悬停。系统「关闭动画」时入场/生长动效会短路。

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

`versionCode` 取 `github.run_number`，`versionName` 取仓库根目录 `VERSION`。

产物只上传 Artifact，不创建 GitHub Release，避免干扰面板「检索更新」。

## 本地构建（可选）

```bash
cd android
./gradlew assembleRelease
```

包名：`io.github.iroha1145.cloudmonitor`。
