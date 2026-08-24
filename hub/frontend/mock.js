/* 云端用量面板 · 演示数据
 * 生成符合 TM Overview 契约（v2 + Cloud 扩展）的完整假数据
 *（结构对齐后端官方前端契约夹具 hub/tests/fixtures/frontend-contract/）：
 * - 3 台设备（MacBook-Pro.local / Win11-Desktop / ubuntu-server）
 * - 客户端 claude / codex / cursor；模型 claude-opus-4.1 / claude-sonnet-4.5 / gpt-5-codex
 * - 近 30 天 trend/trend_models、24h hourly/hourly_today、90 天 daily
 * - limits 2 个 provider（anthropic 5h 72% / 7d 38%；openai 余额）、3 条订阅、
 *   ~20 条会话、3 个项目
 * - overview 不再内嵌 370 天 history：长期历史走 buildHistoryPage（/api/v1/tm/history/daily）
 * 日期锚定「今天」（UTC 日，与热力图口径一致），每次生成带轻微随机扰动。
 */
(function () {
  "use strict";

  const MODELS = ["claude-opus-4.1", "claude-sonnet-4.5", "gpt-5-codex"];
  const CLIENTS = ["claude", "codex", "cursor"];
  // 客户端 → 模型亲和度（用于 clientModels 矩阵）
  const AFFINITY = {
    claude: { "claude-opus-4.1": 0.52, "claude-sonnet-4.5": 0.48 },
    codex: { "gpt-5-codex": 0.94, "claude-sonnet-4.5": 0.06 },
    cursor: { "claude-sonnet-4.5": 0.62, "claude-opus-4.1": 0.23, "gpt-5-codex": 0.15 },
  };
  // 客户端在长周期中的占比基准
  const CLIENT_SHARE = { claude: 0.46, codex: 0.33, cursor: 0.21 };
  // 每百万 tokens 混合成本（美元）
  const COST_PER_M = { "claude-opus-4.1": 12.5, "claude-sonnet-4.5": 4.8, "gpt-5-codex": 7.2 };
  /* 各模型缓存命中率刻意拉开（opus 高、codex 低），方便悬停图例对照 */
  const CACHE_HIT = { "claude-opus-4.1": 0.62, "claude-sonnet-4.5": 0.39, "gpt-5-codex": 0.17 };

  const DAY = 86400000;
  const rand = (a, b) => a + Math.random() * (b - a);
  const randInt = (a, b) => Math.round(rand(a, b));
  const clamp0 = (v) => Math.max(0, Math.round(v));
  const pad2 = (n) => String(n).padStart(2, "0");

  const utcDay = (offset) => new Date(Date.now() - offset * DAY).toISOString().slice(0, 10);
  const utcHour = (offsetMs) => new Date(Date.now() - offsetMs).toISOString();

  /* ---------- 370 天日归档（锚定今天，含 perClient / perModel / costUsd） ---------- */
  function buildHistory() {
    const out = [];
    const now = Date.now();
    for (let i = 369; i >= 1; i--) {
      const t = now - i * DAY;
      const d = new Date(t);
      const dow = d.getUTCDay(); // 0=周日
      const weekday = dow === 0 || dow === 6 ? rand(0.34, 0.58) : rand(0.86, 1.18);
      // 随时间缓慢增长 + 偶发高峰日
      const growth = 0.55 + (1 - i / 370) * 0.75;
      const spike = Math.random() < 0.06 ? rand(1.5, 2.1) : 1;
      const tokens = clamp0(3200000 * weekday * growth * spike * rand(0.82, 1.18));

      const cs = {
        claude: CLIENT_SHARE.claude * rand(0.8, 1.2),
        codex: CLIENT_SHARE.codex * rand(0.8, 1.2),
        cursor: CLIENT_SHARE.cursor * rand(0.8, 1.2),
      };
      const csSum = cs.claude + cs.codex + cs.cursor;
      const perClient = {};
      for (const c of CLIENTS) perClient[c] = clamp0((tokens * cs[c]) / csSum);

      // 模型占比缓慢漂移：近期 gpt-5-codex 占比升高
      const gptW = 0.14 + (1 - i / 370) * 0.16;
      const ms = {
        "claude-opus-4.1": (0.34 - (1 - i / 370) * 0.08) * rand(0.85, 1.15),
        "claude-sonnet-4.5": (0.52 - (1 - i / 370) * 0.08) * rand(0.85, 1.15),
        "gpt-5-codex": gptW * rand(0.85, 1.15),
      };
      const msSum = MODELS.reduce((a, m) => a + ms[m], 0);
      const perModel = {};
      let cost = 0;
      for (const m of MODELS) {
        perModel[m] = clamp0((tokens * ms[m]) / msSum);
        cost += (perModel[m] / 1e6) * COST_PER_M[m];
      }
      out.push({
        day: utcDay(i),
        tokens,
        costUsd: Math.round(cost * 100) / 100,
        perClient,
        perModel,
      });
    }
    return out;
  }

  /* ---------- 今日 24 小时分布（工作时段凸起；未来小时为 0） ---------- */
  function buildHourly(todayTokens) {
    const nowHour = new Date().getUTCHours();
    const weights = [];
    let wSum = 0;
    for (let h = 0; h < 24; h++) {
      let w = 0;
      if (h <= nowHour) {
        const dayCurve = Math.exp(-Math.pow(h - 14, 2) / 42); // 午后峰值
        const nightCurve = Math.exp(-Math.pow(h - 1, 2) / 18) * 0.35;
        w = (0.18 + dayCurve + nightCurve) * rand(0.7, 1.3);
      }
      weights.push(w);
      wSum += w;
    }
    return weights.map((w, h) => ({ hour: h, total: wSum > 0 ? clamp0((todayTokens * w) / wSum) : 0 }));
  }

  /* ---------- 周期对象（含全部拆分字段；capabilities 按周期嵌套，契约 §7） ---------- */
  function periodFrom(totalTokens, modelTokens, clientTokens) {
    const output = clamp0(totalTokens * rand(0.16, 0.2));
    const cacheWrite = clamp0(totalTokens * rand(0.06, 0.09));
    const unclassified = clamp0(totalTokens * rand(0.004, 0.012));
    const p = {
      /* tokenComponents=true 表示本周期逐客户端/逐模型拆分字段为真实上报构成（§7）；
         false 时前端不得标「真实构成」 */
      capabilities: { tokenComponents: true },
      totalTokens,
      outputTokens: output,
      cacheReadTokens: 0,
      cacheWriteTokens: cacheWrite,
      unclassifiedTokens: unclassified,
      timedTokens: clamp0(totalTokens * rand(0.6, 0.8)),
      timedOutputTokens: clamp0(output * rand(0.75, 0.95)),
      timedDurationMs: randInt(6, 16) * 3600000 + randInt(0, 59) * 60000,
      clients: {}, models: {},
      clientCosts: {}, modelCosts: {},
      clientCacheReads: {}, clientCacheWrites: {}, clientOutputs: {}, clientUnclassifiedTokens: {},
      modelCacheReads: {}, modelCacheWrites: {}, modelOutputs: {}, modelUnclassifiedTokens: {},
      clientModels: {}, clientModelCosts: {},
    };
    let costSum = 0;
    const outShare = output / totalTokens || 0;
    const writeShare = cacheWrite / totalTokens || 0;
    const unclsShare = unclassified / totalTokens || 0;
    const room = Math.max(0, 0.92 - outShare - writeShare - unclsShare);
    for (const m of MODELS) {
      const v = clamp0(modelTokens[m] || 0);
      p.models[m] = v;
      p.modelCosts[m] = Math.round(((v / 1e6) * COST_PER_M[m]) * 100) / 100;
      p.modelOutputs[m] = clamp0(v * outShare);
      p.modelCacheWrites[m] = clamp0(v * writeShare);
      p.modelUnclassifiedTokens[m] = clamp0(v * unclsShare);
      const hit = Math.min(CACHE_HIT[m] ?? 0.35, room) * rand(0.97, 1.03);
      p.modelCacheReads[m] = clamp0(v * hit);
      costSum += p.modelCosts[m];
    }
    const cacheRead = MODELS.reduce((s, m) => s + (p.modelCacheReads[m] || 0), 0);
    p.cacheReadTokens = cacheRead;
    for (const c of CLIENTS) {
      const v = clamp0(clientTokens[c] || 0);
      p.clients[c] = v;
      // 客户端成本 = 各模型用量 × 单价
      p.clientModels[c] = {};
      p.clientModelCosts[c] = {};
      let cCost = 0;
      const aff = AFFINITY[c];
      const affSum = Object.values(aff).reduce((a, x) => a + x, 0);
      for (const m of MODELS) {
        const share = (aff[m] || 0) / affSum;
        if (share <= 0.005) continue;
        const mv = clamp0(v * share * rand(0.92, 1.08));
        if (mv <= 0) continue;
        p.clientModels[c][m] = mv;
        const mc = Math.round(((mv / 1e6) * COST_PER_M[m]) * 100) / 100;
        p.clientModelCosts[c][m] = mc;
        cCost += mc;
      }
      p.clientCosts[c] = Math.round(cCost * 100) / 100;
      p.clientOutputs[c] = clamp0(v * outShare);
      p.clientCacheReads[c] = clamp0(v * (cacheRead / totalTokens || 0));
      p.clientCacheWrites[c] = clamp0(v * writeShare);
      p.clientUnclassifiedTokens[c] = clamp0(v * unclsShare);
    }
    p.costUsd = Math.round(costSum * 100) / 100;
    return p;
  }

  /* ---------- 主装配 ---------- */
  function buildOverview() {
    const history = buildHistory();
    const todayTokens = randInt(3800000, 5200000);
    const todayModelShares = { "claude-opus-4.1": 0.28, "claude-sonnet-4.5": 0.42, "gpt-5-codex": 0.3 };
    const todayModels = {};
    for (const m of MODELS) todayModels[m] = todayTokens * todayModelShares[m] * rand(0.9, 1.1);
    const todayClients = {};
    for (const c of CLIENTS) todayClients[c] = todayTokens * CLIENT_SHARE[c] * rand(0.9, 1.1);

    // 本月 = 当月历史 + 今日
    const thisMonth = utcDay(0).slice(0, 7);
    let monthTokens = todayTokens;
    const monthModels = { ...todayModels };
    const monthClients = { ...todayClients };
    let allTokens = todayTokens;
    const allModels = { ...todayModels };
    const allClients = { ...todayClients };
    for (const h of history) {
      allTokens += h.tokens;
      for (const m of MODELS) allModels[m] = (allModels[m] || 0) + h.perModel[m];
      for (const c of CLIENTS) allClients[c] = (allClients[c] || 0) + h.perClient[c];
      if (h.day.slice(0, 7) === thisMonth) {
        monthTokens += h.tokens;
        for (const m of MODELS) monthModels[m] = (monthModels[m] || 0) + h.perModel[m];
        for (const c of CLIENTS) monthClients[c] = (monthClients[c] || 0) + h.perClient[c];
      }
    }

    const totals = {
      today: periodFrom(todayTokens, todayModels, todayClients),
      month: periodFrom(monthTokens, monthModels, monthClients),
      allTime: periodFrom(allTokens, allModels, allClients),
    };

    // 近 30 天趋势（按模型）
    const trend = [];
    const trend_models = [];
    for (let i = 29; i >= 1; i--) {
      const h = history[history.length - i];
      trend.push({ day: h.day, total: h.tokens });
      trend_models.push({ day: h.day, total: h.tokens, models: h.perModel });
    }
    trend.push({ day: utcDay(0), total: todayTokens });
    trend_models.push({ day: utcDay(0), total: todayTokens, models: todayModels });

    // 活动：90 天 daily + 今日 hourly
    const daily = history.slice(-89).map((h) => ({ day: h.day, total: h.tokens }));
    daily.push({ day: utcDay(0), total: todayTokens });
    const hourly = buildHourly(todayTokens);

    /* 设备：按固定比例切分周期用量 */
    const devSplit = (per, ratio) => ({
      totalTokens: clamp0(per.totalTokens * ratio * rand(0.92, 1.08)),
      costUsd: Math.round(per.costUsd * ratio * rand(0.92, 1.08) * 100) / 100,
    });
    const win = (timeZone) => ({
      timeZone,
      today: { key: utcDay(0), endsAt: new Date(new Date(utcDay(0) + "T00:00:00Z").getTime() + DAY).toISOString() },
      month: { key: thisMonth, endsAt: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1)).toISOString() },
    });
    const devicesRaw = [
      {
        deviceId: "dev-mac-9f2ac1",
        hostname: "MacBook-Pro.local",
        platform: "darwin", osName: "macOS", osVersion: "15.5",
        agentVersion: "1.4.2", agentRuntime: "node v22.11.0",
        syncUploadIntervalMs: 300000,
        receivedAt: utcHour(randInt(1, 4) * 60000),
        updatedAt: utcHour(randInt(1, 4) * 60000),
        trackedClients: ["claude", "codex", "cursor"],
        split: 0.52,
        projectsEnabled: true, historyAvailable: true,
        clientHealth: {
          claude: { version: "1.0.88", status: "healthy" },
          codex: { version: "0.42.0", status: "healthy" },
          cursor: { version: "1.7.33", status: "warn" },
        },
        clientStatus: "3 个工具采集中",
        timeZone: "Asia/Shanghai",
      },
      {
        deviceId: "dev-win-47bd90",
        hostname: "Win11-Desktop",
        platform: "win32", osName: "Windows 11", osVersion: "23H2",
        agentVersion: "1.4.2", agentRuntime: "node v20.18.1",
        syncUploadIntervalMs: 300000,
        receivedAt: utcHour(randInt(5, 9) * 60000),
        updatedAt: utcHour(randInt(5, 9) * 60000),
        trackedClients: ["claude", "codex"],
        split: 0.31,
        projectsEnabled: true, historyAvailable: true,
        clientHealth: {
          claude: { version: "1.0.88", status: "healthy" },
          codex: { version: "0.41.0", status: "healthy" },
        },
        clientStatus: "2 个工具采集中",
        wslStatus: "WSL2 运行中",
        timeZone: "Asia/Shanghai",
      },
      {
        deviceId: "dev-ubu-e0538a",
        hostname: "ubuntu-server",
        platform: "linux", osName: "Ubuntu", osVersion: "22.04 LTS",
        agentVersion: "1.3.7", agentRuntime: "node v20.11.0",
        syncUploadIntervalMs: 600000,
        receivedAt: utcHour(randInt(150, 220) * 60000), // ~3 小时前 → 离线
        updatedAt: utcHour(randInt(150, 220) * 60000),
        stale: true,
        trackedClients: ["codex"],
        split: 0.17,
        projectsEnabled: false, historyAvailable: true,
        clientHealth: {
          codex: { version: "0.41.0", status: "stale" },
        },
        clientStatus: "采集暂停（设备离线）",
        timeZone: "UTC",
      },
    ];
    const devices = devicesRaw.map((d) => ({
      deviceId: d.deviceId,
      hostname: d.hostname,
      platform: d.platform, osName: d.osName, osVersion: d.osVersion,
      agentVersion: d.agentVersion, agentRuntime: d.agentRuntime,
      receivedAt: d.receivedAt, updatedAt: d.updatedAt,
      stale: d.stale === true,
      ageMs: Math.max(0, Date.now() - new Date(d.receivedAt).getTime()),
      syncUploadIntervalMs: d.syncUploadIntervalMs,
      trackedClients: d.trackedClients,
      today: devSplit(totals.today, d.split),
      month: devSplit(totals.month, d.split),
      allTime: devSplit(totals.allTime, d.split),
      projectsEnabled: d.projectsEnabled,
      historyAvailable: d.historyAvailable,
    }));
    const period_windows_by_device = {};
    for (const d of devicesRaw) period_windows_by_device[d.deviceId] = win(d.timeZone);
    const diagnostics = devicesRaw.map((d) => ({
      deviceId: d.deviceId,
      hostname: d.hostname,
      clientHealth: d.clientHealth,
      clientStatus: d.clientStatus,
      wslStatus: d.wslStatus || null,
    }));

    /* limits：anthropic 5h 72% / 7d 38%；openai 余额 + credits/spend 窗口（§8 场景） */
    const limits = [
      {
        provider: "anthropic",
        planLabel: "Claude Pro",
        accountLabel: "主账户",
        accountName: "dev",
        accountEmail: "dev@acme.com",
        windows: [
          { kind: "session", metric: "percentage", label: "5 小时窗口", usedPercent: randInt(68, 76), resetsAt: utcHour(-randInt(70, 160) * 60000) },
          { kind: "weekly", metric: "percentage", label: "7 天窗口", usedPercent: randInt(34, 42), resetsAt: utcHour(-randInt(2, 4) * DAY) },
          { kind: "monthly", metric: "percentage", label: "月度额度", usedPercent: randInt(2, 9), resetsAt: utcHour(-randInt(8, 12) * DAY) },
        ],
        device: "MacBook-Pro.local",
      },
      {
        provider: "openai",
        planLabel: "API 按量付费",
        accountLabel: "团队账户",
        accountName: "ops",
        accountEmail: "ops@acme.com",
        balanceUsd: Math.round(rand(32, 58) * 100) / 100,
        windows: [
          { kind: "credits", metric: "credits", label: "预付费额度", remaining: randInt(1800, 4200), limit: 5000 },
          { kind: "monthly", metric: "spend", label: "本月花费上限", used: Math.round(rand(38, 92) * 100) / 100, limit: 120, showMeter: false },
        ],
        device: "ubuntu-server",
      },
    ];

    /* 会话：~20 条，按 tokens 降序 */
    const PROJECTS = ["cloud-monitor", "stitch-ui", "data-pipeline"];
    const sessions = [];
    const sessN = randInt(19, 22);
    for (let i = 0; i < sessN; i++) {
      const dev = devicesRaw[i % 2]; // 会话集中在前两台在线设备
      const client = CLIENTS[randInt(0, 2)];
      const aff = AFFINITY[client];
      const modelPool = Object.keys(aff);
      const m1 = modelPool[randInt(0, modelPool.length - 1)];
      const models = {};
      models[m1] = randInt(60000, 400000);
      if (Math.random() < 0.3) {
        const m2 = modelPool[randInt(0, modelPool.length - 1)];
        if (m2 !== m1) models[m2] = randInt(20000, 120000);
      }
      const tokens = clamp0(Math.pow(rand(0.12, 1), 2.2) * 900000) + 12000;
      const startedAgo = randInt(20, 2900) * 60000;
      const lifeMs = randInt(8, 300) * 60000;
      sessions.push({
        key: `${dev.deviceId}:${client}:sess-${(0x9a000 + i * 7919).toString(16)}`,
        deviceId: dev.deviceId,
        device: dev.hostname,
        client,
        sessionId: `sess-${(0x9a000 + i * 7919).toString(16)}`,
        tokens,
        costUsd: Math.round((tokens / 1e6) * 6.4 * 100) / 100,
        models,
        project: PROJECTS[randInt(0, 2)],
        startedAt: utcHour(startedAgo + lifeMs),
        lastUsedAt: utcHour(startedAgo),
      });
    }
    sessions.sort((a, b) => b.tokens - a.tokens);

    /* 项目：按 label 跨设备合并 */
    const projects = PROJECTS.map((label, i) => {
      const tokens = clamp0(allTokens * [0.44, 0.33, 0.23][i] * rand(0.94, 1.06));
      const clients = {};
      let rest = tokens;
      CLIENTS.forEach((c, ci) => {
        const v = ci === CLIENTS.length - 1 ? rest : clamp0(tokens * CLIENT_SHARE[c] * rand(0.85, 1.15));
        clients[c] = v;
        rest -= v;
      });
      return {
        label,
        tokens,
        costUsd: Math.round((tokens / 1e6) * 6.4 * 100) / 100,
        clients,
        devices: i < 2 ? ["MacBook-Pro.local", "Win11-Desktop"] : ["MacBook-Pro.local"],
      };
    });

    // 活动：今日 24h hourly（契约 hourly_day / hourly_today 对象形态）
    const hourlyDay = utcDay(0);
    return {
      overview_schema_version: 2,
      generated_at: new Date().toISOString(),
      staleAfterMs: 600000,
      dashboard_time_zone: "Asia/Shanghai",
      features: {
        trend_models: true,
        activity_hourly: true,
        subscriptions: true,
        provider_status: true,  // GET /api/v1/tm/provider-status
        history_daily: true,    // GET /api/v1/tm/history/daily
      },
      partial: false,
      partial_errors: [],
      pending_outbox: 0,
      last_snapshot_success_at: new Date().toISOString(),
      last_snapshot_error: null,
      snapshot_degraded: false,
      totals,
      devices,
      trend,
      trend_models,
      activity: {
        time_zone: "Asia/Shanghai",
        hourly_day: hourlyDay,
        hourly,
        hourly_today: { day: hourlyDay, time_zone: "Asia/Shanghai", buckets: hourly },
        daily,
        coverage: {
          first_sample_at: utcHour(16 * 3600000),
          last_sample_at: new Date().toISOString(),
          expected_buckets: 192,
          observed_buckets: randInt(168, 188),
          coverage_percent: Math.round(rand(86, 97) * 10) / 10,
          attribution_mode: "delta",
          devices: [
            {
              device_id: "dev-mac-9f2ac1",
              first_sample_at: utcHour(16 * 3600000),
              last_sample_at: new Date().toISOString(),
              expected_buckets: 96,
              observed_buckets: 94,
              gap_count: 0,
              reset_count: 0,
            },
            {
              device_id: "dev-win-47bd90",
              first_sample_at: utcHour(14 * 3600000),
              last_sample_at: new Date().toISOString(),
              expected_buckets: 96,
              observed_buckets: 82,
              gap_count: 2,
              reset_count: 0,
            },
          ],
        },
      },
      period_windows: period_windows_by_device["dev-mac-9f2ac1"],
      period_windows_by_device,
      dashboard_period: {
        time_zone: "Asia/Shanghai",
        today: win("Asia/Shanghai").today,
        month: win("Asia/Shanghai").month,
      },
      limits,
      sessions,
      sessions_omitted: false,
      sessions_meta: {
        sessions_total: sessions.length,
        sessions_returned: sessions.length,
        sessions_omitted_count: 0,
        session_details_incomplete: false,
      },
      projects,
      diagnostics,
      // 契约：overview 不得内嵌 370 天 history 归档；长期历史走 /api/v1/tm/history/daily
    };
  }

  /* ---------- 订阅清单 ---------- */
  function buildSubscriptions() {
    const d = (offset) => utcDay(offset);
    return {
      subscriptions: [
        {
          provider: "anthropic",
          kind: "subscription",
          planName: "Claude Pro",
          binding: { profileName: "主账户", accountEmail: "dev@acme.com", accountKey: "sk-ant-oat01-9f2ac1d4e7b8" },
          amountMinor: 2000, currency: "USD",
          interval: "month", intervalCount: 1,
          startDate: d(214),
          autoRenew: true,
          topUps: [
            { id: "top_a1", label: "额外用量包", amountMinor: 1000, date: d(11) },
          ],
        },
        {
          provider: "openai",
          kind: "topup",
          planName: "OpenAI API 预付",
          binding: { profileName: "团队账户", accountEmail: "ops@acme.com" },
          currency: "USD",
          topUps: [
            { id: "top_b1", label: "额度充值", amountMinor: 50000, date: d(46) },
            { id: "top_b2", label: "额度充值", amountMinor: 25000, date: d(9) },
          ],
        },
        {
          provider: "cursor",
          kind: "subscription",
          planName: "Cursor Business",
          binding: { profileName: "个人", accountEmail: "dev@acme.com" },
          amountMinor: 4000, currency: "USD",
          interval: "month", intervalCount: 3, // 每 3 个月
          startDate: d(98),
          autoRenew: true,
          nextRenewalOverride: d(-41), // 41 天后
          topUps: [],
        },
      ],
      updated_at: new Date().toISOString(),
    };
  }

  /* ---------- 提供商状态（与 /api/v1/tm/provider-status 契约一致，结构对齐官方夹具） ---------- */
  function buildProviderStatus() {
    const now = new Date().toISOString();
    const entry = (provider, observedAs, name, url) => ({
      provider,
      observed_as: observedAs,
      name,
      status: "operational",
      description: "All Systems Operational",
      checked_at: now,
      source_updated_at: now,
      stale: false,
      error_code: null,
      url,
    });
    return {
      schema_version: 1,
      generated_at: now,
      providers: [
        entry("anthropic", ["claude"], "Anthropic", "https://status.claude.com"),
        entry("openai", ["codex"], "OpenAI", "https://status.openai.com"),
        entry("cursor", ["cursor"], "Cursor", "https://status.cursor.com"),
      ],
      partial: false,
      errors: [],
    };
  }

  /* ---------- 日归档服务端分页 mock（契约：{items, next_cursor, has_more, day_basis, …}） ----------
   * 结构对齐官方夹具 history_daily.json；cursor 为上一页最后一日的日期键；
   * 首页 cursor=null 返回最新 limit 天（含今天）。 */
  let histCache = null;
  function buildHistoryPage(cursor, limit, deviceId) {
    if (!histCache) {
      histCache = buildHistory();
      // 最新一天为「今天」（buildHistory 止于昨天）
      const todayTokens = randInt(3800000, 5200000);
      const cs = { claude: 0.46, codex: 0.33, cursor: 0.21 };
      const perClient = {};
      for (const c of CLIENTS) perClient[c] = clamp0(todayTokens * cs[c]);
      histCache.push({
        day: utcDay(0),
        tokens: todayTokens,
        costUsd: Math.round((todayTokens / 1e6) * 6.4 * 100) / 100,
        perClient,
        perModel: {
          "claude-opus-4.1": clamp0(todayTokens * 0.28),
          "claude-sonnet-4.5": clamp0(todayTokens * 0.42),
          "gpt-5-codex": clamp0(todayTokens * 0.3),
        },
      });
    }
    const desc = histCache.slice().sort((a, b) => (a.day < b.day ? 1 : -1));
    const n = Math.max(1, Number(limit) || 30);
    let startIdx = 0;
    if (cursor) {
      const i = desc.findIndex((r) => r.day < cursor); // 严格更早，游标去重
      startIdx = i < 0 ? desc.length : i;
    }
    const page = desc.slice(startIdx, startIdx + n);
    const more = startIdx + n < desc.length;
    const items = page.map((h, idx) => ({
      day: h.day,
      tokens: h.tokens,
      costUsd: h.costUsd,
      perClient: h.perClient,
      perModel: h.perModel,
      deviceCount: 2,
      // 演示一条「数据不完整」标记：倒数第 3 天归档部分损坏
      complete: !(startIdx + idx === 2),
      coverage: startIdx + idx === 2 ? 41.7 : null,
    }));
    return {
      schema_version: 1,
      day_basis: "device-local",
      dashboard_time_zone: "Asia/Shanghai",
      retention_days: 370,
      mixed_time_zones: false,
      device_time_zone: deviceId ? "Asia/Shanghai" : null,
      items,
      next_cursor: more && page.length ? page[page.length - 1].day : null,
      has_more: more,
      total_days: desc.length,
      partial: items.some((it) => !it.complete),
      partial_errors: items.some((it) => !it.complete)
        ? [{ code: "clients_json_corrupt", day: desc[2].day, device_id: "dev-win-47bd90" }]
        : [],
      generated_at: new Date().toISOString(),
    };
  }

  /* ---------- 场景变体（/demo?cm-scenario=xxx；默认健康场景） ----------
   * stale   : 设备上报字段缺失 → 「状态未知」示例
   * partial : partial_errors + snapshot_degraded + pending_outbox 示例
   * lowcov  : 低采样覆盖率（attribution_mode=delta-low-coverage）
   * reset   : 日内累计值回退（attribution_mode=delta-with-reset）
   * nocap   : totals.<period>.capabilities.tokenComponents=false（不得标「真实构成」）
   * pvdown  : 一家提供商状态页抓取失败（status=unknown + error_code=timeout，顶层 partial） */
  const scenario = (() => {
    try { return new URLSearchParams(location.search).get("cm-scenario") || ""; }
    catch (e) { return ""; }
  })();
  const baseBuildOverview = buildOverview;
  buildOverview = function () {
    const o = baseBuildOverview();
    if (scenario === "stale") {
      delete o.devices[1].stale;
      delete o.devices[1].ageMs;
      delete o.devices[1].receivedAt; // 无法判断 → 状态未知
    } else if (scenario === "partial") {
      o.partial = true;
      o.partial_errors = ["history_unavailable"];
      o.snapshot_degraded = true;
      o.last_snapshot_error = "snapshot write timeout";
      o.pending_outbox = 3;
    } else if (scenario === "lowcov") {
      o.activity.coverage = {
        first_sample_at: utcHour(2 * 3600000),
        last_sample_at: new Date().toISOString(),
        expected_buckets: 192,
        observed_buckets: 9,
        coverage_percent: 4.7,
        attribution_mode: "delta-low-coverage",
        devices: [
          {
            device_id: "dev-mac-9f2ac1",
            first_sample_at: utcHour(2 * 3600000),
            last_sample_at: new Date().toISOString(),
            expected_buckets: 96,
            observed_buckets: 6,
            gap_count: 3,
            reset_count: 0,
          },
          {
            device_id: "dev-win-47bd90",
            first_sample_at: utcHour(2.5 * 3600000),
            last_sample_at: new Date().toISOString(),
            expected_buckets: 96,
            observed_buckets: 3,
            gap_count: 5,
            reset_count: 0,
          },
        ],
      };
    } else if (scenario === "reset") {
      o.activity.coverage.attribution_mode = "delta-with-reset";
      o.activity.coverage.devices[0].reset_count = 1;
    } else if (scenario === "nocap") {
      for (const key of ["today", "month", "allTime"]) {
        o.totals[key].capabilities = { tokenComponents: false };
        const d = o.devices[0] && o.devices[0][key];
        if (d) d.capabilities = { tokenComponents: false };
      }
    }
    return o;
  };

  const baseBuildProviderStatus = buildProviderStatus;
  buildProviderStatus = function () {
    const s = baseBuildProviderStatus();
    if (scenario === "pvdown") {
      const cursor = s.providers.find((p) => p.provider === "cursor");
      cursor.status = "unknown";
      cursor.description = "";
      cursor.stale = false;
      cursor.error_code = "timeout";
      cursor.source_updated_at = null;
      s.partial = true;
      s.errors = [{ error_code: "timeout", source: "cursor" }];
    }
    return s;
  };

  window.CM_MOCK = { buildOverview, buildSubscriptions, buildProviderStatus, buildHistoryPage };
})();
