import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { loadDashboard } from "../src/api";
import { createDemoData } from "../src/data";
import { browserTimeZone } from "../src/lib/datetime";
import { readArchive } from "../src/restoration-api";

const require = createRequire(import.meta.url);
const fixture = require("./fixtures/overview.json");

test("dashboard refreshes and archive pagination send this browser's current zone", async (t) => {
  let zone = "America/Los_Angeles";
  const originalOptions = new Intl.DateTimeFormat().resolvedOptions();
  t.mock.method(Intl.DateTimeFormat.prototype, "resolvedOptions", () => ({ ...originalOptions, timeZone: zone }));
  const calls: { path: string; zone: string | null }[] = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    const sentZone = new Headers(init?.headers).get("X-CM-Time-Zone");
    calls.push({ path, zone: sentZone });
    return Response.json(path.endsWith("/overview") ? {
      ...fixture, dashboard_time_zone: sentZone,
    } : { items: [], dashboard_time_zone: sentZone });
  };
  assert.equal((await loadDashboard("test-key")).timeZone, zone);
  await readArchive("test-key", "2026-10-01");
  assert.equal(calls.length, 5);
  assert.ok(calls.every(call => call.zone === zone));
  assert.ok(calls.some(call => call.path.includes("cursor=2026-10-01")));
  zone = "Asia/Tokyo";
  assert.equal((await loadDashboard("test-key")).timeZone, zone);
  assert.ok(calls.slice(5).every(call => call.zone === zone));
});

test("missing browser timezone support falls back to UTC", (t) => {
  t.mock.method(Intl.DateTimeFormat.prototype, "resolvedOptions", () => { throw new Error("unavailable"); });
  assert.equal(browserTimeZone(), "UTC");
});

test("demo days and hourly windows use the selected browser zone", () => {
  const now = new Date("2026-10-01T00:05:00Z");
  const tokyo = createDemoData(now, 0, "Asia/Tokyo");
  const la = createDemoData(now, 0, "America/Los_Angeles");
  assert.equal(tokyo.activityMetadata?.today, "2026-10-01");
  assert.equal(la.activityMetadata?.today, "2026-09-30");
  assert.equal(la.activityMetadata?.month, "2026-09");
  assert.equal(la.timeZone, "America/Los_Angeles");
  assert.equal(la.trend.at(-1)?.day, "2026-09-30");
  assert.ok(la.hourly.slice(18).every(row => row.totalTokens === 0));
  assert.equal(la.hourly.reduce((sum, row) => sum + row.totalTokens, 0), la.periods.today.totalTokens);
});

test("demo calendar days stay unique and consecutive across DST", () => {
  const data = createDemoData(new Date("2026-11-03T07:30:00Z"), 0, "America/Los_Angeles");
  const days = data.activity.map(row => row.day);
  assert.equal(new Set(days).size, 90);
  for (let index = 1; index < days.length; index++)
    assert.equal(Date.parse(days[index]) - Date.parse(days[index - 1]), 86_400_000);
});
