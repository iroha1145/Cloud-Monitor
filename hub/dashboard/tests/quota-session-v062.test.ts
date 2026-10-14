import assert from "node:assert/strict";
import test from "node:test";
import { normalizeOverview } from "../src/data.ts";
import { formatMoney } from "../src/money.ts";
import { quotaAmount, quotaBalance, quotaBoundaryLabel, quotaHeadline } from "../src/quota-presentation.ts";
import { sessionActivity, sessionContext, sessionPromptCache, sessionUsageSource } from "../src/session-presentation.ts";

const now = "2026-09-26T12:00:00Z";

test("v0.62 quota and session fields survive the dashboard data boundary", () => {
  const data = normalizeOverview({
    generated_at: now,
    totals: {},
    limits: [{
      provider: "claude", adapterId: "sample-api", actionRequired: "accountVerification",
      balance: { amount: 12.5, currency: "USD", tranches: [{ amount: 5, currency: "USD", expiresAt: now }] },
      resetCredits: { availableCount: 2, nextExpiresAt: now, grants: [{
        label: "Courtesy reset", resetsLeft: 1, clears: ["five_hour"],
        usableNow: false, useRequiresLimit: true, paused: false, endsAt: now,
      }] },
      usageSummary: { period: "month", requests: 8, totalTokens: 1200, standardCost: 1.2 },
      windows: [{ kind: "billing", label: "Bonus", metric: "credits", remaining: 5,
        currency: "USD", resetsAt: now, boundaryKind: "expiry", limitId: "bonus", additional: true,
        resetDescription: "Expires soon", detail: "Gift credit" }],
    }],
    sessions: [{ sessionId: "s1", client: "codex", tokens: 100, lastUsedAt: now,
      contextTokens: 950, contextWindow: 1000, turnEnded: false,
      archived: false, sessionKind: "cli", deviceStale: false }],
  });
  const quota = data.quotas[0];
  assert.equal(quota.boundaryKind, "expiry");
  assert.equal(quota.limitId, "bonus");
  assert.equal(quota.additional, true);
  assert.equal(quota.detail, "Gift credit");
  assert.equal(quota.resetDescription, "Expires soon");
  assert.equal(quota.resetCredits?.availableCount, 2);
  assert.deepEqual(quota.resetCredits?.grants[0].clears, ["five_hour"]);
  assert.equal(quota.resetCredits?.grants[0].usableNow, false);
  assert.equal(quota.adapterId, "sample-api");
  assert.equal(quota.usageSummary?.requests, 8);
  assert.equal(quota.actionRequired, "accountVerification");
  assert.equal(quota.balanceTranches?.[0].amount, 5);
  assert.equal(data.sessions[0].turnEnded, false);
  assert.equal(data.sessions[0].deviceStale, false);
  assert.equal(data.sessions[0].sessionKind, "cli");
});

test("money, prepaid points, bare counts, and expiry keep their own units", () => {
  const quota = normalizeOverview({ totals: {}, limits: [
    { provider: "trae", windows: [{ kind: "billing", metric: "credits", label: "Credits",
      currency: "CREDITS", usedPercent: 20, remaining: 680, limit: 850 }] },
    { provider: "kiro", windows: [{ kind: "billing", label: "Bonus", used: 20, limit: 100,
      boundaryKind: "expiry", resetsAt: now }] },
    { provider: "cursor", windows: [{ kind: "billing", metric: "spend", used: 12.5, limit: 20, currency: "USD" }] },
    { provider: "zai", windows: [{ kind: "daily", limitId: "tokens", remaining: 120000, limit: 300000 }] },
    { provider: "unknown-pay", windows: [{ kind: "billing", metric: "spend", used: 12.5 }] },
    { provider: "cny-pay", windows: [{ kind: "billing", metric: "spend", used: 12.5, currency: "CNY" }] },
    { provider: "unknown-credit", windows: [{ kind: "billing", metric: "credits", remaining: 10 }] },
  ] }).quotas;
  assert.deepEqual(quotaHeadline(quota[0]), { value: "680", label: "剩余点数" });
  assert.equal(quotaAmount(100, quota[1]), "100");
  assert.equal(quotaBoundaryLabel(quota[1].boundaryKind), "到期");
  assert.deepEqual(quotaHeadline(quota[2]), { value: "$12.50", label: "已用" });
  assert.equal(quotaAmount(120000, quota[3]), "120,000 词元");
  assert.equal(quota[4].currency, null);
  assert.deepEqual(quotaHeadline(quota[4]), { value: "12.5（单位未提供）", label: "已用" });
  assert.deepEqual(quotaHeadline(quota[5]), { value: "¥12.50", label: "已用" });
  assert.deepEqual(quotaHeadline(quota[6]), { value: "10（单位未提供）", label: "剩余" });
  assert.equal(quotaBalance(9.5, { balanceCurrency: null }), "9.5（单位未提供）");
});

test("session status needs explicit end flag and a fresh device; context is an uploaded reading", () => {
  const template = normalizeOverview({ totals: {}, sessions: [{ sessionId: "s", client: "codex", tokens: 1,
    lastUsedAt: "2026-09-26T11:55:00Z", contextTokens: 950, contextWindow: 1000 }] }).sessions[0];
  assert.equal(sessionActivity(template, now), "状态未提供");
  assert.equal(sessionActivity({ ...template, turnEnded: false, deviceStale: false }, now), "运行中");
  assert.equal(sessionActivity({ ...template, turnEnded: true, deviceStale: false }, now), "已完成");
  assert.equal(sessionActivity({ ...template, turnEnded: false, deviceStale: true }, now), "闲置");
  assert.equal(sessionActivity({ ...template, turnEnded: false, deviceStale: false, archived: true }, now), "闲置");
  assert.equal(sessionActivity({ ...template, turnEnded: false, deviceStale: false,
    lastUsedAt: "2026-09-26T11:49:00Z" }, now), "闲置");
  assert.equal(sessionActivity({ ...template, turnEnded: false, deviceStale: false,
    lastUsedAt: "2026-09-26T12:01:00Z" }, now), "状态未提供");
  assert.deepEqual(sessionContext(template), { used: 95, remaining: 5 });
  assert.equal(sessionContext({ ...template, contextWindow: null }), null);
});

