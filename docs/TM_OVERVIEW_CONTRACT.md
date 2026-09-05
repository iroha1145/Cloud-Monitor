# TM Overview 响应契约（v2 + Cloud 扩展）

`GET /api/v1/tm/overview` 与 `GET /api/v1/tm/subscriptions` 的面板数据契约。
另有两条 **Cloud 扩展**（不是官方 Hub 协议）：

- `GET /api/v1/tm/provider-status`
- `GET /api/v1/tm/history/daily`

**协议权威仍是 tm-core（vendored 官方 Node hub）**：totals/devices/limits/
projects 直接来自官方 `/api/stats`，本层只做时间序列叠加与面板扩展，
不重造官方聚合。官方 `/api/ingest` `/api/stats` `/api/history` SSE 订阅
行为不得因本扩展改变。

鉴权：面板与 Cloud 扩展一律 `Authorization: Bearer ACCESS_TOKEN`。
`TOKEN_MONITOR_SECRET` 不能读这些端点。Token Monitor 未启用 → 404。

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
    "subscriptions": true,
    "provider_status": true,                   // GET /api/v1/tm/provider-status
    "history_daily": true                      // GET /api/v1/tm/history/daily
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
  "trend":        [ { "day": "2026-08-23", "total": 123, "costUsd": 1.23,
                      "outputTokens": 10, "cacheReadTokens": 80,
                      "cacheWriteTokens": 5, "unclassifiedTokens": 0,
                      "tokenComponentsAvailable": true, "componentsPartial": false } ], // 近30天，设备本地日
  "trend_models": [ { "day": "…", "total": 1, "models": {"m": 1} } ], // 同口径+模型分布
  "activity": {
    "time_zone": "Asia/Tokyo",
    "hourly_day": "2026-08-23",               // 仪表盘今日 key
    "hourly": [ { "hour": 10, "total": 500 } ], // 旧前端：24 桶数组
    "hourly_today": {                         // 带 day 的对象形态
      "day": "2026-08-23",
      "time_zone": "Asia/Tokyo",
      "buckets": [ { "hour": 10, "total": 500 } ]
    },
    "daily":  [ { "day": "…", "total": 900 } ],    // ≤90 天，不是 370 天全量
    "coverage": {
      "first_sample_at": "2026-08-23T12:00:00.000Z",
      "last_sample_at": "…",
      "expected_buckets": 6,                  // Σ expected_device
      "observed_buckets": 6,                  // Σ observed_device
      "coverage_percent": 100.0,              // 钳制 0–100
      "attribution_mode": "delta",            // none | delta | delta-low-coverage | delta-with-reset
      "devices": [                            // 可选逐设备诊断
        {
          "device_id": "dev-a",
          "first_sample_at": "…",
          "last_sample_at": "…",
          "expected_buckets": 3,
          "observed_buckets": 3,
          "gap_count": 0,
          "reset_count": 0
        }
      ]
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

Overview **不得**把 370 天日归档塞进每 5 分钟刷新的 payload。长期历史走
`/api/v1/tm/history/daily` 分页。

## 用量组成与模型缓存

`totals.<period>.capabilities.tokenComponents` 表示整个周期的拆分是否完整。
某个客户端或模型存在未分类用量时，该标志可以为 `false`，但已提供的
`cacheReadTokens`、`modelCacheReads`、`clientCacheReads` 等字段仍有效，
不能据此隐藏所有缓存及输出计数。

页面按周期、客户端、模型分别读取自身的拆分字段。实体必须有自己的组件
条目（显式 0 也算），不能只凭规范化生成的空映射把总量猜成非缓存输入。
官方 `modelUnclassifiedTokens` / `clientUnclassifiedTokens` 映射中的缺失
条目表示该实体没有已记录的未分类量；在已有组件证据时可以据此计算剩余
非缓存输入。旧载荷未提供未分类字段且未声明完整时，剩余量仍列为未分类。

模型提示保留可确认的缓存读取、写入计数。完整模型沿用“缓存率”名称和
缓存读取量 / 模型总量的口径；仍有未知组成时标注“已识别缓存占比”，
不将其当作完整命中率。缓存缺失和全量未分类不能显示为 0% 缓存；
组件合计超过总量时保留不一致提示，并停止显示无法成立的缓存率。

`trend` 与 `history/daily.items` 也携带当天的 `outputTokens`、
`cacheReadTokens`、`cacheWriteTokens`、`unclassifiedTokens`。每台设备
先选当天最后一条快照，再合计同一组快照的总量、费用与组成，不能将当天
累计值相加，也不能借用当前周期的缓存比例。`trend` 的缺失日期由官方
`history.daily` 整行补入；同日仍以 SQLite 整行优先，不跨来源拼接缓存。

前三个组成计数为数值或 `null`；全无记录时为 `null`，部分设备提供时
只合计已识别的计数，其余量列入 `unclassifiedTokens`。
`tokenComponentsAvailable` 表示该日组成完整，`componentsPartial`
标明仍不完整。旧快照的非零计数可以恢复；无法区分缺失与默认零的旧字段
继续保留未知。新增可空列 `today_components_recorded` 只标记新快照中
明确记录且自洽的四个组成字段，不回填旧记录；字段齐全也可能仍有未分类量。

趋势区间缓存占比按该区间缓存读取量之和除以总用量之和计算。原始总量
明确为零、且组成仅为零或缺失的日期不影响其他日期的比例，但其缺失日明细
仍保留未知；缺失总量或与零总量矛盾的组成不能跳过。空区间和全零区间
没有比例。任一有用量日
缺少缓存数据时，区间比例显示未提供；部分可识别时保留相应说明。

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
| `clients_json_corrupt` / `models_json_corrupt` | 日归档 JSON 损坏（history/daily） |

`totals` / `devices` 始终完整来自官方 stats（stats 失败整体 502）。
外部状态页失败不得拖垮 Overview 或 Token ingest。

## 活动时间口径

### hourly

1. 计算 `dashboard_period.today.key`（`DASHBOARD_TIME_ZONE` 的今日）。
2. 每个 5 分钟桶换算到仪表盘时区。
3. **只有转换后日期 == today.key 的桶进入 hourly**；其它日期进 daily，
   不进今日 24 小时图。禁止把不同日期的 08:00 加到同一格。
4. 旧前端继续读 `activity.hourly` 数组；新字段 `hourly_day` /
   `time_zone` / `hourly_today.{day,time_zone,buckets}`。

### daily

与 `GET /api/v1/tm/history/daily` **共用同一查询核心**：

- 近 7 个仪表盘日（含今日）：5 分钟桶按仪表盘日聚合（差分）。
- 更早：每 `(device_id, local_day)` 最后一条快照（日锚点）按设备本地日汇总。
  归档只填 **早于** 这 7 日窗口的日期，避免「设备本地昨日」与已滚进
  仪表盘今日的同一笔用量双计。
- 官方 `/api/history` 回填缺失日（同日快照优先）。
- History 不可用时 SQLite 仍给出多日序列，不得只返回当前一天。
- Overview 窗口 ≤90 天。

### coverage

逐设备计算再求和，禁止用「全设备最早到最晚的单一跨度」当 expected：

```
expected_total = Σ expected_device
observed_total = Σ observed_device
coverage_percent = clamp(observed_total / expected_total * 100, 0, 100)
```

两台设备各有三个相同时间桶 → observed=6, expected=6, coverage=100%，
**绝不是 200%**。

`attribution_mode`：

| 值 | 何时 |
|---|---|
| `none` | 无数据 |
| `delta` | 覆盖完整且无显著缺口；首桶在设备本地日开始附近（10 分钟宽限） |
| `delta-low-coverage` | 首桶明显晚于本地日开始、长时间断线、或采样缺口 |
| `delta-with-reset` | 同一本地日内累计值回退 |

不得因为每个设备天然存在第一个桶，就把所有有数据的情况标成
`delta-low-coverage`。

夏令时 23/25 小时日：桶按 UTC 存储、换算到仪表盘时区，总量守恒。

## 日口径 / day_basis

SQLite 日锚点是 **设备本地日**（`periodWindows.today.key` 等），不是统一
UTC 日，也不是仪表盘日。多时区设备聚合时：

- 响应标明 `day_basis: "device-local"`
- 设备时区不一致时 `mixed_time_zones: true`
- `device_id` 筛选时返回该设备的 `device_time_zone`
- **不允许静默改日期口径**

## GET /api/v1/tm/history/daily

ACCESS_TOKEN。查询参数：`cursor`（上一页最后一天，继续读更早）、
`limit`（默认 30，1–90）、可选 `device_id` / `from` / `to`（YYYY-MM-DD）。

数据源 `tm_snapshot_buckets`。每台设备每个 `local_day` 取真正最后一条：

```
ORDER BY bucket_start DESC, server_received_at DESC, id DESC
```

然后跨设备按 day 聚合（`today_total→tokens`，`today_cost→costUsd`，
`clients_json→perClient`，`models_json→perModel`，`deviceCount`，
`complete`/`coverage`，以及上述当天组成字段）。`complete` 继续表示
归档记录完整性，与组成是否完整分开。

SQL 分页，不加载 370 天全表再在 Python 切片。使用组合索引
`(device_id, local_day, bucket_start)` / `local_day`。游标稳定；重试同一
cursor 不得把同一天再返回一遍。JSON 损坏标 `partial`，不 500。

```jsonc
{
  "schema_version": 1,
  "day_basis": "device-local",
  "dashboard_time_zone": "Asia/Tokyo",
  "retention_days": 370,
  "mixed_time_zones": false,
  "device_time_zone": null,
  "items": [
    {
      "day": "2026-08-22",
      "tokens": 123456,
      "costUsd": 12.34,
      "outputTokens": 10000,
      "cacheReadTokens": 80000,
      "cacheWriteTokens": 5000,
      "unclassifiedTokens": 0,
      "tokenComponentsAvailable": true,
      "componentsPartial": false,
      "perClient": { "claude": 100000, "codex": 23456 },
      "perModel": { "claude-sonnet": 100000, "gpt-5": 23456 },
      "deviceCount": 2,
      "complete": true,
      "coverage": null
    }
  ],
  "next_cursor": "2026-07-23",
  "has_more": true,
  "partial": false,
  "partial_errors": []
}
```

## GET /api/v1/tm/provider-status

Cloud 扩展。环境变量：`PROVIDER_STATUS_ENABLED`（默认 true）、
`PROVIDER_STATUS_CACHE_SECONDS`（300）、`PROVIDER_STATUS_TIMEOUT_SECONDS`
（2.5）。总请求预算 ≤3s，并发 `httpx.AsyncClient`，禁止串行 3×5s。

提供商发现来源：`stats.periods.today.clients`、`stats.limits.providers`、
`subscriptions[].provider`。别名：`claude|anthropic→anthropic`，
`codex|openai→openai`，`cursor→cursor`。不得因状态页 key 是
anthropic/openai 而丢掉真实的 claude/codex。

只请求固定 allowlist（客户端不能传 URL，防 SSRF）：

| canonical | summary | fallback |
|---|---|---|
| anthropic | https://status.claude.com/api/v2/summary.json | …/status.json |
| openai | https://status.openai.com/api/v2/summary.json | …/status.json |
| cursor | https://status.cursor.com/api/v2/summary.json | …/status.json |
| grok | https://status.x.ai/feed.xml（RSS，API 组件） | 同 URL |
| grok-web | https://status.x.ai/feed.xml（RSS，Grok Web） | 同 URL；页面 https://status.x.ai/grok-com |

优先 API / Claude Code / Cursor 组件。ChatGPT 网页故障不得必然把
OpenAI API 标成中断。

缓存：singleflight + stale-while-revalidate（未过期直返；过期立即返 stale
并后台刷新；完全无缓存且失败才 `unknown`）。不记录账户、密钥或完整
请求 Header。

```jsonc
{
  "schema_version": 1,
  "generated_at": "…",
  "providers": [
    {
      "provider": "anthropic",
      "observed_as": ["claude"],
      "name": "Anthropic",
      "status": "operational",  // operational|degraded|maintenance|outage|unknown
      "description": "…",
      "checked_at": "…",
      "source_updated_at": "…",
      "stale": false,
      "error_code": null,
      "url": "https://status.claude.com"
    }
  ],
  "partial": false,
  "errors": []
}
```

## 快照压缩

近 7 天全分辨率；更早每个 `(device_id, local_day)` 保留 **时间上最后一条**
（`ROW_NUMBER() OVER (PARTITION BY device_id, local_day ORDER BY
bucket_start DESC, server_received_at DESC, id DESC)` 的 `rn=1`），
**不是 `MAX(id)`**。370 天硬删除。

截止时间统一毫秒精度 UTC + `Z` 后缀。禁止 `datetime.isoformat()` 的
`+00:00` 与 `Z` 文本互比。存量 `+00:00` 行迁移为 `Z`。

## /api/v1/tm/subscriptions

```jsonc
{ "subscriptions": [ /* 官方订阅文档条目 */ ], "updated_at": "…" }
```

ACCESS_TOKEN 鉴权；服务端持 `TOKEN_MONITOR_SECRET` 向 tm-core 取数。
