import assert from "node:assert/strict";
import test from "node:test";
import {
  createDemoData,
  normalizeComponents,
  normalizeOverview,
  normalizePeriod,
} from "../src/data.ts";

const componentKeys = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "unclassified",
] as const;
const cents = (amount: number) => Math.round(amount * 100);

test("sample model, client, device and component totals agree for all periods", () => {
  const data = createDemoData(new Date("2026-09-05T02:00:00Z"));
  for (const key of ["today", "month", "allTime"] as const) {
    const period = data.periods[key];
    assert.equal(
      componentKeys.reduce(
        (sum, component) => sum + period.components[component],
        0,
      ),
      period.totalTokens,
    );
    for (const entities of [period.models, period.clients]) {
      assert.equal(
        entities.reduce((sum, item) => sum + item.totalTokens, 0),
        period.totalTokens,
      );
      assert.equal(
        entities.reduce((sum, item) => sum + cents(item.costUsd || 0), 0),
        cents(period.costUsd || 0),
      );
      for (const item of entities)
        assert.equal(
          componentKeys.reduce(
            (sum, component) => sum + item.components[component],
            0,
          ),
          item.totalTokens,
        );
    }
    assert.equal(
      data.devices.reduce(
        (sum, device) => sum + device.periods[key].totalTokens,
        0,
      ),
      period.totalTokens,
    );
    assert.equal(
      data.devices.reduce(
        (sum, device) => sum + cents(device.periods[key].costUsd || 0),
        0,
      ),
      cents(period.costUsd || 0),
    );
  }
});

test("sample day, month, all-time, trend and hourly views share a consistent timeline", () => {
  const data = createDemoData(new Date("2026-09-05T02:00:00Z"));
  assert.equal(data.trend.length, 30);
  assert.equal(data.activity.length, 90);
  assert.equal(data.trend.at(-1)?.totalTokens, data.periods.today.totalTokens);
  assert.equal(
    data.activity.reduce((sum, point) => sum + point.totalTokens, 0),
    data.periods.allTime.totalTokens,
  );
  const month = data.trend.filter((point) => point.day.startsWith("2026-09"));
  assert.equal(
    month.reduce((sum, point) => sum + point.totalTokens, 0),
    data.periods.month.totalTokens,
  );
  assert.equal(
    month.reduce((sum, point) => sum + cents(point.costUsd || 0), 0),
    cents(data.periods.month.costUsd || 0),
  );
  assert.equal(
    data.hourly.reduce((sum, point) => sum + point.totalTokens, 0),
    data.periods.today.totalTokens,
  );
  for (const day of data.trend)
    assert.equal(
      Object.values(day.models).reduce((sum, amount) => sum + amount, 0),
      day.totalTokens,
    );
});

test("sample dates use Tokyo day at UTC midnight boundaries", () => {
  const data = createDemoData(new Date("2026-09-04T15:05:00Z"));
  assert.equal(data.trend.at(-1)?.day, "2026-09-05");
  assert.equal(data.hourly[0].totalTokens, data.periods.today.totalTokens);
  assert.equal(
    data.hourly.slice(1).reduce((sum, point) => sum + point.totalTokens, 0),
    0,
  );
});

test("daily demo detail has its own components and closes with each day and month", () => {
  const data = createDemoData(new Date("2026-09-05T02:00:00Z"));
  for (const point of data.trend) {
    assert.ok(point.components);
    assert.equal(
      componentKeys.reduce((sum, key) => sum + point.components![key], 0),
      point.totalTokens,
    );
    assert.equal(
      point.components.cacheRate,
      point.components.cacheRead / point.totalTokens,
    );
  }
  const month = data.trend.filter((point) => point.day.startsWith("2026-09"));
  for (const key of componentKeys)
    assert.equal(
      month.reduce((sum, point) => sum + point.components![key], 0),
      data.periods.month.components[key],
    );
  assert.deepEqual(
    data.trend.at(-1)?.components,
    data.periods.today.components,
  );
  assert.notEqual(data.trend.at(-1)?.components, data.periods.today.components);
});

