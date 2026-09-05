"use strict";

// Exercise the production frontend helpers against the vendored Hub's actual
// normalization and aggregation. Fixtures are synthetic and need no server,
// upstream checkout, credentials, or user usage records.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const {
  aggregateDevices, extractUsageFromTokscale, normalizePeriod,
} = require("../../tm-core/vendor/src/shared/usage.js");

const frontendPath = path.join(__dirname, "..", "tm.js");
const source = fs.readFileSync(frontendPath, "utf8");
const segments = source.match(/const SEGS = \[[\s\S]*?\n\];/);
const helperStart = source.indexOf("function componentBreakdown(");
const helperEnd = source.indexOf("/* ================= 渲染层", helperStart);
assert.ok(segments && helperStart >= 0 && helperEnd > helperStart,
  "Production component helpers and segment definitions must be present");
const frontend = { state: {} };
vm.createContext(frontend);
vm.runInContext(segments[0] + "\n" + source.slice(helperStart, helperEnd), frontend, {
  filename: frontendPath,
  timeout: 1000,
});

const NOW = Date.parse("2026-09-05T12:00:00Z");
const PERIODS = ["today", "month", "allTime"];
const CODEX_MODEL = "gpt-6-astra";
const CURSOR_MODEL = "cursor-unknown";

function device(id, period) {
  return {
    deviceId: id,
    hostname: id,
    updatedAt: new Date(NOW).toISOString(),
    ...Object.fromEntries(PERIODS.map((name) => [name, structuredClone(period)])),
  };
}

function nativePeriod() {
  return extractUsageFromTokscale({ entries: [
    { client: "codex", model: CODEX_MODEL, input: 20, output: 15, reasoning: 5, cacheRead: 65, cacheWrite: 0 },
    { client: "claude", model: "claude-opus-4.6", input: 10, output: 10, cacheRead: 30, cacheWrite: 0 },
  ] });
}

function cursorPeriod(model = CURSOR_MODEL) {
  // Cursor may provide the output count without identifying how much input
  // was cached. Its unknown input must not erase another model's known cache.
  return normalizePeriod({
    capabilities: { tokenComponents: false },
    totalTokens: 30,
    outputTokens: 10,
    unclassifiedTokens: 20,
    clients: { cursor: 30 },
    clientOutputs: { cursor: 10 },
    clientUnclassifiedTokens: { cursor: 20 },
    models: { [model]: 30 },
    modelOutputs: { [model]: 10 },
    modelUnclassifiedTokens: { [model]: 20 },
    clientModels: { cursor: { [model]: 30 } },
  });
}

function aggregate(...periods) {
  return aggregateDevices(periods.map((period, index) => device(`device-${index}`, period)), undefined, NOW).periods;
}

function assertSegments(breakdown, expected) {
  assert.equal(breakdown.known, true, "Known counters must remain available to the renderer");
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "unclassified"]) {
    assert.equal(frontend.segValue(breakdown, key), expected[key] || 0, `${key} counter`);
  }
  assert.equal(breakdown.segs.reduce((sum, segment) => sum + segment.value, 0), breakdown.total,
    "Classified and unknown segments must account for the total exactly");
}

