import assert from "node:assert/strict";
import test from "node:test";
import { createDemoData, normalizeOverview, type ProjectUsage } from "../src/data.ts";
import { groupedShares, projectShares, UNATTRIBUTED_COLOR } from "../src/project-usage.ts";

const project = (overrides: Partial<ProjectUsage> = {}): ProjectUsage => ({
  id: "p", name: "web", totalTokens: 1000, costUsd: 1.2, unpricedTokens: null,
  clients: {}, models: {}, devices: [], ...overrides,
});

test("overview projects are read per period with upstream's incomplete flags", () => {
  const data = normalizeOverview({
    totals: {},
    projects_by_period: {
      today: [
        { label: "api", tokens: 200, costUsd: 0.2, clients: { codex: 200 }, models: {}, devices: ["MacBook-Pro"] },
        { label: "web", tokens: 300, costUsd: 0.5, unpricedTokens: 40,
          clients: { codex: 300, bad: -1 }, models: { "gpt-5.4": 300, flag: true, text: "7" },
          devices: ["MacBook-Pro", "", 3] },
        { label: "", tokens: 99 },
      ],
      month: [],
    },
    projects_meta_by_period: { today: { incomplete: true }, month: { incomplete: "yes" } },
  });
  const today = data.projectsByPeriod!.today;
  assert.equal(today.reported, true);
  assert.equal(today.incomplete, true);
  assert.deepEqual(today.projects.map((p) => p.name), ["web", "api"]);
  const web = today.projects[0];
  assert.deepEqual(web.clients, { codex: 300 });
  assert.deepEqual(web.models, { "gpt-5.4": 300 });
  assert.deepEqual(web.devices, ["MacBook-Pro"]);
  assert.equal(web.unpricedTokens, 40);
  assert.deepEqual(data.projectsByPeriod!.month, { reported: true, incomplete: false, projects: [] });
  // A period the server left out is unreported, not empty.
  assert.equal(data.projectsByPeriod!.allTime.reported, false);
});

test("an older gateway's all-time projects still fill the all-time period", () => {
  const data = normalizeOverview({ totals: {}, projects: [{ label: "web", tokens: 50, clients: { claude: 50 } }] });
  assert.equal(data.projectsByPeriod!.allTime.reported, true);
  assert.deepEqual(data.projectsByPeriod!.allTime.projects.map((p) => [p.name, p.totalTokens, p.models]), [["web", 50, {}]]);
  assert.equal(data.projectsByPeriod!.today.reported, false);
  assert.equal(data.projectsByPeriod!.month.reported, false);
});

test("model shares keep the part without a model apart instead of spreading it", () => {
  const shares = projectShares(project({ models: { "o3": 250, "gpt-5.4": 500, empty: 0 } }), "model");
  assert.deepEqual(shares.map((s) => [s.label, s.tokens, s.share, s.kind]), [
    ["gpt-5.4", 500, 0.5, "named"],
    ["o3", 250, 0.25, "named"],
    ["未区分模型", 250, 0.25, "unattributed"],
  ]);
  assert.equal(shares[0].color, "var(--share-1)");
  assert.equal(shares[2].color, UNATTRIBUTED_COLOR);
  // A project from an older client has no model parts at all.
  assert.deepEqual(projectShares(project(), "model").map((s) => [s.label, s.share]), [["未区分模型", 1]]);
});

test("client shares use display names and never exceed the project", () => {
  const shares = projectShares(project({ totalTokens: 900, clients: { codex: 600, claude: 600 } }), "client");
  assert.deepEqual(shares.map((s) => [s.label, s.share]), [["Claude Code", 0.5], ["Codex", 0.5]]);
});

test("parts past the coloured three are grouped, tooltips name more of them", () => {
  const models = { a: 400, b: 200, c: 100, d: 60, e: 40 };
  const shares = projectShares(project({ models }), "model");
  const bar = groupedShares(shares, "model");
  assert.deepEqual(bar.map((s) => [s.label, s.tokens, s.kind]), [
    ["a", 400, "named"], ["b", 200, "named"], ["c", 100, "named"],
    ["其他 2 个模型", 100, "other"], ["未区分模型", 200, "unattributed"],
  ]);
  assert.equal(bar[3].color, "var(--share-rest)");
  const tooltip = groupedShares(shares, "model", 4);
  assert.deepEqual(tooltip.map((s) => s.label), ["a", "b", "c", "d", "其他 1 个模型", "未区分模型"]);
  assert.equal(tooltip[3].color, "var(--share-rest)");
  const closes = bar.reduce((sum, s) => sum + s.share, 0);
  assert.ok(Math.abs(closes - 1) < 1e-9);
});

test("demo projects fit inside each period and one keeps usage without a model", () => {
  const data = createDemoData(new Date("2026-09-05T02:00:00Z"));
  for (const period of ["today", "month", "allTime"] as const) {
    const usage = data.projectsByPeriod![period];
    assert.equal(usage.reported, true);
    assert.equal(usage.incomplete, period === "allTime");
    const total = usage.projects.reduce((sum, p) => sum + p.totalTokens, 0);
    assert.ok(total > 0 && total < data.periods[period].totalTokens, period);
    for (const p of usage.projects) {
      const clients = Object.values(p.clients).reduce((sum, v) => sum + v, 0);
      assert.equal(clients, p.totalTokens, p.name);
      const unattributed = projectShares(p, "model").filter((s) => s.kind === "unattributed");
      assert.equal(unattributed.length, p.name === "Release tooling" ? 1 : 0, p.name);
    }
  }
});