test("official daily archive adds expense but never borrows cache from today's totals", () => {
  const data = normalizeOverview(
    {
      totals: {
        today: {
          totalTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 80,
          cacheWriteTokens: 0,
          unclassifiedTokens: 0,
        },
      },
      trend: [
        { day: "2026-09-04", total: 100 },
        { day: "2026-09-05", total: 100 },
      ],
    },
    {
      history: {
        items: [
          {
            day: "2026-09-04",
            tokens: 100,
            costUsd: 2.15,
            perModel: { gpt: 100 },
          },
        ],
      },
    },
  );
  assert.equal(data.trend[0].costUsd, 2.15);
  assert.deepEqual(data.trend[0].models, { gpt: 100 });
  assert.equal(data.trend[0].components, null);
  assert.equal(data.trend[1].components, null);
  assert.equal(data.trend[1].costUsd, null);
});

test("daily explicit components preserve zero and archive snapshot mismatch stays unavailable", () => {
  const data = normalizeOverview(
    {
      totals: {},
      trend: [
        { day: "2026-09-04", total: 100 },
        { day: "2026-09-05", total: 100 },
      ],
    },
    {
      history: {
        items: [
          {
            day: "2026-09-04",
            tokens: 100,
            costUsd: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 10,
            unclassifiedTokens: 0,
          },
          {
            day: "2026-09-05",
            tokens: 120,
            costUsd: 2.4,
            cacheReadTokens: 80,
            outputTokens: 10,
            unclassifiedTokens: 0,
          },
        ],
      },
    },
  );
  assert.equal(data.trend[0].costUsd, 0);
  assert.equal(data.trend[0].components?.cacheRate, 0);
  assert.equal(data.trend[0].components?.input, 90);
  assert.equal(data.trend[1].totalTokens, 100);
  assert.equal(data.trend[1].costUsd, null);
  assert.equal(data.trend[1].components, null);
});

test("partial cycle still preserves complete model cache and separates unknown models", () => {
  const source = {
    capabilities: { tokenComponents: false },
    totalTokens: 150,
    cacheReadTokens: 80,
    outputTokens: 10,
    cacheWriteTokens: 0,
    unclassifiedTokens: 50,
    models: { gpt: 100, legacy: 50 },
    modelCacheReads: { gpt: 80 },
    modelCacheWrites: { gpt: 0 },
    modelOutputs: { gpt: 10 },
    modelUnclassifiedTokens: { legacy: 50 },
  };
  const overall = normalizeComponents(source);
  const gpt = normalizeComponents(source, "model", "gpt");
  const legacy = normalizeComponents(source, "model", "legacy");
  assert.equal(overall.cacheRead, 80);
  assert.equal(overall.partial, true);
  assert.equal(overall.unclassified, 50);
  assert.equal(gpt.input, 10);
  assert.equal(gpt.cacheRead, 80);
  assert.equal(gpt.cacheRate, 0.8);
  assert.equal(gpt.partial, false);
  assert.equal(legacy.known, false);
  assert.equal(legacy.unclassified, 50);
  assert.equal(legacy.cacheRate, null);
});

test("normalization-generated empty maps cannot make an unknown entity pure input", () => {
  const components = normalizeComponents(
    {
      capabilities: { tokenComponents: false },
      models: { legacy: 100 },
      modelCacheReads: {},
      modelOutputs: {},
      modelUnclassifiedTokens: {},
    },
    "model",
    "legacy",
  );
  assert.equal(components.known, false);
  assert.equal(components.input, 0);
  assert.equal(components.unclassified, 100);
  assert.equal(components.cacheRate, null);
});

test("legacy remainder stays unknown and an inconsistent total suppresses cache percentage", () => {
  const partial = normalizeComponents({
    totalTokens: 100,
    cacheReadTokens: 30,
    outputTokens: 10,
  });
  assert.equal(partial.input, 0);
  assert.equal(partial.unclassified, 60);
  assert.equal(partial.cacheRate, 0.3);
  assert.equal(partial.partial, true);
  const inconsistent = normalizeComponents({
    totalTokens: 100,
    cacheReadTokens: 95,
    outputTokens: 20,
    unclassifiedTokens: 0,
  });
  assert.equal(inconsistent.cacheRead, 95);
  assert.equal(inconsistent.complete, false);
  assert.equal(inconsistent.cacheRate, null);
});

