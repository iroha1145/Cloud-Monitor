import assert from "node:assert/strict";
import test from "node:test";
import { createDemoData, normalizeOverview } from "../src/data.ts";

const overview = (activity: unknown, extra: Record<string, unknown> = {}) => ({
  totals: {}, generated_at: "2026-09-04T16:00:00Z", dashboard_time_zone: "Asia/Tokyo",
  dashboard_period: { today: { key: "2026-09-05" }, month: { key: "2026-09" } },
  activity, ...extra,
});

test("hourly activity uses the current dashboard date and rejects a stale day", () => {
  const current = normalizeOverview(overview({ hourly_today: { day: "2026-09-05", buckets: [{ hour: 2, total: 150 }] }, hourly: [{ hour: 1, total: 500 }], hourly_day: "2026-09-04" }));
  assert.deepEqual(current.hourly, [{ hour: 2, totalTokens: 150 }]);
  assert.equal(current.activityMetadata?.hourlyDay, "2026-09-05");
  assert.equal(current.activityMetadata?.hourlyStatus, "ready");
  const stale = normalizeOverview(overview({ hourly_today: { day: "2026-09-04", buckets: [{ hour: 2, total: 150 }] }, hourly: [{ hour: 1, total: 500 }], hourly_day: "2026-09-04" }));
  assert.deepEqual(stale.hourly, []);
  assert.equal(stale.activityMetadata?.hourlyStatus, "date-mismatch");
});

test("a valid legacy hour set remains usable when the new hour set has a stale date", () => {
  const data = normalizeOverview(overview({ hourly_today: { day: "2026-09-04", buckets: [{ hour: 2, total: 150 }] }, hourly: [{ hour: 1, total: 0 }], hourly_day: "2026-09-05" }));
  assert.deepEqual(data.hourly, [{ hour: 1, totalTokens: 0 }]);
  const undated = normalizeOverview(overview({ hourly: [{ hour: 1, total: 0 }] }));
  assert.equal(undated.activityMetadata?.hourlyDay, "2026-09-05");
  assert.equal(undated.activityMetadata?.hourlyStatus, "ready");
});

test("source timezone resolves midnight and still rejects hours from another day without period metadata", () => {
  const data = normalizeOverview(overview({ time_zone: "Asia/Tokyo", hourly_today: { day: "2026-09-04", buckets: [{ hour: 1, total: 200 }] } }, { dashboard_period: undefined, dashboard_time_zone: "America/Los_Angeles" }));
  assert.equal(data.activityMetadata?.today, "2026-09-05");
  assert.equal(data.activityMetadata?.month, "2026-09");
  assert.equal(data.activityMetadata?.timeZone, "Asia/Tokyo");
  assert.equal(data.activityMetadata?.hourlyStatus, "date-mismatch");
  assert.deepEqual(data.hourly, []);
});

test("missing, malformed and negative activity counts do not become zeros", () => {
  const data = normalizeOverview(overview({
    daily: [{ day: "2026-09-01", total: null }, { day: "2026-09-02" }, { day: "2026-09-03", total: -1 }, { day: "2026-09-04", total: 0 }, { day: "2026-09-05", total: 100 }, { day: "2026-09-05", total: 150 }, { day: "2026-02-30", total: 500 }],
    hourly_today: { day: "2026-09-05", buckets: [{ hour: 0, total: null }, { hour: 1, total: -1 }, { hour: 2, total: 0 }, { hour: 3, total: 100 }, { hour: 3, total: 200 }, { hour: 3.5, total: 1 }, { hour: 24, total: 99 }, { hour: -1, total: 99 }] },
  }));
  assert.deepEqual(data.activity, [{ day: "2026-09-04", totalTokens: 0 }, { day: "2026-09-05", totalTokens: 150 }]);
  assert.deepEqual(data.hourly, [{ hour: 2, totalTokens: 0 }, { hour: 3, totalTokens: 200 }]);
  const unavailable = normalizeOverview(overview({ hourly_today: { day: "2026-09-05", buckets: [] } }));
  assert.deepEqual(unavailable.hourly, []);
  assert.equal(unavailable.activityMetadata?.hourlyStatus, "unavailable");
});

