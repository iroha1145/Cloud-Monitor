import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeComponents,
  normalizeOverview,
  summarizeTrend,
} from "../src/data.ts";

const completeDay = (
  day: string,
  total: number,
  cacheRead: number,
  costUsd: number | null = null,
) => ({
  day,
  total,
  outputTokens: 0,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: 0,
  unclassifiedTokens: 0,
  costUsd,
});
const trendFrom = (trend: unknown[]) =>
  normalizeOverview({ totals: {}, trend }).trend;

test("range cache ratio weights known daily counts instead of averaging percentages", () => {
  const trend = trendFrom([
    completeDay("2026-09-04", 100, 80, 0.25),
    completeDay("2026-09-05", 300, 30, 0.75),
  ]);
  assert.deepEqual(summarizeTrend(trend), {
    tokenTotal: 400,
    hasCost: true,
    allCosts: true,
    costTotal: 1,
    cacheDays: 2,
    cacheSkippedDays: 0,
    cacheTokenTotal: 400,
    cacheTotal: 110,
    cacheRate: 0.275,
    partialCache: false,
  });
  assert.notEqual(summarizeTrend(trend).cacheRate, (0.8 + 0.1) / 2);
});

test("30 days with 15 valid cache records use only those 15 days in both sums", () => {
  const rows = Array.from({ length: 30 }, (_, index) => {
    const day = `2026-09-${String(index + 1).padStart(2, "0")}`;
    return index < 15
      ? completeDay(
          day,
          (index + 1) * 100,
          (index + 1) * (index < 5 ? 80 : 20),
          1,
        )
      : { day, total: 1000, costUsd: 1 };
  });
  const summary = summarizeTrend(trendFrom(rows));
  assert.deepEqual(summary, {
    tokenTotal: 27000,
    hasCost: true,
    allCosts: true,
    costTotal: 30,
    cacheDays: 15,
    cacheSkippedDays: 15,
    cacheTokenTotal: 12000,
    cacheTotal: 3300,
    cacheRate: 0.275,
    partialCache: false,
  });
  assert.notEqual(summary.cacheRate, 3300 / 27000);
  assert.notEqual(summary.cacheRate, (5 * 0.8 + 10 * 0.2) / 15);
});

test("an explicitly zero day contributes zero without invalidating nonzero days", () => {
  const trend = trendFrom([
    completeDay("2026-09-04", 100, 80),
    completeDay("2026-09-05", 0, 0),
  ]);
  assert.equal(trend[1].components?.known, true);
  assert.equal(trend[1].components?.cacheReadKnown, true);
  assert.equal(trend[1].components?.inputKnown, true);
  assert.equal(trend[1].components?.outputKnown, true);
  assert.equal(trend[1].components?.complete, true);
  assert.equal(trend[1].components?.cacheRate, null);
  assert.equal(summarizeTrend(trend).cacheTotal, 80);
  assert.equal(summarizeTrend(trend).cacheRate, 0.8);
  assert.equal(summarizeTrend(trend).cacheDays, 2);
  assert.equal(summarizeTrend(trend).cacheSkippedDays, 0);
  assert.equal(summarizeTrend(trend).cacheTokenTotal, 100);
  assert.equal(summarizeTrend([trend[1]]).cacheTotal, 0);
  assert.equal(summarizeTrend([trend[1]]).cacheRate, null);
});

test("missing or invalid daily totals never become proven zero contributions", () => {
  const missingTotal = normalizeComponents({
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    unclassifiedTokens: 0,
  });
  assert.equal(missingTotal.known, false);
  for (const total of [undefined, null, -1, Infinity, NaN, "0", false]) {
    const row = { ...completeDay("2026-09-05", 0, 0), total };
    const trend = trendFrom([completeDay("2026-09-04", 100, 80), row]);
    assert.equal(trend[1].zeroUsageConfirmed, false);
    assert.equal(trend[1].components?.known, false);
    assert.equal(summarizeTrend(trend).cacheTotal, 80);
    assert.equal(summarizeTrend(trend).cacheRate, 0.8);
    assert.equal(summarizeTrend(trend).cacheDays, 1);
    assert.equal(summarizeTrend(trend).cacheSkippedDays, 1);
    assert.equal(summarizeTrend(trend).cacheTokenTotal, 100);
    assert.equal(summarizeTrend([trend[1]]).cacheRate, null);
  }
});