test("explicit zero is known while missing cost or quota use stays unavailable", () => {
  const data = normalizeOverview(
    {
      totals: {
        today: {
          totalTokens: 100,
          capabilities: { tokenComponents: true },
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          unclassifiedTokens: 0,
        },
      },
      limits: [{ provider: "openai", windows: [{ label: "额度" }] }],
    },
    { now: new Date("2026-09-05T00:00:00Z") },
  );
  assert.equal(data.periods.today.components.cacheReadKnown, true);
  assert.equal(data.periods.today.components.cacheRate, 0);
  assert.equal(data.periods.today.costUsd, null);
  assert.equal(data.quotas[0].usedPercent, null);
  assert.equal(data.quotas[0].used, null);
});

test("live adapter preserves independent sessions, subscriptions, and provider states", () => {
  const data = normalizeOverview(
    {
      totals: {},
      sessions: [
        { deviceId: "a", client: "codex", sessionId: "same", tokens: 12 },
        { deviceId: "b", client: "codex", sessionId: "same", tokens: 20 },
      ],
    },
    {
      subscriptions: {
        subscriptions: [
          {
            provider: "openai",
            kind: "topup",
            currency: "EUR",
            topUps: [{ amountMinor: 5000 }, { amountMinor: 1000 }],
          },
        ],
      },
      providers: {
        providers: [{ provider: "openai", status: "degraded", stale: true }],
      },
    },
  );
  assert.notEqual(data.sessions[0].id, data.sessions[1].id);
  assert.equal(data.subscriptions[0].amount, null);
  assert.equal(data.subscriptions[0].currency, "EUR");
  assert.equal(data.subscriptions[0].topUpTotal, 60);
  assert.equal(data.providers[0].status, "degraded");
  assert.equal(data.providers[0].stale, true);
});

test("device status honors the official freshness decision for long upload intervals", () => {
  const data = normalizeOverview(
    {
      totals: {},
      staleAfterMs: 600_000,
      devices: [
        {
          deviceId: "long-interval",
          syncUploadIntervalMs: 1_800_000,
          stale: false,
          receivedAt: "2026-09-05T00:15:00Z",
        },
        {
          deviceId: "expired",
          stale: true,
          receivedAt: "2026-09-05T00:59:00Z",
        },
        {
          deviceId: "legacy",
          syncUploadIntervalMs: 1_800_000,
          receivedAt: "2026-09-05T00:15:00Z",
        },
      ],
    },
    { now: new Date("2026-09-05T01:00:00Z") },
  );
  assert.deepEqual(
    data.devices.map((device) => device.status),
    ["online", "offline", "online"],
  );
});

test("quota account identity, unknown providers, native currency and meter rules survive adaptation", () => {
  const payload = {
    totals: {},
    limits: [
      {
        provider: "openai",
        planLabel: "Pro",
        status: "ok",
        windows: [
          {
            metric: "spend",
            used: 10,
            limit: 20,
            showMeter: false,
            currency: "EUR",
          },
        ],
      },
      {
        provider: "openai",
        planLabel: "Pro",
        status: "ok",
        stale: true,
        windows: [{ metric: "credits", remaining: 42, currency: "USD" }],
      },
      { provider: "anthropic", status: "unauthorized", windows: [] },
    ],
  };
  const data = normalizeOverview(payload);
  assert.equal(data.quotas.length, 3);
  assert.notEqual(data.quotas[0].groupId, data.quotas[1].groupId);
  assert.equal(data.quotas[0].showMeter, false);
  assert.equal(data.quotas[0].currency, "EUR");
  assert.equal(data.quotas[1].stale, true);
  assert.equal(data.quotas[1].remaining, 42);
  assert.equal(data.quotas[2].sourceStatus, "unauthorized");
  assert.equal(data.quotas[2].usedPercent, null);
  assert.deepEqual(
    payload.limits[2].windows,
    [],
    "adapter must not append placeholders to the raw response",
  );
});

