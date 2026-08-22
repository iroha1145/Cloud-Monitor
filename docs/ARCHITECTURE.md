# Cloud Monitor 架构说明

## 数据流

```
OpenWebUI ──Filter──► 本地 openwebui-monitor (SQLite, 端口 7878)
                          │  GET /api/v1/records?start_time=<水位线>&end_time=<快照点>
                          │  GET /api/v1/users
                  sync-agent（本机 Docker, 60s 周期）
                          │  POST 云端 /api/v1/sync/push   Bearer CLOUD_API_KEY
                          ▼
              Cloud-monitor hub（服务器 Docker, SQLite）
                          │
                          ├─ GET /            网页看板（openwebui-monitor 前端原样托管）
                          └─ GET /api/v1/usage|users|records|devices  只读 API
```

可选支路：sync-agent 后台线程 `POST <token-monitor hub>/api/ingest`，
把 today/month/allTime 用量摘要按 token-monitor 设备摘要格式推送。

## 增量同步协议（水位线 + 幂等去重）

1. 每轮同步先取当前 UTC 时间 `snapshot_end` 作为窗口上界（窗口固定，
   分页期间新产生的记录留给下一轮，避免翻页错位）。
2. `start_time` = 上一轮成功后保存的 `watermark`（首轮为空 → 全量）。
3. 分页拉齐窗口内全部记录后，按时间升序分批推送（默认每批 200 条）。
4. 全部批次成功后才把 `watermark` 前移到 `snapshot_end` 并原子写状态文件；
   任何一步失败状态不动，下轮原窗口重试。
5. 云端以 `(device_id, local_id)` 唯一索引 + `INSERT OR IGNORE` 去重，
   因此窗口边界上的重复拉取/重推天然幂等。

## 云端数据模型

```sql
devices(id PK, name, platform, agent_version, first_seen_at, last_seen_at)
users(id PK, email, name, role, created_at, updated_at)          -- 与本地一致
usage_records(
  id PK AUTOINCREMENT,
  device_id TEXT,      -- 来源设备
  local_id INTEGER,    -- 该设备本地的记录 id
  user_id, nickname, model_name, input_tokens, output_tokens, created_at,
  UNIQUE(device_id, local_id)
)
```

多台设备各自维护独立的 local_id 序列，互不冲突；同一用户在多设备出现时
users 表按 id 合并（upsert），records 按设备分开存储。

## 读接口兼容性

`/api/v1/usage`、`/api/v1/users`、`/api/v1/records` 的返回结构与本地
openwebui-monitor 完全一致，因此现有前端无需任何改动即可在云端工作；
`usage` 额外附带 `by_device` 维度，`records`/`usage` 额外支持 `device_id`
查询参数，前端不识别这些新字段，不影响渲染。

## token-monitor 桥接格式

依据 token-monitor 仓库 `src/agent/agent.js`、`src/shared/syncPayload.js`、
`tests/hub/server.test.js` 确认的最小可接受摘要：

```json
{
  "deviceId": "…", "hostname": "…", "platform": "darwin",
  "agentVersion": "cloud-monitor-agent/1.0.0", "agentRuntime": "headless-agent",
  "trackedClients": ["openwebui"], "projectsEnabled": false,
  "historyAvailable": false, "syncUploadIntervalMs": 300000,
  "today":     {"totalTokens": N, "costUsd": 0, "clients": {"openwebui": N},
                "clientCosts": {}, "perModel": {"gpt-4o": n, …}},
  "month":     {…同上…},
  "allTime":   {…同上…}
}
```

hub 端会克隆并保留未识别字段（perModel 即利用这一点），month/allTime 同时
存在才构成「完整基线」。鉴权支持 `Authorization: Bearer <secret>` 与
`X-Token-Monitor-Secret: <secret>`，桥接两个头都带。

## 安全建议

- `API_KEY` 使用强随机值（如 `openssl rand -hex 32`），hub 与 agent 保持一致。
- 公网暴露 hub 必须经 HTTPS 反代（Nginx/Caddy），不要明文 HTTP 传输密钥。
- 若看板需要公开访问，设置只读 `ACCESS_TOKEN` 并在前端登录时输入该值
  （现有前端本身支持 Bearer 读取），推送用单独的 `API_KEY`。