test("proven zero totals allow a range ratio without inventing missing daily components", () => {
  for (const row of [
    { day: "2026-09-05", total: 0 },
    {
      day: "2026-09-05",
      total: 0,
      outputTokens: 0,
      cacheReadTokens: null,
      cacheWriteTokens: 0,
      unclassifiedTokens: 0,
    },
    {
      day: "2026-09-05",
      total: 0,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      unclassifiedTokens: 0,
      tokenComponentsAvailable: false,
      componentsPartial: true,
    },
  ]) {
    const trend = trendFrom([completeDay("2026-09-04", 100, 80), row]);
    const zero = trend[1];
    assert.equal(zero.zeroUsageConfirmed, true);
    assert.equal(zero.components?.known ?? false, false);
    assert.equal(zero.components?.cacheReadKnown ?? false, false);
    assert.equal(zero.components?.cacheRate ?? null, null);
    assert.equal(summarizeTrend(trend).cacheTotal, 80);
    assert.equal(summarizeTrend(trend).cacheRate, 0.8);
    assert.equal(summarizeTrend(trend).cacheDays, 2);
    assert.equal(summarizeTrend(trend).cacheSkippedDays, 0);
    assert.equal(summarizeTrend(trend).cacheTokenTotal, 100);
    assert.equal(summarizeTrend([zero]).cacheTotal, 0);
    assert.equal(summarizeTrend([zero]).cacheRate, null);
  }
});

test("zero totals with positive or invalid components cannot bypass range validation", () => {
  for (const field of [
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "unclassifiedTokens",
  ]) {
    for (const value of [1, -1, Infinity, -Infinity, NaN, "0", false]) {
      const row = { ...completeDay("2026-09-05", 0, 0), [field]: value };
      const trend = trendFrom([completeDay("2026-09-04", 100, 80), row]);
      assert.equal(trend[1].zeroUsageConfirmed, false);
      assert.equal(summarizeTrend(trend).cacheTotal, 80);
      assert.equal(summarizeTrend(trend).cacheRate, 0.8);
      assert.equal(summarizeTrend(trend).cacheDays, 1);
      assert.equal(summarizeTrend(trend).cacheSkippedDays, 1);
      assert.equal(summarizeTrend([trend[1]]).cacheRate, null);
    }
  }
});

test("malformed components on a positive day are skipped before zero normalization", () => {
  for (const field of [
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "unclassifiedTokens",
  ]) {
    for (const value of [-1, Infinity, -Infinity, NaN, "0", false]) {
      const row = { ...completeDay("2026-09-05", 300, 60), [field]: value };
      const trend = trendFrom([completeDay("2026-09-04", 100, 80), row]);
      assert.equal(trend[1].components, null);
      const summary = summarizeTrend(trend);
      assert.equal(summary.tokenTotal, 400);
      assert.equal(summary.cacheDays, 1);
      assert.equal(summary.cacheSkippedDays, 1);
      assert.equal(summary.cacheTokenTotal, 100);
      assert.equal(summary.cacheTotal, 80);
      assert.equal(summary.cacheRate, 0.8);
      assert.equal(summarizeTrend([trend[1]]).cacheRate, null);
    }
  }
});

test("an explicit zero cache count yields zero percent on a positive known total", () => {
  const trend = trendFrom([
    completeDay("2026-09-04", 100, 0),
    { day: "2026-09-05", total: 300 },
  ]);
  assert.equal(trend[0].components?.cacheReadKnown, true);
  assert.equal(trend[0].components?.cacheRate, 0);
  assert.equal(summarizeTrend(trend).cacheRate, 0);
  assert.equal(summarizeTrend(trend).cacheDays, 1);
  assert.equal(summarizeTrend(trend).cacheSkippedDays, 1);
  assert.equal(summarizeTrend(trend).cacheTokenTotal, 100);
  assert.equal(summarizeTrend(trend).cacheTotal, 0);
});

