# TM Overview 响应契约（v2）

`GET /api/v1/tm/overview` 与 `GET /api/v1/tm/subscriptions` 的面板数据契约。
**协议权威仍是 tm-core（vendored 官方 Node hub）**：totals/devices/limits/
projects 直接来自官方 `/api/stats`，本层只做时间序列叠加与面板扩展，
不重造官方聚合。

## 响应骨架（v2，新增字段只增不改）

```jsonc
{
  "overview_schema_version": 2,
  "generated_at": "2026-08-23T05:00:00.000Z",
  "staleAfterMs": 600000,
  "dashboard_time_zone": "Asia/Tokyo",        // DASHBOARD_TIME_ZONE
  "features": {                                // 面板能力声明
    "trend_models": true,
    "activity_hourly": true,
    "subscriptions": true
  },
  "partial": false,                            // 辅助来源失败时为 true
  "partial_errors": [],                        // 见下方稳定错误码
  "pending_outbox": 0,                         // P0-1 快照健康
  "last_snapshot_success_at": "…",
  "last_snapshot_error": null,
  "snapshot_degraded": false,

  // —— 官方 stats 透传（聚合/过期/stale 语义全部官方）——
  "totals": { "today": {…}, "month": {…}, "allTime": {…} },
  "devices": [ /* 官方 devices + 面板徽章（projectsEnabled/historyAvailable）*/ ],

  // —— 时间序列（SQLite 快照，官方不提供）——
  "trend":        [ { "day": "2026-08-23", "total": 123 } ],      // 近30天，设备本地日
  "trend_models": [ { "day": "…", "total": 1, "models": {"m": 1} } ], // 同口径+模型分布
  "activity": {
    "time_zone": "Asia/Tokyo",
    "hourly": [ { "hour": 10, "total": 500 } ],   // 24 桶，桶起点按仪表盘时区
    "daily":  [ { "day": "…", "total": 900 } ],    // 仪表盘日，≤90 天
    "coverage": {
      "first_sample_at": "2026-08-23T12:00:00Z",
      "last_sample_at": "…",
      "expected_buckets": 7,
      "observed_buckets": 2,
      "coverage_percent": 28.6,
      "attribution_mode": "delta-low-coverage"      // delta | delta-low-coverage | none
    }
  },

  // —— 面板扩展（P0-3 / P1-1）——
  "period_windows": {…},          // deprecated：保留兼容，取最新设备窗口
  "period_windows_by_device": {   // 每设备官方窗口
    "dev-a": { "timeZone": "Asia/Tokyo", "today": {…}, "month": {…} }
  },
  "dashboard_period": {           // 仪表盘时区自身的 today/month 窗口
    "time_zone": "Asia/Tokyo",
    "today": { "key": "2026-08-23", "endsAt": "…" },
    "month": { "key": "2026-08", "endsAt": "…" }
  },
  "limits": [ /* 官方 limits.providers + device 显示名 */ ],
  "sessions": [ { "key": "devId:client:sessionId", "deviceId": "…",
                   "client": "…", "sessionId": "…", "tokens": 1, … } ],
  "sessions_omitted": false,      // deprecated 布尔；权威见 sessions_meta
  "sessions_meta": {
    "sessions_total": 12,
    "sessions_returned": 12,
    "sessions_omitted_count": 0,
    "session_details_incomplete": false
  },
  "projects": […],
  "diagnostics": […]
}
```

## 会话主键（P1-1）

跨设备稳定主键 = `deviceId:client:sessionId`。不同设备出现相同
`client:sessionId` 时两条都保留（不互相删除、不取大者覆盖）。
仅在存在官方稳定跨设备标识且内容一致时才附 `duplicate_group`
（当前官方无此标识，恒不附）。

## partial / partial_errors 稳定错误码

辅助来源失败时 `partial: true`，错误不打栈、只有稳定 code：

| code | 含义 |
|---|---|
| `history_unavailable` | 官方 /api/history 读取失败 |
| `devices_badges_unavailable` | 官方 /api/devices 徽章读取失败 |
| `activity_unavailable` | SQLite 活动计算失败 |

`totals` / `devices` 始终完整来自官方 stats（stats 失败整体 502）。

## 活动时间口径（P0-3，写入契约）

- **hourly**：每台设备独立取其最新有效本地日的 5 分钟桶，相邻差分
  （累计回退钳 0 并标记缺口），桶起点换算到 `DASHBOARD_TIME_ZONE` 的
  小时。东京/洛杉矶设备同处一条全局时间轴。
- **daily**：采用【仪表盘日】（与 hourly 同一时区），缺失日用官方
  `/api/history.daily` 回填（同日快照优先）。
- 首次接入/长时间断线/采样缺口 → `attribution_mode: "delta-low-coverage"`，
  绝不伪装成精确小时数据。
- 夏令时 23/25 小时日：桶按 UTC 存储、换算到仪表盘时区，总量守恒。

## /api/v1/tm/subscriptions

```jsonc
{ "subscriptions": [ /* 官方订阅文档条目 */ ], "updated_at": "…" }
```

ACCESS_TOKEN 鉴权；服务端持 `TOKEN_MONITOR_SECRET` 向 tm-core 取数。
