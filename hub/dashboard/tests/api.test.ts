import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { loadDashboard, isAuthFailure } from "../src/api";
const require=createRequire(import.meta.url);
const fixture=require('./fixtures/overview.json');
const original=globalThis.fetch;

test('overview is delivered before auxiliary requests settle', async () => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => {release=resolve;});
  const calls: string[]=[];
  globalThis.fetch=async input => {
    const path=String(input);calls.push(path);
    if(path.endsWith('/overview')) return Response.json(fixture);
    await waiting; return Response.json({});
  };
  try {
    let delivered=false;
    let firstNotices: string[] = [];
    const loaded=loadDashboard('fixture',undefined,(value) => {
      delivered=true;
      firstNotices=value.notices;
    });
    await new Promise(resolve => setTimeout(resolve,0));
    assert.equal(delivered,true);assert.equal(calls.length,4);
    assert.ok(!firstNotices.some((notice) => /未载入/.test(notice)));
    release();await loaded;
  } finally {release();globalThis.fetch=original;}
});
test('capabilities disabled by the backend cause no auxiliary request or missing-data warning', async () => {
  const calls: string[]=[];
  globalThis.fetch=async input => {calls.push(String(input));return Response.json({...fixture,features:{subscriptions:false,provider_status:false,history_daily:false}});};
  try {const data=await loadDashboard('fixture');assert.equal(calls.length,1);assert.ok(!data.notices.some(n=>/未能加载/.test(n)));}finally{globalThis.fetch=original;}
});
test('auxiliary authorization failures expire the session rather than appearing as missing data', async () => {
  globalThis.fetch=async input => String(input).endsWith('/overview') ? Response.json(fixture) : Response.json({}, {status:401});
  try {await assert.rejects(()=>loadDashboard('fixture'),error=>isAuthFailure(error));}finally{globalThis.fetch=original;}
});
test('auxiliary outage preserves primary counts and marks incomplete loading', async () => {
  globalThis.fetch=async input => String(input).endsWith('/overview') ? Response.json(fixture) : Response.json({}, {status:503});
  try {const data=await loadDashboard('fixture');assert.ok(data.periods.today.totalTokens>0);assert.ok(data.notices.some(n=>n.includes('订阅信息暂时未能加载')));}finally{globalThis.fetch=original;}
});
test('auxiliary outage keeps previous live subscriptions providers and matching costs', async () => {
  const live = async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith('/overview')) return Response.json(fixture);
    if (path.includes('/subscriptions')) return Response.json({
      subscriptions: [{ id: 'sub-1', provider: 'openai', planName: 'Plus' }],
      updated_at: '2026-09-15T00:00:00Z',
    });
    if (path.includes('/provider-status')) return Response.json({
      providers: [{ provider: 'openai', name: 'OpenAI', status: 'operational' }],
    });
    if (path.includes('/history')) return Response.json({
      items: [{ day: '2026-08-25', tokens: 1846320, costUsd: 1.25, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, unclassifiedTokens: 0 }],
    });
    return Response.json({});
  };
  globalThis.fetch = live;
  try {
    const previous = await loadDashboard('fixture');
    assert.equal(previous.subscriptions.length, 1);
    assert.equal(previous.providers.length, 1);
    assert.equal(previous.trend.find((point) => point.day === '2026-08-25')?.costUsd, 1.25);
    globalThis.fetch = async (input) => String(input).endsWith('/overview')
      ? Response.json(fixture)
      : Response.json({}, { status: 502 });
    const data = await loadDashboard('fixture', undefined, undefined, previous);
    assert.equal(data.subscriptions.length, 1);
    assert.equal(data.subscriptions[0]?.id, 'sub-1');
    assert.equal(data.subscriptionsUpdatedAt, '2026-09-15T00:00:00Z');
    assert.equal(data.providers.length, 1);
    const day = data.trend.find((point) => point.day === '2026-08-25');
    assert.equal(day?.costUsd, 1.25);
    assert.equal(day?.costStale, true);
    assert.ok(data.notices.some((notice) => notice.includes('订阅信息暂时未能加载')));
    assert.ok(data.notices.some((notice) => notice.includes('沿用上次的费用')));
  } finally {
    globalThis.fetch = original;
  }
});
test('successful empty auxiliary lists replace previous live data', async () => {
  const live = async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith('/overview')) return Response.json(fixture);
    if (path.includes('/subscriptions')) return Response.json({
      subscriptions: [{ id: 'sub-1', provider: 'openai', planName: 'Plus' }],
    });
    if (path.includes('/provider-status')) return Response.json({
      providers: [{ provider: 'openai', name: 'OpenAI', status: 'operational' }],
    });
    return Response.json({ items: [] });
  };
  try {
    globalThis.fetch = live;
    const previous = await loadDashboard('fixture');
    assert.equal(previous.subscriptions.length, 1);
    assert.equal(previous.providers.length, 1);
    globalThis.fetch = async (input) => {
      const path = String(input);
      if (path.endsWith('/overview')) return Response.json(fixture);
      if (path.includes('/subscriptions')) return Response.json({ subscriptions: [] });
      if (path.includes('/provider-status')) return Response.json({ providers: [] });
      return Response.json({ items: [] });
    };
    const data = await loadDashboard('fixture', undefined, undefined, previous);
    assert.equal(data.subscriptions.length, 0);
    assert.equal(data.providers.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});
test('failed daily costs are not reused when token totals no longer match', async () => {
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path.endsWith('/overview')) return Response.json(fixture);
    if (path.includes('/history')) return Response.json({
      items: [{ day: '2026-08-25', tokens: 1846320, costUsd: 1.25 }],
    });
    if (path.includes('/subscriptions')) return Response.json({ subscriptions: [] });
    if (path.includes('/provider-status')) return Response.json({ providers: [] });
    return Response.json({});
  };
  try {
    const previous = await loadDashboard('fixture');
    const changed = structuredClone(previous);
    const point = changed.trend.find((row) => row.day === '2026-08-25');
    if (point) point.totalTokens = 99;
    globalThis.fetch = async (input) => String(input).endsWith('/overview')
      ? Response.json(fixture)
      : Response.json({}, { status: 502 });
    const data = await loadDashboard('fixture', undefined, undefined, changed);
    assert.equal(data.trend.find((row) => row.day === '2026-08-25')?.costUsd, null);
  } finally {
    globalThis.fetch = original;
  }
});