for (const periodName of PERIODS) {
  test(`${periodName}: another model's unknown input does not hide known model or client cache`, () => {
    const period = aggregate(nativePeriod(), cursorPeriod())[periodName];
    assert.equal(period.capabilities.tokenComponents, false, "Fixture must reproduce the period-wide incomplete flag");
    assert.equal(period.modelCacheReads[CODEX_MODEL], 65, "Hub must preserve the model cache counter");
    for (const [type, name] of [["model", CODEX_MODEL], ["client", "codex"]]) {
      const breakdown = frontend.componentBreakdown(period, type, name);
      assertSegments(breakdown, { input: 20, output: 15, cacheRead: 65 });
      assert.equal(breakdown.complete, true);
      assert.equal(breakdown.capable, false, "Entity display must not upgrade the period capability flag");
      assert.equal(breakdown.partial, false, "The unrelated unknown model must not make Codex partial");
      assert.equal(frontend.cacheHitRate(breakdown), 0.65);
    }
    const cursor = frontend.componentBreakdown(period, "model", CURSOR_MODEL);
    assertSegments(cursor, {
      output: 10, unclassified: 20,
    });
    assert.equal(cursor.partial, true);
    assert.equal(frontend.cacheHitRate(cursor), null, "Unreported Cursor cache must not be shown as zero");
  });

  test(`${periodName}: overview retains known counters while the period has unknown usage`, () => {
    const period = aggregate(nativePeriod(), cursorPeriod())[periodName];
    assert.equal(period.totalTokens, 180);
    assertSegments(frontend.componentBreakdown(period), {
      input: 30, output: 35, cacheRead: 95, unclassified: 20,
    });
  });

  test(`${periodName}: the same model across devices retains both known cache and unknown input`, () => {
    const period = aggregate(nativePeriod(), cursorPeriod(CODEX_MODEL))[periodName];
    assert.equal(period.models[CODEX_MODEL], 130);
    assert.equal(period.modelCacheReads[CODEX_MODEL], 65);
    const sharedModel = frontend.componentBreakdown(period, "model", CODEX_MODEL);
    assertSegments(sharedModel, {
      input: 20, output: 25, cacheRead: 65, unclassified: 20,
    });
    assert.equal(sharedModel.partial, true);
    assert.equal(frontend.cacheHitRate(sharedModel), 0.5, "Identified cache share keeps the full model denominator");
    assertSegments(frontend.componentBreakdown(period, "model", "claude-opus-4.6"), {
      input: 10, output: 10, cacheRead: 30,
    });
  });
}

test("partial counters without an explicit unknown split keep the remainder unclassified", () => {
  const period = {
    capabilities: { tokenComponents: false },
    totalTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 65,
    models: { [CODEX_MODEL]: 100 },
    modelOutputs: { [CODEX_MODEL]: 10 },
    modelCacheReads: { [CODEX_MODEL]: 65 },
  };
  for (const [type, name] of [[undefined, undefined], ["model", CODEX_MODEL]]) {
    assertSegments(frontend.componentBreakdown(period, type, name), {
      output: 10, cacheRead: 65, unclassified: 25,
    });
  }
});

test("an explicit zero unknown split preserves a known zero cache reading", () => {
  const period = {
    capabilities: { tokenComponents: false },
    models: { [CODEX_MODEL]: 100 },
    modelOutputs: { [CODEX_MODEL]: 10 },
    modelCacheReads: { [CODEX_MODEL]: 0 },
    modelCacheWrites: { [CODEX_MODEL]: 0 },
    modelUnclassifiedTokens: { [CODEX_MODEL]: 0 },
  };
  const breakdown = frontend.componentBreakdown(period, "model", CODEX_MODEL);
  assertSegments(breakdown, { input: 90, output: 10 });
  assert.equal(frontend.cacheHitRate(breakdown), 0);
});

test("a total-only legacy record stays unknown after Hub normalization", () => {
  const period = normalizePeriod({ totalTokens: 100, models: { [CODEX_MODEL]: 100 } });
  assert.equal(period.unclassifiedTokens, 100);
  assert.equal(period.modelUnclassifiedTokens[CODEX_MODEL], 100);
  for (const [type, name] of [[undefined, undefined], ["model", CODEX_MODEL]]) {
    const breakdown = frontend.componentBreakdown(period, type, name);
    assert.equal(breakdown.known, false);
    assert.equal(frontend.cacheHitRate(breakdown), null);
    assert.equal(frontend.segValue(breakdown, "input"), 0);
  }
});

