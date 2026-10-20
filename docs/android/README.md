# Cloud Monitor 原生安卓客户端

基于 **Jetpack Compose** 编写的原生 Android 客户端，直接连接你的 Cloud Monitor 服务器拉取实时数据，无需在本地电脑安装 Android Studio，可通过 GitHub Actions 一键云端打包。

## 系统要求

- **Android 14（API 34）及以上**（按 Android 17 / API 37 规范编译）
- **仅限 64 位设备**（`arm64-v8a` / `x86_64`）

## 如何获取安装包（云端自动打包）

1. 打开你 Fork 或克隆的 GitHub 仓库，进入 **Actions → build-apk → Run workflow**（修改 `android/` 目录提交 PR 时也会自动触发）。
2. 等待工作流跑完后，在页面底部的 **Artifacts** 下载安装包：
   - 配置了正式签名密钥时为 `cloud-monitor-apk`
   - 未配置签名密钥时为 `cloud-monitor-apk-debug`（测试签名，直接安装即可用）
3. 传到手机安装：
   - 第一次打开可以先点 **「体验演示」** 查看内置示例数据。
   - 连接自己的服务器时，填入面板的 HTTPS 地址和 `ACCESS_TOKEN` 即可（勾选「记住密钥」会通过 Android 系统 Keystore 加密保存）。

## 主要功能

- **五大页面与网页版对齐**：总览、设备、模型、额度、历史归档，统计口径与网页版完全一致。
- **原生交互体验**：手机端采用底部导航栏，平板/大屏自动切换为侧边导航；支持深色模式与系统大字体缩放。
- **手势查明细**：趋势折线图支持 7 / 30 天切换、Token / 费用切换，手指横向滑动即可查看每日数值，点按日期弹出原生底部明细抽屉。

## 配置正式签名（可选）

如果不配置签名 Secret，GitHub Actions 每次会生成临时调试签名（重装新版本时可能需要先卸载旧版）。如果你想后续直接覆盖升级，可以在仓库的 **Settings → Secrets and variables → Actions** 中添加：

- `ANDROID_KEYSTORE_B64`：Keystore 文件的 Base64 字符串（macOS 可用 `openssl base64 -A -in release.keystore` 生成）
- `ANDROID_KEYSTORE_PASSWORD`：Keystore 密码
- `ANDROID_KEY_PASSWORD`：密钥密码（若与 Keystore 密码相同可不填）
- `ANDROID_KEY_ALIAS`：别名（默认 `cloudmonitor`）

> 请务必备份好自己的 `.keystore` 文件，丢失后将无法覆盖安装更新。

## 本地编译（可选）

如果你本地装有 Java 17 与 Android SDK（API 37 / Build-Tools 36）：

```bash
cd android
./gradlew assembleDebug          # 编译调试包
./gradlew testDebugUnitTest      # 运行单元测试
./gradlew assembleRelease        # 编译正式包
```

- 应用包名：`io.github.iroha1145.cloudmonitor`
- 详细界面设计说明见 [ANDROID_WORKBENCH_DESIGN.md](../ANDROID_WORKBENCH_DESIGN.md)。
