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


import { smoothTrendPoints } from "../src/trend-math";

test("smoothed cost curves preserve every reported credit and endpoint", () => {
  const points = [-5, -10, 8, -2].map((value, time) => ({ time, value }));
  const smoothed = smoothTrendPoints(points);
  points.forEach((point, index) => assert.deepEqual(smoothed[index * 9], point));
});

test("smoothing does not invent extrema between adjacent daily records", () => {
  for (const values of [[100, 1, 1, 100], [-2, -20, 8, 0], [0, 30, 0, 10]]) {
    const points = values.map((value, time) => ({ time, value }));
    const smoothed = smoothTrendPoints(points);
    for (let i = 0; i < points.length - 1; i++) {
      for (const sample of smoothed.slice(i * 9, (i + 1) * 9)) {
        assert.ok(sample.value >= Math.min(values[i], values[i + 1]));
        assert.ok(sample.value <= Math.max(values[i], values[i + 1]));
      }
    }
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
