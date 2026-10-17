import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createDemoData, normalizeOverview, normalizePeriod } from "../src/data.ts";
import { outputTokensPerSecond, sessionModelUsage, sessionUsageDetails, sessionsForPeriod, sessionPeriodDetails } from "../src/session-details.ts";
import { modelUsageDetails, sessionsForModel } from "../src/model-details.ts";

const row = { zeroValuesUnconfirmed: false, deviceId: "a", client: "codex", sessionId: "real-id", tokens: 170,
  inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 0, reasoningTokens: 15,
  messageCount: 2, models: { "model-a": 100, "model-b": 70 }, modelCosts: { "model-a": 0.1 },
  timedOutputTokens: 50, timedDurationMs: 2500, contextTokens: 120, contextWindow: 200000 };

test("session adapter keeps synchronized counters and independent periods without inventing local details", () => {
  const data = normalizeOverview({totals: {},  sessions: [row], sessions_by_period: { today: [row], month: [{...row, tokens: 340}], allTime: [row] }, sessions_meta_by_period: {
    today: { availability: "available", sessions_total: 1, sessions_omitted_count: 0, dashboard_omitted_count: 0 },
    month: { availability: "partial", sessions_total: 2, sessions_omitted_count: 7, dashboard_omitted_count: 0 },
  } });
  const session = data.sessions[0];
  assert.equal(session.sessionId, "real-id");
  assert.deepEqual(session.modelTokens, row.models);
  assert.deepEqual(session.modelCosts, row.modelCosts);
  assert.equal(sessionsForPeriod(data, "month")[0].totalTokens, 340);
  assert.deepEqual(sessionsForPeriod(data, "allTime"), []);
  assert.equal(sessionPeriodDetails(data, "allTime").reason, "not-synced");
  assert.equal(sessionPeriodDetails(data, "month").availability, "partial");
  assert.equal(sessionPeriodDetails(data, "month").omitted, 7);
  const details = sessionUsageDetails(session);
  assert.equal(details.componentTotal, 170); // reasoning is already included in output
  assert.equal(details.complete, true);
  assert.equal(details.reasoning, 15);
  assert.equal(details.messageCount, 2);
  assert.equal(details.outputTokensPerSecond, 20);
  assert.equal(details.context?.tokens, 120);
  assert.equal(details.callDetailsAvailable, false);
});

test("older and malformed records retain unknowns instead of zero estimates", () => {
  const data = normalizeOverview({totals: {}, sessions: [{deviceId: "a", client: "codex", sessionId: "old", tokens: 42, inputTokens: -1, contextWindow: -2}]});
  const details = sessionUsageDetails(data.sessions[0]);
  assert.equal(details.input, null);
  assert.equal(details.cacheRead, null);
  assert.equal(details.reasoning, null);
  assert.equal(details.componentTotal, null);
  assert.equal(details.context, null);
  assert.equal(details.outputTokensPerSecond, null);
  assert.deepEqual(sessionsForPeriod(data, "month"), []);
  assert.equal(sessionPeriodDetails(data, "month").availability, "unavailable");
  assert.equal(outputTokensPerSecond({timedOutputTokens: 10, timedDurationMs: 0}), null);
});

test("model attribution never borrows a mixed session's full counts or costs", () => {
  const session = normalizeOverview({totals: {}, sessions: [row]}).sessions[0];
  assert.deepEqual(sessionModelUsage(session, "model-a"), {tokens: 100, costUsd: 0.1, wholeSession: false});
  assert.deepEqual(sessionModelUsage(session, "model-b"), {tokens: 70, costUsd: null, wholeSession: false});
  assert.equal(sessionsForModel([session], "model-a").length, 1);
  assert.equal(sessionsForModel([session], "unknown").length, 0);
  const period = normalizePeriod({models: {"model-a": 100}, modelUnpricedTokens: {"model-a": 25}, clients: {codex: 100}, clientUnpricedTokens: {codex: 25},
    clientModels: {codex: {"model-a": 100}}, clientModelCosts: {codex: {"model-a": 0.1}},
    modelThroughput: {"model-a": {timedOutputTokens: 30, timedDurationMs: 1500, timedTokens: 100}}});
  const model = modelUsageDetails(period, "model-a");
  assert.equal(model.entity?.unpricedTokens, 25);
  assert.equal(period.clients[0].unpricedTokens, 25);
  assert.equal(model.outputTokensPerSecond, 20);
  assert.deepEqual(model.clients, [{client: "codex", tokens: 100, costUsd: 0.1}]);
  assert.equal(modelUsageDetails(normalizePeriod({}), "missing").clients, null);
});


