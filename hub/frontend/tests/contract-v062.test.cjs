"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../tm.js"), "utf8");
const context = { dashTz: () => "UTC" };
vm.createContext(context);
const helpers = source.slice(source.indexOf("const esc ="), source.indexOf("/* 邮箱打码"))
  + source.slice(source.indexOf("function sessionPresentation("), source.indexOf("/* ---------- 会话明细"))
  + source.slice(source.indexOf("function quotaNumber("), source.indexOf("/* ================= 渲染层 · 配额与订阅"));
vm.runInContext(helpers, context);
const NOW = Date.parse("2026-09-26T12:00:00Z");
const session = { lastUsedAt: new Date(NOW - 60_000).toISOString(), deviceStale: false, turnEnded: false, contextTokens: 12000, contextWindow: 128000 };

test("money, points, requests and tokens never share an assumed dollar unit", () => {
  assert.equal(context.quotaAmount(0, "CREDITS"), "0 点");
  assert.equal(context.quotaAmount(12.5, "CNY"), "¥12.50 CNY");
  assert.equal(context.quotaAmount(3, "", "REQUESTS"), "3 次");
  assert.equal(context.quotaAmount(1500, "TOKENS"), "1,500 tokens");
  assert.equal(context.quotaAmount(2.5), "2.5（单位未提供）");
  for (const bad of [null, undefined, "", " ", true, [], {}, Infinity]) assert.equal(context.quotaAmount(bad), "未知");
});

test("credits keep actual zero balance even with a meter, spend preserves currency", () => {
  const info = context.quotaWindowInfo({ metric: "credits", currency: "CREDITS", remaining: 0, limit: 50, usedPercent: 100 });
  assert.match(info.text, /剩余 0 点.*上限 50 点/);
  assert.equal(info.percent, null);
  assert.match(context.quotaWindowInfo({ metric: "spend", currency: "CNY", used: 15 }).text, /已用 ¥15.00 CNY/);
  assert.doesNotMatch(context.quotaWindowInfo({ metric: "spend", used: 15 }).text, /\$/);
  assert.equal(context.quotaWindowInfo({ usedPercent: null }).text, "用量未知");
});

test("boundary labels distinguish expiry, reset and mixed events", () => {
  for (const [kind,label] of [["expiry","到期于"],["mixed","额度变化于"],[undefined,"重置于"]]) {
    assert.match(context.quotaWindowInfo({resetsAt:"2099-01-01T00:00:00Z",boundaryKind:kind}).text,new RegExp(label));
  }
  assert.equal(context.fmtReset(null), "");
});

test("session state requires explicit fresh evidence and ages after ten minutes", () => {
  assert.equal(context.sessionPresentation(session, [], NOW).status, "运行中");
  assert.equal(context.sessionPresentation({...session,archived:true}, [], NOW).status, "闲置");
  assert.equal(context.sessionPresentation({archived:true}, [], NOW).status, "闲置");
  assert.match(context.sessionPresentation({...session,archived:true}, [], NOW).context, /上次上报/);
  assert.equal(context.sessionPresentation({...session,turnEnded:true}, [], NOW).status, "已完成");
  for (const changed of [{deviceStale:true},{lastUsedAt:new Date(NOW-600_001).toISOString()}]) {
    const display = context.sessionPresentation({...session,...changed}, [], NOW);
    assert.equal(display.status,"闲置");
    assert.match(display.context,/上次上报/);
  }
  for (const changed of [{turnEnded:undefined},{deviceStale:undefined},{lastUsedAt:null},{lastUsedAt:new Date(NOW+1).toISOString()}]) {
    assert.equal(context.sessionPresentation({...session,...changed}, [], NOW).status,"状态未提供");
  }
  assert.match(context.sessionPresentation(session,[],NOW).context,/116,000 \/ 128,000/);
  assert.equal(context.sessionPresentation({...session,contextWindow:0},[],NOW).context,"上下文未提供");
  assert.match(context.sessionPresentation({...session,contextWindow:10000},[],NOW).context,/超出容量 2,000/);
});

test("reset grants and provider summaries retain counts, flags and escape content", () => {
  const html=context.resetCreditsHtml({availableCount:2,grants:[{label:"<img onerror=alert(1)>",resetsLeft:1,resetsTotal:2,usableNow:false,useRequiresLimit:true,clears:["weekly"]}]});
  assert.match(html,/剩余 2 次/); assert.match(html,/当前不可用/); assert.match(html,/达到限额后可使用/);
  assert.match(html,/每周额度/); assert.doesNotMatch(html,/<img/);
  assert.match(context.resetCreditsHtml({availableCount:0}),/剩余 0 次/);
  assert.equal(context.resetCreditsHtml(null),"");
  const summary=context.usageSummaryHtml({period:"today",requests:3,totalTokens:1500,actualCost:1.25,averageDurationMs:1500});
  assert.match(summary,/请求 3 次/); assert.match(summary,/1,500 tokens/); assert.match(summary,/1.25（单位未提供）/); assert.match(summary,/1.5 秒/);
});
