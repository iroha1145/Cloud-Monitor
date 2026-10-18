# TM Overview 响应契约（v2 + Cloud 扩展）

`GET /api/v1/tm/overview` 与 `GET /api/v1/tm/subscriptions` 的面板数据契约。
另有两条 **Cloud 扩展**（不是官方 Hub 协议）：

- `GET /api/v1/tm/provider-status`
- `GET /api/v1/tm/history/daily`

**协议权威仍是 tm-core（vendored 官方 Node hub）**：totals/devices/limits/
projects 直接来自官方 `/api/stats`，本层只做时间序列叠加与面板扩展，
不重造官方聚合。官方 `/api/ingest` `/api/stats` `/api/history` SSE 订阅
行为不得因本扩展改变。

当前内核固定为 Token Monitor v0.74.0（`cbed5915e294abb4a210f7ebb385e9415f706821`）。支持 CatPaw（`catpaw`）、FX（`fx`）、MiniMax Code（`mcode`）、Factory Droid（`factory` / `droid`）、Muse Code（`muse`）、Goose（`goose`）客户端与 StepFun、Notion AI（`notion`）配额窗口；v0.71–v0.74 起 WorkBuddy 多个账号分开显示，多日汇总保留为 0 的未分类词元，官方项目汇总多出按模型的词元（`models`，网关的 `projects` 列表暂未带出）；`limits` 原样传递官方完整配额记录，Token Plan 未提供实际点数余额时，网页只展示上报的用量比例。

鉴权：面板与 Cloud 扩展一律 `Authorization: Bearer ACCESS_TOKEN`。
`TOKEN_MONITOR_SECRET` 不能读这些端点。Token Monitor 未启用 → 404。

网页在请求中发送 `X-CM-Time-Zone: <IANA 时区>`（由浏览器
`Intl.DateTimeFormat().resolvedOptions().timeZone` 获取）。`overview` 与
`history/daily` 接受此可选请求头；非法或空时区返回 400，未提供时保持
`DASHBOARD_TIME_ZONE` 回退，兼容原有客户端。`dashboard_time_zone`、
`dashboard_period`、活动小时和近期活动日按该请求的时区生成，缓存与并发刷新
按租户和时区分别保存，写入会使该租户所有时区的缓存失效。

`totals`、`trend`、`trend_models`、设备 `periodWindows` 和每日归档的
日期仍保留设备本地日口径；归档日期和游标不会因查看者时区而重新贴标签。
`history/daily.dashboard_time_zone` 仅表示查看者的显示时区。

## 响应骨架（v2，新增字段只增不改）

```jsonc
{
  "overview_schema_version": 2,
  "generated_at": "2026-08-23T05:00:00.000Z",
  "staleAfterMs": 600000,
  "dashboard_time_zone": "Asia/Tokyo",        // 请求时区，未提供则 DASHBOARD_TIME_ZONE
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
  "unconfirmed_outbox": 0,                     // 尚未得到核心服务确认，包含转发等待项
  "forwarding_outbox": 0,                      // 已保存完整载荷、等待转发确认
  "forwarding_bytes": 0,                       // 活动转发载荷的 UTF-8 字节数
  "expired_unconfirmed_outbox": 0,             // 审计保留期内已隔离的未确认/重试耗尽记录
  "last_forward_error": null,                  // 运维诊断，网页不直接展示内部错误
  "last_forward_terminal_reason": null,
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
                   "client": "…", "sessionId": "…", "tokens": 1,
                   "contextTokens": 1234, "contextWindow": 128000,
                   "turnEnded": false, "waitingForInput": true,
                   "liveActivity": { "state": "running", "observedAt": "2026-08-23T04:59:50.000Z" },
                   "promptCache": { "observedAt": "2026-08-23T04:59:50.000Z", "ttlSeconds": 300 },
                   "unpricedTokens": 100, "timedOutputTokens": 500, "timedDurationMs": 10000,
                   "usageSource": "codex-dots-local", "usageCoverage": "observed-only",
                   "parentSessionId": "…", "parentClient": "claude",
                   "nativeSessionId": "…", "t3ThreadId": "…",
                   "sessionKind": "background-review",
                   "deviceStale": false, "archived": false, … } ],
  "sessions_omitted": false,      // deprecated 布尔；权威见 sessions_meta
  "sessions_meta": {
    "sessions_total": 12,
    "sessions_returned": 12,
    "sessions_omitted_count": 0,
    "session_details_incomplete": false
  },
  "projects": [ { …, "unpricedTokens": 400 } ], // 官方有值时才带 unpricedTokens
  "diagnostics": […]
}
```

