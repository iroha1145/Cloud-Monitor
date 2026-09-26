const path = require("node:path");
const { test, expect } = require("@playwright/test");
const { loginWithToken, sampleOverview, stubOverview } = require("./helpers");
let base;
test.beforeAll(async ({browser,baseURL}) => { base=(await sampleOverview(browser,baseURL)).payload; });
function payload() {
  const p=structuredClone(base);
  const now=Date.now();
  p.devices=[{deviceId:"live",hostname:"当前设备",stale:false},{deviceId:"old",hostname:"过期设备",stale:true}];
  p.sessions=[
    {sessionId:"active-062",client:"codex",deviceId:"live",turnEnded:false,lastUsedAt:new Date(now-1000).toISOString(),contextTokens:12000,contextWindow:128000,tokens:10,sessionKind:"background-review"},
    {sessionId:"stale-062",client:"claude",deviceId:"old",turnEnded:false,lastUsedAt:new Date(now-2000).toISOString(),contextTokens:200,contextWindow:1000,tokens:10},
    {sessionId:"archived-062",client:"codex",deviceId:"live",turnEnded:false,archived:true,lastUsedAt:new Date(now-2500).toISOString(),contextTokens:200,contextWindow:1000,tokens:10},
    {sessionId:"unknown-062",client:"cline",lastUsedAt:new Date(now-3000).toISOString(),tokens:0},
  ];
  p.limits=[
    {provider:"workbuddy",balance:{amount:0,currency:"CREDITS"},actionRequired:"appSessionEncrypted",windows:[{kind:"billing",label:"点数余额",metric:"credits",remaining:0,usedPercent:100,currency:"CREDITS",resetsAt:"2099-01-01T00:00:00Z",boundaryKind:"expiry"}]},
    {provider:"codex",resetCredits:{availableCount:0,nextExpiresAt:"2099-01-01T00:00:00Z"},windows:[{kind:"daily",label:"每日独立额度",limitId:"extra",additional:true,usedPercent:30,resetsAt:"2099-01-01T00:00:00Z",boundaryKind:"mixed"}]},
    {provider:"claude",resetCredits:{availableCount:2,grants:[{label:"<script>bad</script>赠送券",resetsLeft:2,usableNow:false,useRequiresLimit:true,clears:["weekly"]}]},windows:[]},
    {provider:"thirdparty",adapterId:"sub2api",usageSummary:{period:"today",requests:3,totalTokens:1500,actualCost:2.5},windows:[{kind:"billing",label:"消费",metric:"spend",used:12,currency:"CNY"}]},
    {provider:"typesafe",windows:[{kind:"billing",label:"未知单位",metric:"spend",used:7}]},
  ];
  return p;
}
async function open(page,context,hash="") {
  await loginWithToken(context); await stubOverview(page,payload()); await page.goto("/"+hash); await expect(page.locator("#shell")).toBeVisible();
}
for(const width of [1440,390]) {
  test(`v0.62 quota evidence remains readable at ${width}px`,async({page,context})=>{
    await page.setViewportSize({width,height:900}); await open(page,context,"#quota");
    const grid=page.locator("#lim-grid");
    await expect(grid).toContainText("剩余 0 点"); await expect(grid).toContainText("到期于"); await expect(grid).toContainText("额度变化于");
    await expect(grid).toContainText("重新登录不会解除此限制"); await expect(grid).toContainText("重置券 · 剩余 0 次");
    await expect(grid).toContainText("当前不可用"); await expect(grid).toContainText("达到限额后可使用"); await expect(grid).toContainText("Sub2API");
    await expect(grid).toContainText("请求 3 次"); await expect(grid).toContainText("1,500 tokens"); await expect(grid).toContainText("¥12.00 CNY");
    await expect(grid).toContainText("7（单位未提供）"); await expect(grid.locator("script")).toHaveCount(0);
    await expect(grid.locator(".lim-card").first().locator(".ring")).toHaveCount(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await page.screenshot({path:path.join(__dirname,"evidence",`v062-quota-${width}.png`),fullPage:true,animations:"disabled"});
  });
  test(`v0.62 sessions require fresh device evidence at ${width}px`,async({page,context})=>{
    await page.setViewportSize({width,height:900}); await open(page,context);
    const active=page.locator("#sess-body tr").filter({hasText:"active-062"});
    await expect(active).toContainText("运行中"); await expect(active).toContainText("后台审查"); await expect(active).toContainText("116,000 / 128,000 tokens");
    const stale=page.locator("#sess-body tr").filter({hasText:"stale-062"});
    await expect(stale).toContainText("闲置"); await expect(stale).toContainText("上次上报");
    await expect(page.locator("#sess-body tr").filter({hasText:"archived-062"})).toContainText("闲置");
    await expect(page.locator("#sess-body tr").filter({hasText:"unknown-062"})).toContainText("状态未提供");
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  });
}

test("session state ages after network failure without a new overview", async ({page,context}) => {
  await page.clock.install();
  await open(page,context);
  const active=page.locator("#sess-body tr").filter({hasText:"active-062"});
  await expect(active).toContainText("运行中");
  await page.route("**/api/v1/tm/overview*",route=>route.abort());
  await page.clock.fastForward(11*60*1000);
  await expect(active).toContainText("闲置");
  await expect(active).toContainText("上次上报");
});