test("a recorded daily cache zero participates even when all usage is unclassified", () => {
  const row = {
    ...completeDay("2026-09-05", 100, 0),
    unclassifiedTokens: 100,
    tokenComponentsAvailable: false,
    componentsPartial: true,
  };
  const trend = trendFrom([completeDay("2026-09-04", 100, 80), row]);
  const parts = trend[1].components!;
  assert.equal(parts.known, true);
  assert.equal(parts.cacheReadKnown, true);
  assert.equal(parts.cacheRate, 0);
  assert.equal(parts.inputKnown, false);
  assert.equal(parts.unclassified, 100);
  assert.equal(parts.partial, true);
  const summary = summarizeTrend(trend);
  assert.equal(summary.cacheDays, 2);
  assert.equal(summary.cacheSkippedDays, 0);
  assert.equal(summary.cacheTokenTotal, 200);
  assert.equal(summary.cacheTotal, 80);
  assert.equal(summary.cacheRate, 0.4);
  assert.equal(summary.partialCache, true);

  const zeroOnly = summarizeTrend([trend[1]]);
  assert.equal(zeroOnly.cacheDays, 1);
  assert.equal(zeroOnly.cacheRate, 0);
  assert.equal(zeroOnly.partialCache, true);

  // Opting into the daily provenance rule must not reinterpret defaults from
  // unknown periods or per-model maps as recorded zero-cache observations.
  const period = normalizeComponents({ ...row, totalTokens: 100 });
  assert.equal(period.known, false);
  assert.equal(period.cacheReadKnown, false);
  assert.equal(period.cacheRate, null);
  const model = normalizeComponents(
    {
      capabilities: { tokenComponents: false },
      models: { legacy: 100 },
      modelOutputs: { legacy: 0 },
      modelCacheReads: { legacy: 0 },
      modelCacheWrites: { legacy: 0 },
      modelUnclassifiedTokens: { legacy: 100 },
    },
    "model",
    "legacy",
  );
  assert.equal(model.known, false);
  assert.equal(model.cacheReadKnown, false);
  assert.equal(model.cacheRate, null);
});

test("a daily explicit cache zero participates while unspecified components remain unknown", () => {
  const trend = trendFrom([
    completeDay("2026-09-04", 100, 80),
    { day: "2026-09-05", total: 100, cacheReadTokens: 0 },
  ]);
  assert.equal(trend[1].components?.cacheReadKnown, true);
  assert.equal(trend[1].components?.cacheRate, 0);
  assert.equal(trend[1].components?.inputKnown, false);
  assert.equal(trend[1].components?.outputKnown, false);
  assert.equal(trend[1].components?.cacheWriteKnown, false);
  assert.equal(trend[1].components?.unclassified, 100);
  assert.equal(summarizeTrend(trend).cacheDays, 2);
  assert.equal(summarizeTrend(trend).cacheSkippedDays, 0);
  assert.equal(summarizeTrend(trend).cacheTokenTotal, 200);
  assert.equal(summarizeTrend(trend).cacheRate, 0.4);
  assert.equal(summarizeTrend(trend).partialCache, true);
});

test("all missing cache days retain range tokens and fees but no cache ratio", () => {
  const summary = summarizeTrend(
    trendFrom([
      { day: "2026-09-04", total: 100, costUsd: 0.5 },
      {
        day: "2026-09-05",
        total: 300,
        costUsd: 1,
        cacheReadTokens: null,
        outputTokens: null,
        cacheWriteTokens: null,
        unclassifiedTokens: 300,
        componentsPartial: true,
      },
    ]),
  );
  assert.deepEqual(summary, {
    tokenTotal: 400,
    hasCost: true,
    allCosts: true,
    costTotal: 1.5,
    cacheDays: 0,
    cacheSkippedDays: 2,
    cacheTokenTotal: 0,
    cacheTotal: null,
    cacheRate: null,
    partialCache: false,
  });
});

test("a range of confirmed zero-usage days has zero cache counts but no 0/0 ratio", () => {
  const summary = summarizeTrend(
    trendFrom([
      completeDay("2026-09-04", 0, 0),
      { day: "2026-09-05", total: 0, unclassifiedTokens: 0 },
    ]),
  );
  assert.equal(summary.cacheDays, 2);
  assert.equal(summary.cacheSkippedDays, 0);
  assert.equal(summary.cacheTokenTotal, 0);
  assert.equal(summary.cacheTotal, 0);
  assert.equal(summary.cacheRate, null);
});

