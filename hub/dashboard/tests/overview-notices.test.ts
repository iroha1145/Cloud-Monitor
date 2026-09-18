import assert from "node:assert/strict";
import test from "node:test";
import { normalizeOverview } from "../src/data";

test("unknown quota statuses get a fallback while intentional quiet states stay quiet", () => {
  for (const status of ["ok", "disabled", "notConfigured"]) {
    const data = normalizeOverview({ totals: {}, limits: [{ provider: "openai", status }] });
    assert.deepEqual(data.notices, []);
  }
  for (const status of ["waiting", "syncing", "toString"]) {
    const data = normalizeOverview({ totals: {}, limits: [{ provider: "openai", status }] });
    assert.deepEqual(data.notices, ["OpenAI 额度状态暂时无法识别，等待同步。"]);
  }
});

test("stale overviews explain the retained snapshot without duplicating generic partial notices", () => {
  for (const reason of ["refresh_failed", "refresh_timeout"]) {
    const data = normalizeOverview({
      totals: {}, partial: true, generated_at: "2026-09-18T01:00:00Z",
      partial_errors: [{ code: "overview_stale", source: "cloud-hub", reason }],
    });
    assert.equal(data.generatedAt, "2026-09-18T01:00:00Z");
    assert.deepEqual(data.notices, ["数据源暂时不可用，正在显示上次总览。"]);
  }
  assert.deepEqual(normalizeOverview({ totals: {}, partial: true, partial_errors: [{ code: "new_error" }] }).notices,
    ["部分辅助数据暂不可用，用量总计仍来自设备上报。"]);
});

test("forwarding reports are not counted again as snapshots and retired reports disclose history gaps", () => {
  const data = normalizeOverview({
    totals: {}, pending_outbox: 7, forwarding_outbox: 5, expired_unconfirmed_outbox: 3,
    last_forward_error: "private stack trace", last_forward_terminal_reason: "internal implementation detail",
  });
  assert.deepEqual(data.notices, [
    "还有 5 条上报等待服务恢复后确认，历史记录可能暂未更新。",
    "还有 2 条快照等待同步，历史记录可能尚未更新。",
    "有 3 条较早的上报未能完成同步，历史记录可能存在缺口。",
  ]);
});
