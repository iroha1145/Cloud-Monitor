# Vendored: token-monitor hub

- 上游: https://github.com/Javis603/token-monitor
- 固定提交: b92586595d9770b907183fbafa0865cba5906cff
- 许可: MIT (见 LICENSE-token-monitor)
- 范围: `src/hub/server.js` 的完整 require 闭包（17 个文件）
  另加 `src/shared/syncPayload.js` 闭包（差分测试与真实载荷生成用）。
  文件逐字节原样复制，未做任何修改——本目录是协议行为的唯一权威。
- 运行方式: `node src/hub/server.js`（无 npm 依赖，Node >= 22），
  环境变量 TOKEN_MONITOR_PORT / TOKEN_MONITOR_HOST / TOKEN_MONITOR_SECRET /
  TOKEN_MONITOR_STALE_AFTER_MS / TOKEN_MONITOR_DATA_FILE。