Overview **不得**把 370 天日归档塞进每 5 分钟刷新的 payload。长期历史走
`/api/v1/tm/history/daily` 分页。

会话新增字段（含 `waitingForInput`、`liveActivity`、`promptCache`、`unpricedTokens`、`timedOutputTokens`、`timedDurationMs`、`parentSessionId`、`parentClient`、`nativeSessionId`、`t3ThreadId`、`usageSource`、`usageCoverage`）按官方记录有值时传递，不以 false 或 0 填充缺失字段；`deviceStale`
来自所属设备的官方陈旧判定。已归档会话不显示运行；设备未过期时，`claude` / `codex` 若存在距统计时间不超过 30 秒的 `liveActivity`（`running` / `waiting` / `idle`），优先按实时活动状态显示运行中、等待输入或闲置；否则在活动时间距本次统计 0–10 分钟时，`turnEnded: true` 显示已完成，`codex` 的 `waitingForInput: true` 显示等待输入，`turnEnded: false` 显示运行中。
过期设备/旧活动显示闲置，缺少时间或布尔证据显示状态未提供。上下文是上次上报的
占用量，缺少有效窗口不计算百分比。总览仅透传官方 `/api/stats` 已接受的规范
`title`，非空字符串最多 160 个字符；不会从兼容标题字段、预览或消息正文取值。
标题仍受官方服务端 `TOKEN_MONITOR_SYNC_SESSION_TITLES`、设备同意和匹配代次三重校验；
本接口不会开启或更改任何同步设置。撤销同意经既有 Cloud 代理立即使总览缓存失效，
下一次读取移除标题；缺少标题时保留项目与会话标识回退。

`limits` 继续复制官方完整额度记录，包括每日窗口、`limitId`、`additional`、
`boundaryKind`、`resetCredits.grants`、`adapterId`、`usageSummary` 和
`actionRequired`。页面必须区分金额、点数、次数和令牌，不将缺币种的数值当作美元；
期限按 `boundaryKind` 显示重置、到期或额度变化。未知字段不需要在 Python 增加
重复的服务商白名单，旧客户端的缺省情况仍能呈现。

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

v0.70 起官方周期还带 `unpricedTokens`、`clientUnpricedTokens`、`modelUnpricedTokens`、
`clientModelUnpricedTokens`（没有价格、未计入 `costUsd` 的词元）和 `modelThroughput`
（按模型的 `timedTokens`、`timedOutputTokens`、`timedDurationMs`），随 `totals` 原样透传。
会话详情把未定价词元单独列出，不当作免费用量。

官方聚合只要有一台当前设备的某个周期没有 `modelThroughput`（例如旧版无界面代理），
就删掉该周期整张表。此时网关另给 `model_throughput_partial[period]`：
`models` 是该周期未过期、报了计时的设备按模型相加的三项计数，
`missingDevices` 是每个模型有几台当前设备用过却没报计时。`totals` 本身不改；
官方表完整、或没有任何设备报计时的周期不出现。面板用它显示模型速度，
并注明没算进的设备数。

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
原始上报明确记录且自洽、并与实际写入计数一致的四个组成字段，不回填旧记录；
不能将官方规范化过程补出的零当作上报证据。字段齐全也可能仍有未分类量。

趋势区间缓存占比忽略缺少缓存明细或无法通过单日校验的日期，按其余日期
缓存读取量之和除以**同一批日期**总用量之和计算。缺失日期不进入缓存计算
的分子或分母；不平均每日百分比，也不把缺失缓存补为零。页面在跳过日期时
标明“仅统计 15/30 天”等参与天数；区间词元与花费仍统计原有完整区间。

