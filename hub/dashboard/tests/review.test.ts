import assert from "node:assert/strict";
import test from "node:test";
import { requestJSON } from "../src/api";
import { normalizeOverview } from "../src/data";

// Static AbortSignal helpers are optional; requests only need AbortController.
test("requests work without AbortSignal.any or AbortSignal.timeout", async () => {
  const original = globalThis.fetch;
  const any = Object.getOwnPropertyDescriptor(AbortSignal, "any")!;
  const timeout = Object.getOwnPropertyDescriptor(AbortSignal, "timeout")!;
  Object.defineProperty(AbortSignal, "any", { ...any, value: undefined });
  Object.defineProperty(AbortSignal, "timeout", { ...timeout, value: undefined });
  globalThis.fetch = async () => Response.json({ ok: true });
  try {
    assert.deepEqual(await requestJSON("/fixture", "test", new AbortController().signal), { ok: true });
  } finally {
    globalThis.fetch = original;
    Object.defineProperty(AbortSignal, "any", any);
    Object.defineProperty(AbortSignal, "timeout", timeout);
  }
});

test("already cancelled requests never start network work", async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  const reason = new DOMException("cancelled", "AbortError");
  controller.abort(reason);
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({}); };
  try {
    await assert.rejects(requestJSON("/fixture", "test", controller.signal), error => error === reason);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test("cancelling response body consumption preserves the caller's reason", async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  const reason = new DOMException("cancelled", "AbortError");
  globalThis.fetch = async (_url, options) => ({
    ok: true,
    json: () => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
      controller.abort(reason);
    }),
  }) as Response;
  try { await assert.rejects(requestJSON("/fixture", "test", controller.signal), error => error === reason); }
  finally { globalThis.fetch = original; }
});

test("invalid calendar dates never reach chart timestamp calculations", () => {
  const data = normalizeOverview({ totals: {}, trend: [
    { day: "2026-09-01", total: 10 },
    { day: "not-a-date", total: 20 },
    { day: "2026-02-30", total: 30 },
    { day: "2026-13-01", total: 40 },
    { day: "2024-02-29", total: 50 },
  ] });
  assert.deepEqual(data.trend.map(point => point.day), ["2024-02-29", "2026-09-01"]);
});


import { axisLabel, indexForSelectedDay } from "../src/trend-math";

test("trend selection follows the calendar day when the window slides", () => {
  const days = (...values: string[]) => values.map((day) => ({ day }));
  const before = days("2026-08-16", "2026-08-17", "2026-09-13", "2026-09-14");
  const after = days("2026-08-17", "2026-09-13", "2026-09-14", "2026-09-15");
  assert.equal(indexForSelectedDay(before, "2026-09-14"), 3);
  assert.equal(indexForSelectedDay(after, "2026-09-14"), 2);
  assert.equal(indexForSelectedDay(after, "2026-08-16"), after.length - 1);
  assert.equal(indexForSelectedDay([], null), 0);
});

test("trend axis labels handle negative costs and roll 10000万 up to 1亿", () => {
  assert.equal(axisLabel(-0.45, "cost"), "-$0.45");
  assert.equal(axisLabel(-4.5, "cost"), "-$4.5");
  assert.equal(axisLabel(-120, "cost"), "-$120");
  assert.equal(axisLabel(99_950_000, "tokens"), "1亿");
  assert.equal(axisLabel(80_000_000, "tokens"), "8000万");
});

test("successful HTML bodies become a friendly format error", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("<html>bad gateway</html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  try {
    await assert.rejects(requestJSON("/fixture", "test"), /服务返回格式异常/);
  } finally {
    globalThis.fetch = original;
  }
});

test("deadline covers JSON body reads and releases its timer", async () => {
  const originalFetch = globalThis.fetch;
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  let deadline!: () => void;
  let bodyStarted!: () => void;
  const readingBody = new Promise<void>(resolve => { bodyStarted = resolve; });
  let cleared = false;
  globalThis.setTimeout = ((callback: () => void) => { deadline = callback; return 123; }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = (() => { cleared = true; }) as typeof clearTimeout;
  globalThis.fetch = async (_url, options) => ({
    ok: true,
    json: () => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
      bodyStarted();
    }),
  }) as Response;
  try {
    const pending = requestJSON("/fixture", "test");
    await readingBody;
    deadline();
    await assert.rejects(pending, /服务响应超时/);
    assert.equal(cleared, true);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  }
});
