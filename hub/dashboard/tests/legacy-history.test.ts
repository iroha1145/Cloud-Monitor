import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync(new URL("../../frontend/tm.js", import.meta.url), "utf8");
function section(start: string, end: string) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last);
}
const mapper = section("function mapHistoryItem(", "async function refreshHistoryFirstPage(");
const refresh = section("async function refreshHistoryFirstPage(", "function resetHistory(");

test("legacy archives preserve credits and numeric strings but never turn bad costs into free usage", () => {
  const context = vm.createContext({});
  vm.runInContext(mapper, context);
  for (const cost of ["abc", "", " ", null, undefined, Infinity, NaN, [], {}, true]) {
    context.input = { day: "2026-09-18", costUsd: cost };
    assert.equal(vm.runInContext("mapHistoryItem(input).costUsd", context), null);
  }
  for (const cost of [0, -0.45, "-0.45", "1.25"]) {
    context.input = { day: "2026-09-18", costUsd: cost };
    assert.equal(vm.runInContext("mapHistoryItem(input).costUsd", context), Number(cost));
  }
});

test("an inconsistent empty refresh retains the visible archive and its next-page cursor", async () => {
  const rows = [{ day: "2026-09-18", tokens: 100, costUsd: 1 }];
  const history = {
    rows, status: "ready", cursor: "2026-09-18", done: false, loading: false,
    seen: new Set(["2026-09-18"]), totalDays: 3, retentionDays: 370,
    dayBasis: "device-local", mixedTz: false, partial: false, aborter: null,
  };
  let response: unknown = { items: [], has_more: true, total_days: 3, next_cursor: "2026-09-17" };
  let retries = 0;
  const context = vm.createContext({
    AbortController, ApiError: class extends Error {},
    state: { data: { features: {} }, view: "overview", tokenRevision: 0, aux: { history } },
    dataApi: { historyDaily: async () => response },
    updateHistLoading() {}, scheduleHistoryRetry() { retries++; },
  });
  vm.runInContext(mapper + refresh, context);
  await vm.runInContext("refreshHistoryFirstPage()", context);
  assert.deepEqual(Array.from(history.rows), rows);
  assert.equal(history.status, "ready");
  assert.equal(history.cursor, "2026-09-18");
  assert.equal(history.done, false);
  assert.equal(history.loading, false);
  assert.equal(retries, 0);
  response = { items: [], has_more: false, total_days: 0 };
  await vm.runInContext("refreshHistoryFirstPage()", context);
  assert.equal(history.rows.length, 0);
  assert.equal(history.status, "empty");
  assert.equal(history.done, true);
  response = { items: [], has_more: true, total_days: 3, next_cursor: "2026-09-17" };
  await vm.runInContext("refreshHistoryFirstPage()", context);
  assert.equal(history.status, "error");
  assert.equal(retries, 1);
});

test("legacy status distinguishes forwarding, snapshot backlog and historical gaps without diagnostic leakage", () => {
  let status: { kind: string; text: string } | undefined;
  const data: Record<string, unknown> = {
    pending_outbox: 7, forwarding_outbox: 5, expired_unconfirmed_outbox: 3,
    last_forward_error: "private stack trace", last_forward_terminal_reason: "internal implementation detail",
  };
  const context = vm.createContext({
    state: { alive: true, demo: false, staleData: false, data },
    setConn(kind: string, text: string) { status = { kind, text }; },
  });
  vm.runInContext(section("function updateConn()", "async function load("), context);
  vm.runInContext("updateConn()", context);
  assert.deepEqual(status, { kind: "warn", text: "待服务恢复确认 5 条上报 · 待同步历史 2 条 · 3 条旧上报未完成，历史可能存在缺口" });
  Object.assign(data, { pending_outbox: 0, forwarding_outbox: 0, expired_unconfirmed_outbox: 0 });
  vm.runInContext("updateConn()", context);
  assert.deepEqual(status, { kind: "ok", text: "正常" });
});