test("unknown cached days are excluded from the cache numerator and denominator", () => {
  const known = completeDay("2026-09-04", 100, 80);
  for (const missing of [
    { day: "2026-09-05", total: 300 },
    {
      day: "2026-09-05",
      total: 300,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      unclassifiedTokens: 300,
    },
    {
      day: "2026-09-05",
      total: 300,
      outputTokens: 30,
      cacheReadTokens: null,
      cacheWriteTokens: 0,
      unclassifiedTokens: 270,
    },
  ]) {
    const trend = trendFrom([known, missing]);
    assert.equal(trend[0].components?.cacheRate, 0.8);
    assert.equal(trend[1].components?.cacheReadKnown ?? false, false);
    assert.equal(summarizeTrend(trend).tokenTotal, 400);
    assert.equal(summarizeTrend(trend).cacheTotal, 80);
    assert.equal(summarizeTrend(trend).cacheTokenTotal, 100);
    assert.equal(summarizeTrend(trend).cacheRate, 0.8);
    assert.equal(summarizeTrend(trend).cacheDays, 1);
    assert.equal(summarizeTrend(trend).cacheSkippedDays, 1);
    assert.equal(summarizeTrend(trend).partialCache, false);
  }
});

test("known partial cache uses each participating day's full total and retains its partial label", () => {
  const trend = trendFrom([
    {
      day: "2026-09-04",
      total: 150,
      outputTokens: 10,
      cacheReadTokens: 80,
      cacheWriteTokens: 0,
      unclassifiedTokens: 50,
    },
    completeDay("2026-09-05", 50, 20),
  ]);
  assert.equal(trend[0].components?.cacheReadKnown, true);
  assert.equal(trend[0].components?.partial, true);
  assert.equal(summarizeTrend(trend).cacheTotal, 100);
  assert.equal(summarizeTrend(trend).cacheRate, 0.5);
  assert.equal(summarizeTrend(trend).partialCache, true);
});

test("backend availability markers preserve partial counts and missing input/output details", () => {
  const trend = trendFrom([
    {
      day: "2026-09-03",
      total: 200,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      unclassifiedTokens: 200,
      tokenComponentsAvailable: false,
      componentsPartial: true,
    },
    {
      day: "2026-09-04",
      total: 200,
      outputTokens: 40,
      cacheReadTokens: 60,
      cacheWriteTokens: 0,
      unclassifiedTokens: 100,
      tokenComponentsAvailable: false,
      componentsPartial: true,
    },
    {
      day: "2026-09-05",
      total: 200,
      outputTokens: null,
      cacheReadTokens: 60,
      cacheWriteTokens: null,
      unclassifiedTokens: 140,
      tokenComponentsAvailable: false,
      componentsPartial: true,
    },
  ]);
  const unknown = trend[0].components!;
  assert.equal(unknown.known, false);
  assert.equal(unknown.inputKnown, false);
  assert.equal(unknown.outputKnown, false);
  assert.equal(unknown.cacheReadKnown, false);
  assert.equal(unknown.cacheWriteKnown, false);
  assert.equal(unknown.unclassified, 200);
  assert.equal(unknown.cacheRate, null);
  const partial = trend[1].components!;
  assert.equal(partial.known, true);
  assert.equal(partial.partial, true);
  assert.equal(partial.cacheRate, 0.3);
  assert.equal(partial.outputKnown, true);
  assert.equal(partial.output, 40);
  assert.equal(partial.inputKnown, false);
  const missingOutput = trend[2].components!;
  assert.equal(missingOutput.outputKnown, false);
  assert.equal(missingOutput.inputKnown, false);
  assert.equal(missingOutput.cacheWriteKnown, false);
  assert.equal(missingOutput.cacheReadKnown, true);
  assert.equal(missingOutput.cacheRate, 0.3);
  assert.equal(summarizeTrend(trend.slice(1)).partialCache, true);
  assert.equal(summarizeTrend(trend.slice(1)).cacheRate, 0.3);
  assert.equal(summarizeTrend(trend).cacheRate, 0.3);
  assert.equal(summarizeTrend(trend).cacheDays, 2);
  assert.equal(summarizeTrend(trend).cacheSkippedDays, 1);
  assert.equal(summarizeTrend(trend).cacheTokenTotal, 400);
  assert.equal(summarizeTrend(trend).partialCache, true);
});

test("a source partial marker remains partial even when its provided counters close", () => {
  const trend = trendFrom([
    {
      ...completeDay("2026-09-05", 100, 80),
      tokenComponentsAvailable: false,
      componentsPartial: true,
    },
  ]);
  assert.equal(trend[0].components?.complete, true);
  assert.equal(trend[0].components?.partial, true);
  assert.equal(summarizeTrend(trend).partialCache, true);
});

