'use strict';

// tm-core 启动器：以 require() 方式加载 vendored 官方 hub（vendor 文件保持
// 逐字节原样）。require.main !== module 时官方入口的 loadDotEnv() 分支不会
// 执行，环境变量由本启动器从进程环境直接读取，无需 dotenv 依赖。

const { createHub } = require('./vendor/src/hub/server.js');

const port = Number(process.env.TOKEN_MONITOR_PORT || 17321);
const host = String(process.env.TOKEN_MONITOR_HOST || '0.0.0.0');
const secret = String(process.env.TOKEN_MONITOR_SECRET || '').trim();
const dataFile = String(
  process.env.TOKEN_MONITOR_DATA_FILE || '/data/devices.json'
);
const staleAfterMs = Number(
  process.env.TOKEN_MONITOR_STALE_AFTER_MS || 0
) || undefined;

const hub = createHub({ port, host, secret, dataFile, ...(staleAfterMs ? { staleAfterMs } : {}) });

hub.start().then(() => {
  console.log(`tm-core (vendored token-monitor hub) listening on http://${hub.bindHost}:${port}`);
  console.log(`Data file: ${dataFile}`);
}).catch((err) => {
  console.error(`tm-core failed to start: ${err.message}`);
  process.exit(1);
});