test("top-up amounts distinguish absent records from an explicitly empty ledger", () => {
  const data = normalizeOverview(
    { totals: {} },
    {
      subscriptions: {
        subscriptions: [
          { id: "unknown", kind: "topup" },
          { id: "empty", kind: "topup", topUps: [] },
          {
            id: "real",
            kind: "topup",
            topUps: [
              { amountMinor: 7, date: "2026-08-01" },
              { amountMinor: 14, date: "2026-09-01" },
            ],
          },
        ],
      },
    },
  );
  assert.equal(data.subscriptions[0].topUpTotal, null);
  assert.equal(data.subscriptions[1].topUpTotal, 0);
  assert.equal(data.subscriptions[2].topUpTotal, 0.21);
  assert.equal(data.subscriptions[2].latestTopUpAt, "2026-09-01");
  assert.equal(data.subscriptions[2].id, "real");
});

test("unexpected success JSON is rejected instead of presenting an empty healthy dashboard", () => {
  assert.throws(
    () => normalizeOverview({ error: "upstream unavailable" }),
    /格式无法识别/,
  );
});

test("reported negative money remains an amount, while negative token counters stay invalid", () => {
  const data = normalizeOverview({
    totals: { today: { totalTokens: -10, costUsd: -1.25 } },
    limits: [{ provider: "openai", balanceUsd: -2.5 }],
  });
  assert.equal(data.periods.today.totalTokens, 0);
  assert.equal(data.periods.today.costUsd, -1.25);
  assert.equal(data.quotas[0].metric, "balance");
  assert.equal(data.quotas[0].balanceUsd, -2.5);
});

test("sample client × model matrices close to client, model and total amounts for every period", () => {
  const data = createDemoData(new Date("2026-09-05T02:00:00Z"));
  for (const period of Object.values(data.periods)) {
    assert.ok(period.clientModels);
    assert.ok(period.clientModelCosts);
    for (const client of period.clients) {
      assert.equal(
        Object.values(period.clientModels[client.id]).reduce(
          (sum, value) => sum + value,
          0,
        ),
        client.totalTokens,
      );
      assert.equal(
        Object.values(period.clientModelCosts[client.id]).reduce(
          (sum, value) => sum + cents(value),
          0,
        ),
        cents(client.costUsd || 0),
      );
    }
    for (const model of period.models) {
      assert.equal(
        Object.values(period.clientModels).reduce(
          (sum, row) => sum + (row[model.id] || 0),
          0,
        ),
        model.totalTokens,
      );
      assert.equal(
        Object.values(period.clientModelCosts).reduce(
          (sum, row) => sum + cents(row[model.id] || 0),
          0,
        ),
        cents(model.costUsd || 0),
      );
    }
    assert.equal(
      Object.values(period.clientModels)
        .flatMap(Object.values)
        .reduce((sum, value) => sum + value, 0),
      period.totalTokens,
    );
    assert.equal(
      Object.values(period.clientModelCosts)
        .flatMap(Object.values)
        .reduce((sum, value) => sum + cents(value), 0),
      cents(period.costUsd || 0),
    );
  }
});

test("real matrix values are validated without inferring absent or invalid records", () => {
  const absent = normalizePeriod({
    totalTokens: 100,
    clients: { codex: 100 },
    models: { gpt: 100 },
  });
  assert.equal(absent.clientModels, undefined);
  assert.equal(absent.clientModelCosts, undefined);
  const reported = normalizePeriod({
    clientModels: {
      codex: {
        gpt: 10,
        zero: 0,
        invalid: -2,
        string: "10",
        infinity: Infinity,
      },
      invalid: [],
    },
    clientModelCosts: { codex: { gpt: 0.25, credit: -0.1, invalid: NaN } },
  });
  assert.deepEqual(reported.clientModels, { codex: { gpt: 10, zero: 0 } });
  assert.deepEqual(reported.clientModelCosts, {
    codex: { gpt: 0.25, credit: -0.1 },
  });
});

