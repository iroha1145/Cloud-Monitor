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
    const loaded=loadDashboard('fixture',undefined,() => {delivered=true;});
    await new Promise(resolve => setTimeout(resolve,0));
    assert.equal(delivered,true);assert.equal(calls.length,4);
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