test("a daily ratio rejected by validation cannot become an interval ratio over 100 percent", () => {
  const trend = trendFrom([completeDay("2026-09-05", 100, 101)]);
  // Existing closure tolerance is deliberately insufficient to validate a ratio.
  assert.equal(trend[0].components?.complete, true);
  assert.equal(trend[0].components?.cacheRate, null);
  assert.equal(summarizeTrend(trend).cacheTotal, null);
  assert.equal(summarizeTrend(trend).cacheRate, null);
  const mixed = trendFrom([
    completeDay("2026-09-04", 1000, 400),
    completeDay("2026-09-05", 100, 101),
  ]);
  assert.equal(summarizeTrend(mixed).cacheRate, 0.4);
  assert.equal(summarizeTrend(mixed).cacheDays, 1);
  assert.equal(summarizeTrend(mixed).cacheSkippedDays, 1);
  assert.equal(summarizeTrend(mixed).cacheTokenTotal, 1000);
  assert.equal(summarizeTrend(mixed).cacheTotal, 400);
});

test("inconsistent zero or positive component totals cannot be accepted as known cache", () => {
  for (const row of [
    completeDay("2026-09-05", 0, 1),
    { ...completeDay("2026-09-05", 100, 80), outputTokens: 40 },
  ])
    assert.equal(summarizeTrend(trendFrom([row])).cacheRate, null);
});

test("current-period changes never replace missing historical components or change known days", () => {
  const trend = [
    completeDay("2026-09-04", 100, 40),
    { day: "2026-09-05", total: 100 },
  ];
  const first = normalizeOverview({
    totals: {
      today: {
        totalTokens: 1000,
        cacheReadTokens: 928,
        outputTokens: 72,
        cacheWriteTokens: 0,
        unclassifiedTokens: 0,
      },
    },
    trend,
  });
  const second = normalizeOverview({
    totals: {
      today: {
        totalTokens: 1000,
        cacheReadTokens: 100,
        outputTokens: 900,
        cacheWriteTokens: 0,
        unclassifiedTokens: 0,
      },
    },
    trend,
  });
  assert.notEqual(
    first.periods.today.components.cacheRate,
    second.periods.today.components.cacheRate,
  );
  assert.deepEqual(first.trend, second.trend);
  assert.equal(first.trend[0].components?.cacheRate, 0.4);
  assert.equal(first.trend[1].components, null);
  assert.equal(summarizeTrend(first.trend).cacheRate, 0.4);
  assert.equal(summarizeTrend(first.trend).cacheSkippedDays, 1);
});

test("same-day archive components require the matching total and cannot override explicit unknown fields", () => {
  const data = normalizeOverview(
    {
      totals: {},
      trend: [
        { day: "2026-09-03", total: 100 },
        { day: "2026-09-04", total: 100 },
        {
          day: "2026-09-05",
          total: 100,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          unclassifiedTokens: 100,
        },
      ],
    },
    {
      history: {
        items: [
          {
            day: "2026-09-03",
            tokens: 100,
            outputTokens: 10,
            cacheReadTokens: 80,
            cacheWriteTokens: 0,
            unclassifiedTokens: 0,
          },
          {
            day: "2026-09-04",
            tokens: 200,
            outputTokens: 10,
            cacheReadTokens: 180,
            cacheWriteTokens: 0,
            unclassifiedTokens: 0,
          },
          {
            day: "2026-09-05",
            tokens: 100,
            outputTokens: 10,
            cacheReadTokens: 80,
            cacheWriteTokens: 0,
            unclassifiedTokens: 0,
          },
        ],
      },
    },
  );
  assert.equal(data.trend[0].components?.cacheRate, 0.8);
  assert.equal(data.trend[1].components, null);
  assert.equal(data.trend[2].components?.cacheReadKnown, false);
  assert.equal(data.trend[2].components?.cacheRate, null);
});

test("empty ranges and partly missing fees preserve unavailable state and negative adjustments", () => {
  assert.deepEqual(summarizeTrend([]), {
    tokenTotal: 0,
    hasCost: false,
    allCosts: false,
    costTotal: null,
    cacheDays: 0,
    cacheSkippedDays: 0,
    cacheTokenTotal: 0,
    cacheTotal: null,
    cacheRate: null,
    partialCache: false,
  });
  const summary = summarizeTrend(
    trendFrom([
      completeDay("2026-09-03", 100, 50, -0.25),
      completeDay("2026-09-04", 100, 50, 0),
      completeDay("2026-09-05", 100, 50),
    ]),
  );
  assert.equal(summary.costTotal, -0.25);
  assert.equal(summary.hasCost, true);
  assert.equal(summary.allCosts, false);
});