原始总量明确为零、且组成仅为零或缺失的日期按零贡献处理，不影响其他
日期的比例，其缺失日明细仍保留未知。缺失总量或与零总量矛盾的组成不能
作为零用量证据，该日从缓存汇总排除。空区间、全部日期缺少缓存明细或
参与日期总用量为零时，没有比例。参与日期仅能识别部分组成时，继续标注
“已识别缓存占比”。当天有用量且缓存读取明确记录为零时，该日仍参与计算，
即使其余用量尚未分类；明确的零值不属于缺失数据。

官方 `/api/history` 的旧历史合并会把缺失组成补成零。仅对此来源，在
`tokenComponentsAvailable` 不为 `true` 时，把输出、缓存读取、缓存写入的
零值恢复为未知，保留正数与未分类量；SQLite 日记录中已确认的零值不受影响。

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
| `overview_stale` | 刷新失败或超时，暂时显示上次总览；`reason` 为 `refresh_failed` 或 `refresh_timeout` |

`totals` / `devices` 来自官方 stats。刷新失败时可暂时返回上次总览，
但必须设置 `partial: true` 和 `overview_stale`，保留原 `generated_at`；
不得修改共享缓存中的原始错误列表。默认缓存有效期为 30 秒，旧数据的
总年龄不超过 60 秒（两倍 `OVERVIEW_CACHE_SECONDS`）。没有可用缓存时，
上游失败返回 502；刷新或等待超过 20 秒返回 504。
取消一个等待请求不会取消其他请求的共享结果；刷新持有者取消会释放状态，
使后续请求能够重新刷新。
外部状态页失败不得拖垮 Overview 或 Token ingest。

`pending_outbox` 包含 `forwarding_outbox`。页面将二者相减后，才得到
“等待历史补写”的数量；尚未确认的转发记录不能称为已经接收的快照。
`expired_unconfirmed_outbox > 0` 时提示旧上报未完成、历史可能有缺口。
这些终结记录不再占活动队列容量，也不单独令就绪检查长期失败；其载荷摘要、
原因和终结时间继续保留两小时，供排查。网页不直接展示内部错误字符串。

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

提供商发现来源：只看今日有用量（数值大于 0）的 `stats.periods.today.clients`
与 `stats.periods.today.models`；配额窗口 `limits.providers` 与订阅清单不参与，
服务端也不再为此读取 `/api/subscriptions`。`errors` 里来自 tm-core 的只有
`stats_unavailable`（读不到 stats 时，响应同时标 `partial: true`）。
别名：`claude|anthropic→anthropic`，
`codex|openai→openai`，`cursor→cursor`。不得因状态页 key 是
anthropic/openai 而丢掉真实的 claude/codex。

只请求固定 allowlist（客户端不能传 URL，防 SSRF）：

| canonical | summary | fallback |
|---|---|---|
| anthropic | https://status.claude.com/api/v2/summary.json | …/status.json |
| openai | https://status.openai.com/api/v2/summary.json | …/status.json |
| cursor | https://status.cursor.com/api/v2/summary.json | …/status.json |
| deepseek | https://deepseek.statuspage.io/api/v2/summary.json（Atlassian 镜像；页面入口 https://status.deepseek.com） | …/status.json |
| kimi | https://status.moonshot.cn/api/v2/summary.json | …/status.json |
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

## 分期会话与详情可用性

总览继续以 `sessions` / `sessions_meta` 表示今日会话，兼容既有读取方；新增：