test("v0.70 liveActivity and waitingForInput states are normalized and presented", () => {
  const data = normalizeOverview({
    generated_at: now,
    totals: { today: { totalTokens: 300, clients: { catpaw: 100, fx: 100, mcode: 100 } } },
    sessions: [{
      sessionId: "s-v070",
      client: "codex",
      tokens: 500,
      lastUsedAt: "2026-09-26T11:58:00Z",
      turnEnded: false,
      waitingForInput: true,
      deviceStale: false,
      liveActivity: { state: "waiting", observedAt: "2026-09-26T11:59:50Z" },
      parentSessionId: "p-1",
      parentClient: "claude",
      timedOutputTokens: 120,
      timedDurationMs: 4000,
      promptCache: { observedAt: "2026-09-26T11:58:00Z", ttlSeconds: 300 },
      unpricedTokens: 50,
      usageSource: "codex-dots-local",
      usageCoverage: "observed-only",
    }],
  });
  assert.deepEqual(
    data.periods.today.clients.map((c) => [c.id, c.name]),
    [
      ["catpaw", "CatPaw"],
      ["fx", "FX"],
      ["mcode", "MiniMax Code"],
    ],
  );
  const s = data.sessions[0];
  assert.equal(s.waitingForInput, true);
  assert.deepEqual(s.liveActivity, { state: "waiting", observedAt: "2026-09-26T11:59:50Z" });
  assert.equal(s.parentSessionId, "p-1");
  assert.equal(s.parentClient, "claude");
  assert.equal(s.timedOutputTokens, 120);
  assert.equal(s.timedDurationMs, 4000);
  assert.deepEqual(s.promptCache, { observedAt: "2026-09-26T11:58:00Z", ttlSeconds: 300 });
  assert.equal(s.unpricedTokens, 50);
  assert.equal(s.usageSource, "codex-dots-local");
  assert.equal(s.usageCoverage, "observed-only");

  assert.equal(sessionActivity(s, now), "等待输入");
  assert.equal(
    sessionActivity({ ...s, liveActivity: null, turnEnded: undefined, waitingForInput: true }, now),
    "等待输入",
  );
  assert.equal(
    sessionActivity({ ...s, liveActivity: { state: "running", observedAt: "2026-09-26T11:59:50Z" } }, now),
    "运行中",
  );
  assert.equal(
    sessionActivity({ ...s, liveActivity: { state: "idle", observedAt: "2026-09-26T11:59:50Z" } }, now),
    "闲置",
  );
  // Expired liveActivity (>30s) falls back to transcript waitingForInput / turnEnded
  assert.equal(
    sessionActivity({ ...s, liveActivity: { state: "idle", observedAt: "2026-09-26T11:59:00Z" } }, now),
    "等待输入",
  );

  assert.equal(formatMoney(-0.0, "USD"), "$0.00");
  assert.equal(formatMoney(-0.004, "EUR"), "€0.00");
  assert.equal(quotaAmount(-0.001, { metric: "credits", currency: "CREDITS" }), "0");
  assert.equal(quotaAmount(-0.004, { metric: "spend", currency: "USD" }), "$0.00");
});

test("quota numbers keep Intl rounding and only drop negative zero", () => {
  const credits = { metric: "credits", currency: "CREDITS" } as const;
  assert.equal(quotaAmount(1.005, credits), "1.01");
  assert.equal(quotaAmount(0.285, credits), "0.29");
  assert.equal(quotaAmount(-2.675, credits), "-2.68");
  assert.equal(quotaAmount(-0.006, credits), "-0.01");
  assert.equal(quotaAmount(-0.004, credits), "0");
  const [quota] = normalizeOverview({ totals: {}, limits: [
    { provider: "claude", windows: [{ kind: "weekly", usedPercent: 12.345 }] },
  ] }).quotas;
  assert.equal(quotaHeadline(quota).value, "12.35%");
});

test("prompt cache shows minutes left only for a live claude or codex reading", () => {
  const base = normalizeOverview({
    generated_at: now,
    totals: {},
    sessions: [{
      sessionId: "s-cache", client: "codex", tokens: 1, lastUsedAt: "2026-09-26T11:58:00Z",
      promptCache: { observedAt: "2026-09-26T11:58:00Z", ttlSeconds: 300 },
      usageSource: "codex-dots-local", usageCoverage: "observed-only",
    }],
  }).sessions[0];
  assert.deepEqual(sessionPromptCache(base, now), { minutes: 3 });
  assert.deepEqual(sessionPromptCache({ ...base, client: "claude" }, "2026-09-26T12:02:30Z"), { minutes: 1 });
  assert.equal(sessionPromptCache(base, "2026-09-26T12:03:00Z"), null);
  assert.equal(sessionPromptCache({ ...base, client: "cursor" }, now), null);
  assert.equal(sessionPromptCache({ ...base, archived: true }, now), null);
  assert.equal(sessionPromptCache({ ...base, promptCache: { observedAt: "2026-09-26T12:01:00Z", ttlSeconds: 300 } }, now), null);

  assert.equal(sessionUsageSource(base), "本机观测，只计入观测到的请求，可能少计");
  assert.equal(sessionUsageSource({ ...base, usageSource: "other", usageCoverage: "partial" }), null);
});


