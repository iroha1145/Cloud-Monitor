'use strict';

// tm-core 启动器：以 require() 方式加载 vendored 官方 hub（vendor 文件保持
// 逐字节原样）。require.main !== module 时官方入口的 loadDotEnv() 分支不会
// 执行，环境变量由本启动器从进程环境直接读取，无需 dotenv 依赖。

const path = require('node:path');
const { URL } = require('node:url');
const { createHub } = require('./vendor/src/hub/server.js');
const { sendJson } = require('./vendor/src/shared/http.js');

const TENANT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

const port = Number(process.env.TOKEN_MONITOR_PORT || 17321);
const host = String(process.env.TOKEN_MONITOR_HOST || '0.0.0.0');
const secret = String(process.env.TOKEN_MONITOR_SECRET || '').trim();
const dataFile = String(
  process.env.TOKEN_MONITOR_DATA_FILE || '/data/devices.json'
);
const staleAfterMs = Number(
  process.env.TOKEN_MONITOR_STALE_AFTER_MS || 0
) || undefined;

const syncSessionTitles = process.env.TOKEN_MONITOR_SYNC_SESSION_TITLES;

function parseTenantsEnv(raw) {
  const map = new Map();
  const trimmed = String(raw || '').trim();
  if (!trimmed) return map;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    console.error(`Invalid TENANTS_JSON: ${err.message}`);
    process.exit(1);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error('TENANTS_JSON must be a JSON object');
    process.exit(1);
  }
  for (const [id, entry] of Object.entries(parsed)) {
    const tenantId = String(id || '').trim();
    const tmSecret = String(entry?.tm_secret || '').trim();
    if (!TENANT_ID_RE.test(tenantId) || tenantId === 'default' || !tmSecret) {
      console.error(`Invalid tenant entry in TENANTS_JSON: ${tenantId}`);
      process.exit(1);
    }
    map.set(tenantId, tmSecret);
  }
  return map;
}

const tenantSecrets = parseTenantsEnv(process.env.TENANTS_JSON);
const hasExplicitTenantsEnv = tenantSecrets.size > 0;
const effectiveDefaultSecret = secret || (hasExplicitTenantsEnv ? [...tenantSecrets.values()][0] : '');

const hub = createHub({
  port,
  host,
  secret: effectiveDefaultSecret,
  dataFile,
  ...(staleAfterMs ? { staleAfterMs } : {}),
  ...(syncSessionTitles !== undefined ? { syncSessionTitles } : {}),
});

const tenantHubs = new Map();

function getOrCreateTenantHub(tenantId, tenantSecret) {
  let instance = tenantHubs.get(tenantId);
  if (instance) return instance;
  const tenantDataFile = path.join(path.dirname(dataFile), 'tenants', tenantId, 'devices.json');
  instance = createHub({
    port: 0,
    host: '127.0.0.1',
    secret: tenantSecret,
    dataFile: tenantDataFile,
    ...(staleAfterMs ? { staleAfterMs } : {}),
    ...(syncSessionTitles !== undefined ? { syncSessionTitles } : {}),
  });
  tenantHubs.set(tenantId, instance);
  return instance;
}

const [defaultRequestListener] = hub.server.listeners('request');
hub.server.removeAllListeners('request');
hub.server.on('request', (req, res) => {
  const rawTenant = req.headers['x-cm-tenant-id'];
  const tenantId = Array.isArray(rawTenant)
    ? String(rawTenant[0] || '').trim()
    : String(rawTenant || '').trim();

  if (!tenantId || tenantId === 'default') {
    if (!secret && hasExplicitTenantsEnv) {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (req.method !== 'OPTIONS' && url.pathname !== '/api/health') {
        return sendJson(res, 401, { error: 'unauthorized' });
      }
    }
    return defaultRequestListener(req, res);
  }

  if (!TENANT_ID_RE.test(tenantId)) {
    return sendJson(res, 400, { error: 'bad_request', message: 'invalid tenant id' });
  }

  const tenantSecret = tenantSecrets.get(tenantId);
  if (!tenantSecret) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }

  const tenantHub = getOrCreateTenantHub(tenantId, tenantSecret);
  tenantHub.server.emit('request', req, res);
});

hub.start().then(() => {
  console.log(`tm-core (vendored token-monitor hub) listening on http://${hub.bindHost}:${port}`);
  console.log(`Data file: ${dataFile}`);
}).catch((err) => {
  console.error(`tm-core failed to start: ${err.message}`);
  process.exit(1);
});
