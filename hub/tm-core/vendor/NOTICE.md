# Vendored: token-monitor hub

- 上游: https://github.com/Javis603/token-monitor
- 正式版: v0.70.0
- 固定提交: ac4eeb2c4aea239dd94b67f074c73f69aafc46f8
- 许可: MIT（见 LICENSE-token-monitor，保留上游版权声明）
- 范围: `src/hub/server.js` 与 `src/shared/syncPayload.js` 的完整本地 require 闭包，共 23 个文件。
  `syncPayload.js` 用于差分测试与真实载荷生成；不引入桌面采集器或 Electron。
- 本目录中的上游源码和许可证逐字节复制，未经修改。
- 运行方式: `node ../run.js`（从本目录执行），启动器导入 `createHub()`，
  不执行上游命令行入口的 dotenv 加载；无 npm 运行依赖，使用现有 Node 22.18 镜像。
- 环境变量: TOKEN_MONITOR_PORT / TOKEN_MONITOR_HOST / TOKEN_MONITOR_SECRET /
  TOKEN_MONITOR_STALE_AFTER_MS / TOKEN_MONITOR_DATA_FILE / TOKEN_MONITOR_SYNC_SESSION_TITLES。
- 固定来源哈希: `../upstream-v070.json`；本地完整性检查: `python3 ../sync_vendor.py --check`。
  从已解压的正式版源码恢复: `python3 ../sync_vendor.py --source /path/to/upstream-v070`。
  脚本先核对固定哈希和依赖闭包，失败时不写入；不访问网络、不安装依赖。
- Hub 构建注册表与源码一起复制，不单独修改。该正式版为 coreRevision 80 / node-hub runtimeRevision 5。
