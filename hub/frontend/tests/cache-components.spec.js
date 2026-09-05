// Cache regressions use the vendored Hub to aggregate synthetic device records.
// Only overview is intercepted; the normal app, login, and other endpoints run
// against the existing FastAPI test server.
const { test, expect } = require("@playwright/test");
const path = require("node:path");
const { aggregateDevices, extractUsageFromTokscale, normalizePeriod } =
  require("../../tm-core/vendor/src/shared/usage.js");
const { loginWithToken, sampleOverview, stubOverview } = require("./helpers");

const ORIGIN = `http://127.0.0.1:${process.env.CM_E2E_PORT || 18787}`;
const PERIODS = ["today", "month", "allTime"];
const MODEL = "gpt-6-astra";
let base;

test.beforeAll(async ({ browser }) => {
  base = (await sampleOverview(browser, ORIGIN)).payload;
});

function overviewWithUnknownInput(sharedModel = false) {
  const native = extractUsageFromTokscale({ entries: [
    { client: "codex", model: MODEL, input: 20, output: 15, reasoning: 5, cacheRead: 65, cacheWrite: 0 },
    { client: "claude", model: "claude-opus-4.6", input: 10, output: 10, cacheRead: 30, cacheWrite: 0 },
  ] });
  const unknownModel = sharedModel ? MODEL : "cursor-unknown";
  const cursor = normalizePeriod({
    capabilities: { tokenComponents: false },
    totalTokens: 30,
    outputTokens: 10,
    unclassifiedTokens: 20,
    clients: { cursor: 30 },
    clientOutputs: { cursor: 10 },
    clientUnclassifiedTokens: { cursor: 20 },
    models: { [unknownModel]: 30 },
    modelOutputs: { [unknownModel]: 10 },
    modelUnclassifiedTokens: { [unknownModel]: 20 },
    clientModels: { cursor: { [unknownModel]: 30 } },
  });
  const now = Date.now();
  const devices = [native, cursor].map((period, index) => ({
    deviceId: `cache-regression-${index}`,
    hostname: `cache-regression-${index}`,
    updatedAt: new Date(now).toISOString(),
    ...Object.fromEntries(PERIODS.map((key) => [key, structuredClone(period)])),
  }));
  const payload = structuredClone(base);
  payload.totals = aggregateDevices(devices, undefined, now).periods;
  return payload;
}

async function openPayload(page, context, payload) {
  await loginWithToken(context);
  await stubOverview(page, payload);
  await page.goto("/");
  await expect(page.locator("#shell")).toBeVisible();
}

function modelRow(page, name) {
  return page.locator("#model-dist .donut-lg-row").filter({
    has: page.locator(`.donut-lg-name[title="${name}"]`),
  });
}

function clientRow(page, name) {
  return page.locator("#client-dist .dist-row").filter({
    has: page.locator(`.dist-name[title="${name}"]`),
  });
}

for (const periodName of PERIODS) {
  test(`${periodName}: mixed devices retain model cache, client components, and unknown input`, async ({ page, context }) => {
    const payload = overviewWithUnknownInput();
    expect(payload.totals[periodName].capabilities.tokenComponents).toBe(false);
    await openPayload(page, context, payload);

    await page.click(`#model-seg button[data-p="${periodName}"]`);
    await modelRow(page, MODEL).hover();
    const tip = page.locator(".float-tip.is-shown");
    await expect(tip).toContainText(MODEL);
    await expect(tip.locator(".tip-row").filter({ hasText: "缓存率" })).toContainText("65%");
    await expect(tip.locator(".tip-row").filter({ hasText: "缓存读取" })).toContainText("65");
    await modelRow(page, "cursor-unknown").hover();
    await expect(tip).toContainText("cursor-unknown");
    await expect(tip).not.toContainText("缓存率");
    await expect(tip).not.toContainText("已识别缓存占比");

    await page.click(`#client-seg button[data-p="${periodName}"]`);
    await expect(page.locator("#client-dist-sub")).toContainText("部分来源未知");
    const codex = clientRow(page, "codex");
    await expect(codex.locator(".seg-cacher")).toHaveCount(1);
    await expect(codex.locator(".seg-cacher")).toHaveAttribute("style", /width:65\.00%/);
    await expect(codex.locator(".seg-input")).toHaveAttribute("style", /width:20\.00%/);
    const cursor = clientRow(page, "cursor");
    await expect(cursor.locator(".seg-uncls")).toHaveCount(1);
    await expect(cursor.locator(".seg-input")).toHaveCount(0);
    await cursor.locator(".dist-track").hover();
    await expect(tip).toContainText("未分类");
    await expect(tip).not.toContainText("非缓存输入");
  });
}

test("today overview displays exact known cache beside unclassified usage", async ({ page, context }) => {
  await openPayload(page, context, overviewWithUnknownInput());
  const card = page.locator("#kpis .kpi-card").first();
  await expect(card.locator(".seg-cacher[data-v]")).toHaveAttribute("data-v", "95");
  await expect(card.locator(".seg-uncls[data-v]")).toHaveAttribute("data-v", "20");
  await expect(card.locator(".seg-input[data-v]")).toHaveAttribute("data-v", "30");
  await expect(card.locator(".kpi-legend")).toContainText("缓存读");
  await expect(card.locator(".kpi-mix-note")).toContainText("未分类");
});

test("a model shared by complete and partial devices labels its identified cache share", async ({ page, context }) => {
  await openPayload(page, context, overviewWithUnknownInput(true));
  await modelRow(page, MODEL).hover();
  const tip = page.locator(".float-tip.is-shown");
  await expect(tip.locator(".tip-row").filter({ hasText: "缓存读取" })).toContainText("65");
  await expect(tip.locator(".tip-row").filter({ hasText: "已识别缓存占比" })).toContainText("50%");
  await expect(tip).not.toContainText("缓存率");
  await expect(tip).toContainText("未分类");
});

test("empty periods do not display a partial-composition warning", async ({ page, context }) => {
  const payload = structuredClone(base);
  payload.totals = aggregateDevices([]).periods;
  await openPayload(page, context, payload);
  await expect(page.locator("#model-empty")).toBeVisible();
  await expect(page.locator("#client-empty")).toBeVisible();
  await expect(page.locator("#client-dist-sub")).not.toContainText("部分来源未知");
  await expect(page.locator("#kpis .kpi-mix-note")).toHaveCount(0);
});

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 375, height: 812 },
]) {
  test.describe(`cache evidence ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height }, reducedMotion: "reduce" });
    test("known cache remains readable with partial usage", async ({ page, context }) => {
      await openPayload(page, context, overviewWithUnknownInput());
      await modelRow(page, MODEL).hover();
      const tip = page.locator(".float-tip.is-shown");
      await expect(tip).toContainText("缓存读取");
      await expect(tip).toContainText("65%");
      await expect(tip).toHaveCSS("opacity", "1");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({
        path: path.join(__dirname, "evidence", `cache-components-${viewport.name}.png`),
        fullPage: false,
        animations: "disabled",
      });
    });
  });
}