test("feature flags preserve explicit disabled states and do not infer coverage", () => {
  const data = normalizeOverview(overview({ hourly_today: { day: "2026-09-05", buckets: [{ hour: 2, total: 150 }] } }, { features: { activity_hourly: false, history_daily: false, subscriptions: false, provider_status: false, custom: true, ignored: "false" } }));
  assert.deepEqual(data.features, { activity_hourly: false, history_daily: false, subscriptions: false, provider_status: false, custom: true });
  assert.equal(data.activityMetadata?.hourlyStatus, "disabled");
  assert.deepEqual(data.hourly, []);
  assert.equal(data.activityMetadata?.coverage, null);
  assert.ok(!data.notices.some((notice) => /未载入/.test(notice)));
});

test("coverage retains source counts, attribution and device diagnostics without fabricating absent values", () => {
  const data = normalizeOverview(overview({
    daily_day_basis: "hybrid-dashboard-and-device-local", daily_mixed_basis: true, daily_archive_cutover_day: "2026-09-04",
    coverage: { coverage_percent: 32.8, expected_buckets: 100, observed_buckets: 33, first_sample_at: "2026-09-04T15:00:00Z", last_sample_at: "2026-09-04T16:00:00Z", attribution_mode: "delta-low-coverage", gap_count: 2, reset_count: 0, devices: [{ device_id: "desktop", expected_buckets: 100, observed_buckets: 33, gap_count: 2, reset_count: 0 }, { device_id: "phone", observed_buckets: null, last_sample_at: "not-a-date" }] },
  }));
  const metadata = data.activityMetadata!;
  assert.equal(metadata.dailyMixedBasis, true);
  assert.equal(metadata.archiveCutoverDay, "2026-09-04");
  assert.equal(metadata.coverage?.coveragePercent, 32.8);
  assert.equal(metadata.coverage?.resetCount, 0);
  assert.equal(metadata.coverage?.devices[0].observedBuckets, 33);
  assert.equal(metadata.coverage?.devices[1].observedBuckets, null);
  assert.equal(metadata.coverage?.devices[1].expectedBuckets, null);
  assert.equal(metadata.coverage?.devices[1].lastSampleAt, null);
  const invalid = normalizeOverview(overview({ coverage: { coverage_percent: 120, expected_buckets: -1 } }));
  assert.equal(invalid.activityMetadata?.coverage?.coveragePercent, null);
  assert.equal(invalid.activityMetadata?.coverage?.expectedBuckets, null);
});

test("partial, delayed, pending and stale snapshots retain separate service notices", () => {
  const data = normalizeOverview(overview({}, { partial: true, snapshot_degraded: true, pending_outbox: 3, stale_data: true }));
  for (const phrase of ["部分辅助数据", "历史快照同步延迟", "3 条快照等待同步", "可能已经过期"])
    assert.ok(data.notices.some((notice) => notice.includes(phrase)), phrase);
});

test("demo dates agree with activity and hourly totals while coverage stays undisclosed", () => {
  const data = createDemoData(new Date("2026-09-04T15:05:00Z"));
  assert.equal(data.activityMetadata?.today, "2026-09-05");
  assert.equal(data.activityMetadata?.month, "2026-09");
  assert.equal(data.activityMetadata?.hourlyDay, "2026-09-05");
  assert.equal(data.activityMetadata?.hourlyStatus, "ready");
  assert.equal(data.activityMetadata?.coverage, null);
  assert.equal(data.hourly.length, 24);
  assert.equal(data.hourly.reduce((total, hour) => total + hour.totalTokens, 0), data.periods.today.totalTokens);
});