- `sessions_by_period`: `{today: Session[], month: Session[], allTime: []}`。各期独立从设备同期会话映射读取、按用量排序并最多返回 100 条，主键仍为 `deviceId:client:sessionId`。不能以今日会话冒充本月会话；全历史会话明细未进入官方同步协议，即使设备记录意外带有该映射也不输出。
- `sessions_meta_by_period`: 各期包含 `period`、`availability`（`available` / `partial` / `unavailable`）、`reason`（`omitted` / `no-session-records` / `not-synced` / `null`）、`sessions_total`（云端实际收到、截断前的条数）、`sessions_returned`、`sessions_omitted_count`（上游已报告的省略条数）、`dashboard_omitted_count`（面板 100 条上限另省略的条数）、`session_details_incomplete`。两种省略分别计数；不将收到条数描述为完整源记录数。
- `availability` 只说明同步会话列表的可用性，不担保每个字段、每个客户端都完整。全历史始终为 `unavailable` / `not-synced`。存在已同步空映射时可为 `available` / `no-session-records`；它不证明本机没有会话。
- 各期 `call_details_available`、`message_content_available`、`tool_events_available` 当前固定为 `false`。不建立单次回复、用户提问或工具事件数组，不以快照差值伪造这些记录。

今日、本月明细与官方汇总使用相同的周期过期规则：有有效 `periodWindows[period].endsAt` 时，到达该时刻即过期；旧客户端按 `updatedAt || receivedAt` 的 UTC 日／月判断。设备保留的过期原始周期不会进入当前会话列表或可用性统计。判断基于本次官方聚合的时间（优先由设备时间与 `ageMs` 还原，其次使用总览时间），不使用较晚的网页读取时间，避免缓存恰好跨日／月时明细与汇总不一致。

会话增加按上游记录实际存在时传递的 `inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`、`reasoningTokens`、`messageCount`、`modelCosts`、`providers`、`projectId`，保留现有上下文、计时、父会话、来源及未定价字段。`models` 仍是模型到词元数的映射；前端另保留实际 `sessionId` 与 `modelTokens`，不能把混用多个模型的会话全部计数归入某一模型。会话费用缺失时为 `null`，不补免费费用。仅已通过官方同意校验的规范 `title` 可作为会话标题，在二级“来源与模型”展开区展示；主名称继续使用项目／会话标识回退，标题不进入主列表、搜索或导出。提示正文、助手正文、工具参数、工具结果及兼容文本不进入接口。

`reasoningTokens` 是 `outputTokens` 的子集，只作补充说明，不能再次加入合计。计时速度为 `1000 × timedOutputTokens / timedDurationMs`；分子和分母必须都存在且时长大于零，缺少时显示未知。时长是消息耗时的累计，不是精确墙钟跨度，也不能分解为等待、思考、回复和工具执行时段。上下文须有有效使用量及正容量才计算占比；无正文类别组成或当前上下文账单。

周期总量本就保留上游字段。前端现在同时解析 `timedTokens`、`timedOutputTokens`、`timedDurationMs`、按模型编号索引的 `modelThroughput`、`clientModels`、`clientModelCosts`，以及模型和客户端的 `*UnpricedTokens`。单个模型缺少速度记录时，不借用整个周期的速度；缺少客户端模型映射时不猜归属。各实体未定价词元缺失为未知，不当作零。

前端 `session-details.ts` / `model-details.ts` 只计算已有汇总的展示事实，不请求本机日志。原始设备归一化可能已将未报告计数变成零；网页无法追溯这种零是否代表真实测量，因此字段存在不等于所有来源都支持精细计量。零容量、零时长不代表上下文已空或生成瞬间完成。

### 未确认零值

总览对所有已由上游归一化的会话增加 `zeroValuesUnconfirmed: true`，不采信源记录自行声称的零值完整性。前端对缺少此标记的旧响应也保守处理：组件、推理、消息数、费用、上下文、计时及未定价计数中的零视为未知，`modelCosts` 零项不作为免费费用；正数保留。`Session.hasUnconfirmedZeros` 与 `sessionUsageDetails().hasUnconfirmedZeros` 说明是否隐藏过未确认零值，界面只需一处说明“部分零值无法确认，显示为未提供”。仅明确 `zeroValuesUnconfirmed: false` 的已确认数据（当前为本地合成示例）保留零值语义。组成只有每项已确认且加总一致才显示闭合，不能根据上游补零后的算术一致声称采集完整。原始不明的零占用不会显示为 0%。真实 `usage.js.normalizePeriod` 到云端总览及网页适配器的测试覆盖缺失输出、缓存、推理、消息数、费用被补零的情况。