test("missing counters or cost-only metadata never imply a zero cache rate", () => {
  for (const capable of [true, false]) {
    const period = {
      capabilities: { tokenComponents: capable },
      totalTokens: 100,
      costUsd: 3,
      models: { [CODEX_MODEL]: 100 },
      modelCosts: { [CODEX_MODEL]: 3 },
    };
    for (const [type, name] of [[undefined, undefined], ["model", CODEX_MODEL]]) {
      const breakdown = frontend.componentBreakdown(period, type, name);
      assert.equal(breakdown.known, false);
      assert.equal(frontend.cacheHitRate(breakdown), null);
    }
  }
});

test("empty normalized entity maps cannot turn total-only or cost-only models into non-cache input", () => {
  // Other models can supply period components, so the period capability alone
  // cannot prove that this model's total has a known composition.
  const period = normalizePeriod({
    capabilities: { tokenComponents: true },
    totalTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 65,
    models: { "cost-only-model": 100 },
    modelCosts: { "cost-only-model": 3 },
  });
  for (const key of ["modelOutputs", "modelCacheReads", "modelCacheWrites", "modelUnclassifiedTokens"]) {
    assert.equal(Object.keys(period[key]).length, 0, `${key} must be sparse in the fixture`);
  }
  const breakdown = frontend.componentBreakdown(period, "model", "cost-only-model");
  assert.equal(breakdown.known, false);
  assert.equal(frontend.segValue(breakdown, "input"), 0);
  assert.equal(frontend.cacheHitRate(breakdown), null);
});

test("an explicit all-zero split can identify pure non-cache input", () => {
  const period = {
    capabilities: { tokenComponents: false },
    models: { [CODEX_MODEL]: 100 },
    modelOutputs: { [CODEX_MODEL]: 0 },
    modelCacheReads: { [CODEX_MODEL]: 0 },
    modelCacheWrites: { [CODEX_MODEL]: 0 },
    modelUnclassifiedTokens: { [CODEX_MODEL]: 0 },
  };
  const breakdown = frontend.componentBreakdown(period, "model", CODEX_MODEL);
  assertSegments(breakdown, { input: 100 });
  assert.equal(breakdown.partial, false);
  assert.equal(frontend.cacheHitRate(breakdown), 0);
});

test("a complete model's sparse zero cache counter differs from a missing cache map", () => {
  const period = normalizePeriod({
    capabilities: { tokenComponents: true },
    totalTokens: 100,
    outputTokens: 10,
    models: { [CODEX_MODEL]: 100 },
    modelOutputs: { [CODEX_MODEL]: 10 },
  });
  let breakdown = frontend.componentBreakdown(period, "model", CODEX_MODEL);
  assertSegments(breakdown, { input: 90, output: 10 });
  assert.equal(frontend.cacheHitRate(breakdown), 0);
  delete period.modelCacheReads;
  breakdown = frontend.componentBreakdown(period, "model", CODEX_MODEL);
  assert.equal(frontend.cacheHitRate(breakdown), null, "Absent cache map is not an explicit zero counter");
});

test("inconsistent component totals never produce an impossible cache rate", () => {
  const breakdown = frontend.componentBreakdown({
    capabilities: { tokenComponents: true },
    totalTokens: 100,
    cacheReadTokens: 120,
    outputTokens: 10,
    unclassifiedTokens: 0,
  });
  assert.equal(breakdown.known, true, "Reported counters remain inspectable even when inconsistent");
  assert.equal(breakdown.complete, false);
  assert.equal(frontend.cacheHitRate(breakdown), null);
});

test("ordinary complete components keep the existing cache-share denominator", () => {
  const period = aggregate(nativePeriod()).today;
  assert.equal(period.capabilities.tokenComponents, true);
  const breakdown = frontend.componentBreakdown(period, "model", CODEX_MODEL);
  assertSegments(breakdown, { input: 20, output: 15, cacheRead: 65 });
  assert.equal(frontend.cacheHitRate(breakdown), 0.65,
    "The dashboard displays cached tokens divided by all tokens, including output");
});
