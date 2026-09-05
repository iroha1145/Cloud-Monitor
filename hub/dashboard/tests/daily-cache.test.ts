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
    cacheTotal: 110,
    cacheRate: 0.275,
    partialCache: false,
  });
  assert.notEqual(summarizeTrend(trend).cacheRate, (0.8 + 0.1) / 2);
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
    assert.equal(summarizeTrend(trend).cacheTotal, null);
    assert.equal(summarizeTrend(trend).cacheRate, null);
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
      assert.equal(summarizeTrend(trend).cacheTotal, null);
      assert.equal(summarizeTrend(trend).cacheRate, null);
    }
  }
});

test("an explicit zero cache count yields zero percent on a positive known total", () => {
  const trend = trendFrom([completeDay("2026-09-05", 100, 0)]);
  assert.equal(trend[0].components?.cacheReadKnown, true);
  assert.equal(trend[0].components?.cacheRate, 0);
  assert.equal(summarizeTrend(trend).cacheRate, 0);
});

test("unknown cached days cannot silently contribute zero to a full-range ratio", () => {
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
    assert.equal(summarizeTrend(trend).cacheTotal, null);
    assert.equal(summarizeTrend(trend).cacheRate, null);
  }
});

test("known partial cache is divided by all tokens and retains its partial label", () => {
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
  assert.equal(summarizeTrend(trend).cacheRate, null);
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
  assert.equal(summarizeTrend(mixed).cacheRate, null);
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
  assert.equal(summarizeTrend(first.trend).cacheRate, null);
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