test("device detail preserves reported metadata and explicit client health states", () => {
  const data = normalizeOverview({
    totals: {},
    devices: [
      {
        deviceId: "desktop-1",
        hostname: "Work PC",
        platform: "win32",
        osName: "Windows",
        osVersion: "11 24H2",
        agentVersion: "1.8.2",
        agentRuntime: "desktop",
        syncUploadIntervalMs: 1_200_000,
        projectsEnabled: false,
        historyAvailable: true,
      },
    ],
    period_windows_by_device: { "desktop-1": { timeZone: "Asia/Tokyo" } },
    diagnostics: [
      {
        deviceId: "desktop-1",
        clientHealth: {
          version: 1,
          observedAt: "2026-09-05T01:00:00Z",
          clients: {
            codex: { version: "0.88.0", status: "not-running" },
            claude: { version: "2.1.1", healthy: true },
            custom: { status: "running-ish" },
          },
        },
        clientStatus: { claude: "degraded" },
        wslStatus: "ready",
      },
    ],
  });
  const device = data.devices[0];
  assert.equal(device.osVersion, "11 24H2");
  assert.equal(device.runtime, "desktop");
  assert.equal(device.syncIntervalMs, 1_200_000);
  assert.equal(device.timeZone, "Asia/Tokyo");
  assert.equal(device.projectsEnabled, false);
  assert.equal(device.historyAvailable, true);
  assert.deepEqual(
    device.clientHealth?.map(({ name, level }) => [name, level]),
    [
      ["codex", "error"],
      ["claude", "warning"],
      ["custom", "unknown"],
    ],
  );
  assert.equal(device.clientHealth?.[0].observedAt, "2026-09-05T01:00:00Z");
  assert.equal(device.wslStatus, "ready");
});

test("account and subscription detail survives adaptation without exposing full account identities", () => {
  const source = {
    totals: {},
    limits: [
      {
        provider: "openai",
        accountLabel: "工作账户",
        accountName: "研究组",
        accountEmail: "reviewer@example.invalid",
        device: "Work PC",
        balance: { remaining: 42.5 },
        windows: [
          { name: "五小时", remaining: 88, limit: 100, metric: "credits" },
          {
            window: "月度",
            metric: "spend",
            used: 2.75,
            limit: 50,
            showMeter: false,
          },
        ],
      },
    ],
  };
  const data = normalizeOverview(source, {
    subscriptions: {
      updated_at: "2026-09-05T03:00:00Z",
      subscriptions: [
        {
          id: "sub",
          provider: "openai",
          startDate: "2025-08-01",
          nextRenewalOverride: "2026-09-01",
          binding: {
            profileName: "工作配置",
            accountEmail: "reviewer@example.invalid",
            accountKey: "account-1234567890",
          },
          topUps: [
            { title: "补充包", createdAt: "2026-08-08", amountMinor: 1750 },
            { label: "未知金额", date: "2026-08-10" },
          ],
        },
      ],
    },
  });
  assert.equal(
    data.quotas[0].account,
    "工作账户 · 研究组 · re***@example.invalid",
  );
  assert.equal(data.quotas[0].balance, 42.5);
  assert.equal(data.quotas[0].sourceDevice, "Work PC");
  assert.deepEqual(
    data.quotas.map((q) => q.label),
    ["五小时", "月度"],
  );
  assert.equal(data.subscriptionsUpdatedAt, "2026-09-05T03:00:00Z");
  assert.equal(data.subscriptions[0].startDate, "2025-08-01");
  assert.equal(
    data.subscriptions[0].binding,
    "工作配置 · re***@example.invalid · accoun…",
  );
  assert.deepEqual(
    data.subscriptions[0].topUps?.map((t) => [t.label, t.date, t.amount]),
    [
      ["补充包", "2026-08-08", 17.5],
      ["未知金额", "2026-08-10", null],
    ],
  );
  assert.equal(data.subscriptions[0].topUpTotal, null);
  assert.equal(data.subscriptions[0].latestTopUpAt, "2026-08-10");
  assert.equal(source.limits[0].accountEmail, "reviewer@example.invalid");
  assert.ok(!JSON.stringify(data).includes("account-1234567890"));
  assert.ok(!JSON.stringify(data).includes("reviewer@example.invalid"));
});
