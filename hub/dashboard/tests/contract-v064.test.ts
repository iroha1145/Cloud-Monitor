import assert from "node:assert/strict";
import test from "node:test";
import { normalizeOverview } from "../src/data.ts";
import { quotaHeadline } from "../src/quota-presentation.ts";

test("v0.64 StepFun windows retain percentages without inventing a credit balance", () => {
  const data = normalizeOverview({ totals: {}, limits: [
    { provider: "stepfun", accountLabel: "Coding Plan", windows: [
      { kind: "session", label: "5-hour", usedPercent: 20 },
      { kind: "weekly", label: "Weekly", usedPercent: 40 },
    ] },
    { provider: "stepfun", accountLabel: "Token Plan", windows: [
      { kind: "billing", label: "Credit", usedPercent: 25 },
    ] },
  ] });
  assert.equal(data.quotas.length, 3);
  assert.deepEqual(data.quotas.map(quota => [quota.name, quota.kind, quotaHeadline(quota).value]), [
    ["StepFun", "session", "20%"], ["StepFun", "weekly", "40%"], ["StepFun", "billing", "25%"],
  ]);
  assert.equal(data.quotas[0].groupId, data.quotas[1].groupId);
  assert.notEqual(data.quotas[1].groupId, data.quotas[2].groupId);
  assert.equal(data.quotas[2].remaining, null);
  assert.equal(data.quotas[2].balanceUsd, null);
  assert.equal(data.quotas[2].currency, null);
});

test("Muse Code display names keep its canonical client id and reported token count", () => {
  const data = normalizeOverview({ totals: { today: {
    totalTokens: 50, clients: { muse: 50 }, models: { "gpt-5": 50 }, clientModels: { muse: { "gpt-5": 50 } },
  } } });
  const client = data.periods.today.clients[0];
  assert.equal(client.id, "muse");
  assert.equal(client.name, "Muse Code");
  assert.equal(client.totalTokens, 50);
  assert.deepEqual(data.periods.today.clientModels, { muse: { "gpt-5": 50 } });
});
