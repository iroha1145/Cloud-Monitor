# Vendored: token-monitor hub

- 上游: https://github.com/Javis603/token-monitor
- 正式版: v0.83.0
- 固定提交: 7dc01989ccd62fd52bc027b28c64f7d225fbc5c8
- 许可: MIT（见 LICENSE-token-monitor，保留上游版权声明）
- 范围: `src/hub/server.js` 与 `src/shared/syncPayload.js` 的完整本地 require 闭包，共 25 个文件。
  `syncPayload.js` 用于差分测试与真实载荷生成；不引入桌面采集器或 Electron。
- 本目录中的上游源码和许可证逐字节复制，未经修改。
- 运行方式: `node ../run.js`（从本目录执行），启动器导入 `createHub()`，
  不执行上游命令行入口的 dotenv 加载；无 npm 运行依赖，使用现有 Node 22.18 镜像。
- 环境变量: TOKEN_MONITOR_PORT / TOKEN_MONITOR_HOST / TOKEN_MONITOR_SECRET /
  TOKEN_MONITOR_STALE_AFTER_MS / TOKEN_MONITOR_DATA_FILE / TOKEN_MONITOR_SYNC_SESSION_TITLES。
- 固定来源哈希: `../upstream-v083.json`；本地完整性检查: `python3 ../sync_vendor.py --check`。
  从已解压的正式版源码恢复: `python3 ../sync_vendor.py --source /path/to/upstream-v083`。
  脚本先核对固定哈希和依赖闭包，失败时不写入；不访问网络、不安装依赖。
- Hub 构建注册表与源码一起复制，不单独修改。该正式版为 coreRevision 101 / node-hub runtimeRevision 9。

- v0.77.0 新增可选批量保存；Cloud Monitor 启动器继续使用默认 `persistIntervalMs=0`，每次写入立即保存，未开放延迟保存配置。快照改为紧凑 JSON 格式，存储结构版本仍为 1，既有数据无需迁移。
- v0.78.0–v0.80.0 在本目录范围内只改 5 个文件，依赖闭包仍为 24 个文件，上报格式（`server.js`、`syncPayload.js`）不变：新增 Senpi（`senpi`，OmO Native）客户端名称归一与三项来源检查；配额服务商目录新增 Muse Code（`muse`），Muse 没有可跨设备的账号标识，配额按设备分行，不合并。
- v0.81.0–v0.83.0 在本目录范围内改 6 个文件、新增 `src/shared/hubDelta.js`，依赖闭包为 25 个文件；上报格式不变（`syncPayload.js` 未改），旧客户端照常上传。实时流（`/api/stats/stream`）协议升到 4：`X-Token-Monitor-Stream: 3` 收新鲜度事件，`4` 另收按修订号衔接的增量事件（RFC 6902 补丁），版本 2 或不带请求头改为每次收完整 `stats`（官方文档写明的兼容回退）。会话新增推理强度（`reasoningEffort`，Codex 与 Claude）和按模型的词元组成（`modelTokenComponents`）；Codex 的提示词缓存倒计时由上游取消，只保留 Claude 的。客户端名称里很长的连字符串不再拖慢 Hub。
- 正式发布来源: https://github.com/Javis603/token-monitor/releases/tag/v0.83.0