test("demo alone provides complete, mixed and missing session readings with truthful context overflow", () => {
  const data = createDemoData(new Date("2026-10-18T02:00:00Z"));
  const today = sessionsForPeriod(data, "today");
  const month = sessionsForPeriod(data, "month");
  assert.equal(sessionUsageDetails(today[0]).complete, true);
  assert.equal(sessionUsageDetails(today[0]).reasoning! > 0, true);
  assert.equal(sessionUsageDetails(today[0]).outputTokensPerSecond! > 0, true);
  assert.equal(sessionUsageDetails(today[1]).context?.percentUsed, 104);
  assert.equal(sessionUsageDetails(today[2]).input, null);
  assert.equal(sessionUsageDetails(today[2]).outputTokensPerSecond, null);
  assert.equal(month[0].totalTokens, today[0].totalTokens * 3);
  assert.equal(month[0].contextTokens, today[0].contextTokens);
  const mixed = today[1];
  assert.equal(Object.values(mixed.modelTokens!).reduce((sum, value) => sum + value, 0), mixed.totalTokens);
  assert.equal(Math.round(Object.values(mixed.modelCosts!).reduce((sum, value) => sum + value, 0) * 100), Math.round(mixed.costUsd! * 100));
  assert.equal(sessionModelUsage(mixed, mixed.models[0]).wholeSession, false);
  const model = modelUsageDetails(data.periods.month, mixed.models[0]);
  assert.equal(model.outputTokensPerSecond! > 0, true);
  assert.equal(model.clients!.length > 0, true);
  assert.deepEqual(sessionsForPeriod(data, "allTime"), []);
  const live = normalizeOverview({totals: {}, sessions: [{deviceId: "a", client: "codex", sessionId: "live", tokens: 10}]});
  assert.equal(sessionUsageDetails(live.sessions[0]).context, null);
  assert.equal(live.periods.today.modelThroughput, undefined);
});


test("real upstream normalized zeros never become measured zero use or free cost", () => {
  const require = createRequire(import.meta.url);
  const { normalizePeriod: upstreamNormalizePeriod } = require("../../tm-core/vendor/src/shared/usage.js");
  const normalized = upstreamNormalizePeriod({sessions: {x: {
    client: "codex", sessionId: "x", totalTokens: 10, inputTokens: 10,
    models: {m: 10}, modelCosts: {m: 0}, contextWindow: 200000,
  }}});
  const source = normalized.sessions["codex:x"];
  assert.equal(source.outputTokens, 0);
  assert.equal(source.costUsd, 0);
  for (const marker of [undefined, true]) {
    const data = normalizeOverview({totals: {}, sessions: [{...source, tokens: source.totalTokens, zeroValuesUnconfirmed: marker}]});
    const session = data.sessions[0];
    const detail = sessionUsageDetails(session);
    assert.equal(session.inputTokens, 10);
    assert.equal(session.outputTokens, null);
    assert.equal(session.cacheReadTokens, null);
    assert.equal(session.cacheWriteTokens, null);
    assert.equal(session.reasoningTokens, null);
    assert.equal(session.messageCount, null);
    assert.equal(session.costUsd, null);
    assert.equal(session.contextTokens, null);
    assert.equal(detail.complete, false);
    assert.equal(detail.componentTotal, null);
    assert.equal(detail.context, null);
    assert.equal(detail.hasUnconfirmedZeros, true);
    assert.equal(sessionModelUsage(session, "m").costUsd, null);
  }
  const confirmed = normalizeOverview({totals: {}, sessions: [{...source, tokens: source.totalTokens, zeroValuesUnconfirmed: false}]}).sessions[0];
  assert.equal(confirmed.costUsd, 0);
  assert.equal(sessionUsageDetails(confirmed).complete, true);
  assert.equal(sessionUsageDetails(confirmed).hasUnconfirmedZeros, false);
});

test("only the accepted canonical title is retained with a Unicode-safe limit and normal fallbacks", () => {
  const title = "已批准的会话标题" + "🙂".repeat(180);
  const accepted = normalizeOverview({totals: {}, sessions: [{...row, title}]}).sessions[0];
  assert.equal(accepted.title, Array.from(title).slice(0, 160).join(""));
  assert.equal(accepted.name, row.sessionId);
  assert.equal(Array.from(accepted.title!).length, 160);
  const projectNamed = normalizeOverview({totals: {}, sessions: [{...row, title, project: "stable project fallback"}]}).sessions[0];
  assert.equal(projectNamed.name, "stable project fallback");
  assert.equal(projectNamed.title, accepted.title);
  const idOnly = normalizeOverview({totals: {}, sessions: [{...row}]}).sessions[0];
  assert.equal(idOnly.name, row.sessionId);
  assert.equal(idOnly.title, null);
  for (const invalid of [undefined, null, 42, {}, "   "]) {
    const unknown = normalizeOverview({totals: {}, sessions: [{...row, title: invalid, project: "stable fallback", preview: "private preview", sessionTitle: "compatibility title", messages: ["private message"]}]}).sessions[0];
    assert.equal(unknown.title, null);
    assert.equal(unknown.name, "stable fallback");
    assert.equal("messages" in unknown, false);
    assert.equal("preview" in unknown, false);
    assert.equal("sessionTitle" in unknown, false);
  }
});
