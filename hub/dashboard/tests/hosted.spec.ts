import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { revealAll } from "./motion-helpers";
const require = createRequire(import.meta.url);
const READ_TOKEN = "b".repeat(32);
const WRITE_TOKEN = "a".repeat(32);
const overviewFixture = require("./fixtures/overview.json");
const injectAxe = async (page: import("@playwright/test").Page) => {
  await page.route("**/static/app/__test-axe.js", route => route.fulfill({ contentType: "text/javascript", path: require.resolve("axe-core/axe.min.js") }));
  await page.addScriptTag({ url: "/static/app/__test-axe.js" });
};
const login = async (page: import("@playwright/test").Page) => {
  await page.goto("/");
  await page.getByLabel("访问密钥", { exact: true }).fill(READ_TOKEN);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.getByText("当前展示真实数据")).toBeAttached();
  await expect(page.getByRole("button", { name: "查看 gpt-5.2 详情" })).toBeVisible();
};

for (const timeZone of ["Asia/Tokyo", "America/Los_Angeles"]) {
  test(`real dashboard and archive follow browser timezone ${timeZone}`, async ({ browser }) => {
    const context = await browser.newContext({ baseURL: "http://127.0.0.1:18888", timezoneId: timeZone });
    try {
      const page = await context.newPage();
      const overviewResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/tm/overview");
      await login(page);
      const response = await overviewResponse;
      expect(response.request().headers()["x-cm-time-zone"]).toBe(timeZone);
      const overview = await response.json();
      expect(overview.dashboard_time_zone).toBe(timeZone);
      expect(overview.activity.time_zone).toBe(timeZone);
      expect(overview.activity.hourly_today.time_zone).toBe(timeZone);
      await expect(page.locator(".heading-kicker")).toContainText(timeZone);
      const archiveResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/tm/history/daily");
      await page.getByRole("link", { name: "历史记录", exact: true }).first().click();
      const archive = await archiveResponse;
      expect(archive.request().headers()["x-cm-time-zone"]).toBe(timeZone);
      expect((await archive.json()).dashboard_time_zone).toBe(timeZone);
      await expect(page.locator(".archive-panel")).toContainText(timeZone);
    } finally {
      await context.close();
    }
  });
}

test("queued upload recovers into real history and visible model data after the worker confirms it", async ({ page, request }) => {
  const readHeaders = { Authorization: `Bearer ${READ_TOKEN}` };
  const ingestHeaders = { "X-Token-Monitor-Secret": "unit-tm-secret-0123456789abcdef0000" };
  const deviceId = "recovery-real-device";
  const control = (operation: string) => request.post(`/__test/forwarding/${operation}`, { headers: readHeaders });
  expect((await control("block")).status()).toBe(200);
  try {
    const stamp = new Date().toISOString();
    const response = await request.post("/api/ingest", {
      headers: ingestHeaders,
      data: {
        deviceId, hostname: "recovery-fixture", updatedAt: stamp,
        periodWindows: { timeZone: "UTC", today: { key: stamp.slice(0, 10) } },
        today: { totalTokens: 4242424, models: { "recovery-check": 4242424 }, clients: { codex: 4242424 } },
      },
    });
    expect(response.status()).toBe(503);
    await login(page);
    await expect(page.locator(".workspace-notices")).toContainText("等待服务恢复");
    await expect(page.getByRole("button", { name: "查看 recovery-check 详情", exact: true })).toHaveCount(0);
    expect((await control("resume")).status()).toBe(200);
    await expect.poll(async () => {
      const overview = await request.get("/api/v1/tm/overview", { headers: readHeaders });
      return (await overview.json()).forwarding_outbox;
    }).toBe(0);
    await page.getByRole("button", { name: "刷新数据", exact: true }).click();
    await expect(page.getByRole("button", { name: "查看 recovery-check 详情", exact: true })).toBeVisible();
    await expect(page.locator(".workspace-notices")).not.toContainText("等待服务恢复");
    const history = await request.get("/api/v1/tm/history/daily", { headers: readHeaders });
    expect((await history.json()).items.some((row: { perModel?: Record<string, number> }) =>
      row.perModel?.["recovery-check"] === 4242424)).toBe(true);
    await page.reload();
    await expect(page.getByRole("button", { name: "查看 recovery-check 详情", exact: true })).toBeVisible();
  } finally {
    await control("resume");
    await request.delete(`/api/devices/${deviceId}`, { headers: ingestHeaders });
  }
});

test("real ingest supplies period-specific session and model detail while legacy zeros remain unknown", async ({ browser, request }) => {
  const readHeaders = { Authorization: `Bearer ${READ_TOKEN}` };
  const ingestHeaders = { "X-Token-Monitor-Secret": "unit-tm-secret-0123456789abcdef0000" };
  const fixtureResponse = await request.get("/__test/session-details", { headers: readHeaders });
  expect(fixtureResponse.status()).toBe(200);
  const fixture = await fixtureResponse.json();
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:18888", timezoneId: "UTC" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const value = (scope: import("@playwright/test").Locator, label: string) =>
    scope.locator("dt").filter({ hasText: new RegExp(`^${label}$`) }).locator("..").locator("dd");
  try {
    for (const payload of fixture.payloads) {
      const response = await request.post("/api/ingest", { headers: ingestHeaders, data: payload });
      expect(response.status()).toBe(200);
    }
    // Inspect the real overview before opening the built UI: this proves that
    // normalization and the Python boundary carried independent period values.
    const overviewResponse = await request.get("/api/v1/tm/overview", { headers: readHeaders });
    expect(overviewResponse.status()).toBe(200);
    const overview = await overviewResponse.json();
    const today = overview.sessions_by_period.today.find((row: { sessionId: string }) => row.sessionId === "detailed-mixed");
    const month = overview.sessions_by_period.month.find((row: { sessionId: string }) => row.sessionId === "detailed-mixed");
    expect(today).toMatchObject({ tokens: 16000, inputTokens: 3600, outputTokens: 2400, cacheReadTokens: 9000, cacheWriteTokens: 1000, reasoningTokens: 800, messageCount: 12 });
    expect(month).toMatchObject({ tokens: 48000, inputTokens: 10800, outputTokens: 7200, cacheReadTokens: 27000, cacheWriteTokens: 3000, reasoningTokens: 2400, messageCount: 36 });
    const legacyRow = overview.sessions_by_period.today.find((row: { sessionId: string }) => row.sessionId === "legacy-missing");
    expect(legacyRow).toMatchObject({ zeroValuesUnconfirmed: true, inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, messageCount: 0, costUsd: 0, contextTokens: 0 });
    expect(overview.sessions_by_period.allTime).toEqual([]);
    expect(overview.sessions_meta_by_period.allTime.reason).toBe("not-synced");
    const detailDevice = overview.devices.find((device: { deviceId: string }) => device.deviceId === "session-details-real-device");
    expect(detailDevice.today.modelThroughput["detail-model-primary"]).toMatchObject({ timedOutputTokens: 1500, timedDurationMs: 37500 });
    // A legacy device has unknown model timing. Upstream deliberately withholds
    // the combined map rather than turn partial device timing into a global rate.
    expect(overview.totals.today.modelThroughput).toBeUndefined();
    await login(page);
    await page.getByRole("button", { name: "查看 detail-model-primary 详情", exact: true }).click();
    let dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("今日用量详情");
    await expect(dialog.getByRole("region", { name: "模型输出速度" })).toHaveCount(0);
    await expect(dialog.getByRole("region", { name: "模型的客户端来源" })).toContainText("Codex");
    const mixed = dialog.locator(".session-usage-card").filter({ hasText: "detail-fixture-project" });
    await mixed.locator(":scope > summary").click();
    await expect(mixed.locator(".session-card-amount")).toContainText("1.0 万");
    await expect(mixed.locator(".session-scope-note")).toContainText("整个会话的统计");
    await expect(mixed.locator(".session-current-line")).toContainText("本模型费用 $0.30");
    for (const [label, expected] of [["非缓存输入", "3,600"], ["输出", "2,400"], ["缓存读取", "9,000"], ["缓存写入", "1,000"], ["其中推理", "800"]]) {
      await expect(value(mixed, label)).toHaveText(expected);
    }
    await expect(value(mixed, "已记录消息")).toHaveText("12 条");
    await expect(value(mixed, "输出速率")).toHaveText("40.0 词元/秒");
    await expect(value(mixed, "完整用量")).toHaveText("16,000 词元");
    await expect(mixed.getByRole("region", { name: "上次上报的上下文", exact: true })).toContainText("104.0%");
    await expect(mixed.locator(`time[datetime="${fixture.expected.startedAt}"]`)).toBeVisible();
    await expect(mixed.locator(`time[datetime="${fixture.expected.lastUsedAt}"]`)).toBeVisible();
    await mixed.getByText("来源与模型", { exact: true }).click();
    await expect(value(mixed, "会话标识")).toHaveText("detailed-mixed");
    await expect(value(mixed, "项目标识")).toHaveText("detail-fixture-project");
    await expect(value(mixed, "原生会话标识")).toHaveText("11223344-1234-4abc-8abc-1234567890ab");
    await expect(value(mixed, "关联会话标识（T3）")).toHaveText("fixture-thread");
    await expect(value(mixed, "提供商 · OpenAI")).toHaveText("16,000 词元");
    await expect(value(mixed, "父级会话")).toContainText("fixture-parent");
    await expect(mixed.locator(".session-model-ledger")).toContainText("detail-model-secondary");

    const legacy = dialog.locator(".session-usage-card").filter({ hasText: "legacy-fixture-project" });
    await legacy.locator(":scope > summary").click();
    await expect(value(legacy, "非缓存输入")).toHaveText("1,000");
    for (const label of ["输出", "缓存读取", "缓存写入", "其中推理", "已记录消息", "估算费用"]) {
      await expect(value(legacy, label)).toHaveText("未提供");
    }
    await expect(legacy).toContainText("部分零值无法确认，显示为未提供");
    await expect(legacy.locator(".session-context-block")).toHaveCount(0);
    await expect(legacy).not.toContainText("$0.00");
    await expect(dialog.locator(".local-detail-note")).toHaveCount(1);
    await page.keyboard.press("Escape");

    await page.getByRole("tablist", { name: "统计周期" }).getByRole("tab", { name: "本月", exact: true }).click();
    await page.getByRole("button", { name: "查看 detail-model-primary 详情", exact: true }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("本月用量详情");
    const monthCard = dialog.locator(".session-usage-card").filter({ hasText: "detail-fixture-project" });
    await monthCard.locator(":scope > summary").click();
    for (const [label, expected] of [["非缓存输入", "10,800"], ["输出", "7,200"], ["缓存读取", "27,000"], ["缓存写入", "3,000"], ["其中推理", "2,400"], ["已记录消息", "36 条"], ["完整用量", "48,000 词元"]]) {
      await expect(value(monthCard, label)).toHaveText(expected);
    }
    await expect(monthCard.locator(".session-current-line")).toContainText("本模型费用 $0.90");
    await page.keyboard.press("Escape");
    await page.getByRole("tablist", { name: "统计周期" }).getByRole("tab", { name: "累计", exact: true }).click();
    await page.getByRole("button", { name: "查看 detail-model-primary 详情", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("未同步全部历史会话");
    await expect(page.getByRole("dialog").locator(".session-usage-card")).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    for (const payload of fixture.payloads) {
      await request.delete(`/api/devices/${payload.deviceId}`, { headers: ingestHeaders });
    }
  }
});

for (const authentication of ["manual", "restored"] as const) {
  test(`hosted ${authentication} login loads one complete batch and keeps scheduled refreshes`, async ({ page }) => {
    const counts = { overview: 0, subscriptions: 0, "provider-status": 0, daily: 0 };
    const overview = {
      ...overviewFixture,
      features: { ...overviewFixture.features, subscriptions: true, provider_status: true, history_daily: true },
    };
    let allowRefresh = false;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    await page.clock.install();
    await page.route("**/api/v1/tm/**", async route => {
      const endpoint = new URL(route.request().url()).pathname.split("/").at(-1)! as keyof typeof counts;
      if (!(endpoint in counts)) return route.continue();
      counts[endpoint] += 1;
      // Hold an unexpected second batch so a partial overview cannot hide
      // behind fast ancillary responses, as it could in the original test.
      if (endpoint !== "overview" && counts[endpoint] > 1 && !allowRefresh) await blocked;
      const json = endpoint === "overview" ? overview :
        endpoint === "subscriptions" ? { subscriptions: [] } :
        endpoint === "provider-status" ? require("./fixtures/provider-status.json") : { items: [] };
      await route.fulfill({ json }).catch(() => {});
    });
    try {
      if (authentication === "restored") {
        await page.addInitScript(token => sessionStorage.setItem("cm_access_token", token), READ_TOKEN);
        await page.goto("/");
      } else {
        await login(page);
      }
      await expect(page.getByText("当前展示真实数据")).toBeAttached();
      await page.clock.runFor(100);
      expect(counts).toEqual({ overview: 1, subscriptions: 1, "provider-status": 1, daily: 1 });
      await expect(page.getByText(/未载入订阅清单|未载入服务商状态/)).toHaveCount(0);

      allowRefresh = true;
      release();
      await page.clock.fastForward(300000);
      await expect.poll(() => counts).toEqual({ overview: 2, subscriptions: 2, "provider-status": 2, daily: 2 });
      await expect(page.getByText(/未载入订阅清单|未载入服务商状态/)).toHaveCount(0);

      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await expect.poll(() => counts).toEqual({ overview: 3, subscriptions: 3, "provider-status": 3, daily: 3 });
      await expect(page.getByText(/未载入订阅清单|未载入服务商状态/)).toHaveCount(0);
    } finally {
      release();
    }
  });
}

test("production gate, real auth and static resources work under the server CSP", async ({ page, request }) => {
  const failures: string[] = [];
  page.on("pageerror", error => failures.push(error.message));
  const calls: string[] = [];
  page.on("request", request => { if (request.url().includes("/api/")) calls.push(request.url()); });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "查看你的用量" })).toBeVisible();
  expect(calls).toEqual([]);
  await expect(page.getByText("当前展示示例数据")).toHaveCount(0);
  const root = await request.get("/");
  expect(root.headers()["content-security-policy"]).toContain("script-src 'self'");
  expect(await root.text()).toContain("/static/app/assets/");
  const unauthorized = await request.get("/api/v1/tm/overview");
  expect([401,403]).toContain(unauthorized.status());
  await page.getByLabel("访问密钥", { exact: true }).fill(WRITE_TOKEN);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.getByRole("alert")).toContainText("访问密钥不正确");
  await page.getByLabel("访问密钥", { exact: true }).fill(READ_TOKEN);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.getByText("当前展示真实数据")).toBeAttached();
  await expect(page.getByText("未载入订阅清单")).toHaveCount(0);
  await expect(page.getByText("未载入服务商状态")).toHaveCount(0);
  await page.getByRole("button", { name: "查看 gpt-5.2 详情" }).click();
  await expect(page.getByRole("dialog").getByText("28.6 万", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  const stored = await page.evaluate(() => ({ session: sessionStorage.getItem("cm_access_token"), local: localStorage.getItem("cm_access_token") }));
  expect(stored).toEqual({ session: READ_TOKEN, local: null });
  await page.reload();
  await expect(page.getByText("当前展示真实数据")).toBeAttached();
  expect(calls.some(url => url.endsWith("/provider-status"))).toBe(false);
  expect(failures).toEqual([]);
});

test("network failures retain data and expired authorization clears both stores", async ({ page }) => {
  await login(page);
  await page.route("**/api/v1/tm/overview", route => route.abort("failed"));
  await page.getByRole("button", { name: "刷新数据", exact: true }).click();
  await expect(page.locator(".workspace-notices")).toContainText("数据刷新未完成");
  await expect(page.getByRole("button", { name: "查看 gpt-5.2 详情" })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("cm_access_token"))).toBe(READ_TOKEN);
  await page.unroute("**/api/v1/tm/overview");
  await page.route("**/api/v1/tm/overview", route => route.fulfill({ status: 401, json: { error: "expired" } }));
  await page.evaluate(() => { localStorage.setItem("cm_access_token", "stale-copy"); document.dispatchEvent(new Event("visibilitychange")); });
  await expect(page.getByRole("heading", { name: "查看你的用量" })).toBeVisible();
  expect(await page.evaluate(() => [localStorage.getItem("cm_access_token"), sessionStorage.getItem("cm_access_token")])).toEqual([null,null]);
  await expect(page.getByText("当前展示真实数据")).toHaveCount(0);
});

test("real daily cache reaches range and day details independently of the selected period", async ({ page }) => {
  await login(page);
  const trend = page.getByRole("region", { name: "用量趋势" });
  const metric = trend.locator(".insight-trend-metrics > div").last();
  await expect(metric).toContainText("已识别缓存占比");
  await expect(metric.locator("strong")).toHaveText("53.4%");
  const slider = trend.getByRole("slider");
  await slider.focus();
  await slider.press("End");
  // The day's cache rate moves into the metric header; the popup keeps the parts.
  await expect(page.locator(".insight-trend-tooltip")).toContainText("986,000");
  await expect(metric.locator("strong")).toHaveText("53.4%");
  await slider.press("Escape");
  await page.getByRole("tablist", { name: "统计周期" }).getByRole("tab").nth(1).click();
  await expect(metric.locator("strong")).toHaveText("53.4%");
});

test("built 30-day cache skips missing days, weights participating usage and keeps zero-use days harmless", async ({ page }) => {
  const payload = structuredClone(overviewFixture);
  payload.features = { subscriptions: false, provider_status: false, history_daily: false };
  payload.trend = Array.from({ length: 30 }, (_, index) => {
    const day = new Date(Date.UTC(2026, 7, 7 + index)).toISOString().slice(0, 10);
    return index < 15
      ? { day, total: 1000, costUsd: 1, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, unclassifiedTokens: 1000 }
      : { day, total: index < 22 ? 100 : 300, costUsd: 1, outputTokens: 0, cacheReadTokens: index < 22 ? 90 : 30, cacheWriteTokens: 0, unclassifiedTokens: 0 };
  });
  await page.route("**/api/v1/tm/overview", route => route.fulfill({ status: 200, json: payload }));
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const trend = page.getByRole("region", { name: "用量趋势" });
  const metric = trend.locator(".insight-trend-metrics > div").last();
  await trend.getByRole("tab", { name: "30 天", exact: true }).click();
  await expect(metric.locator("strong")).toHaveText("28.1%");
  await expect(metric).toContainText("仅统计 15/30 天");
  // Interval tokens retain the complete range, while the cache denominator
  // uses only the same 15 days as its numerator: (7*90 + 8*30)/(7*100 + 8*300).
  await expect(trend.locator(".insight-trend-metrics > div").first()).toContainText("1.8 万");
  const slider = trend.getByRole("slider");
  await slider.focus();
  await slider.press("Home");
  await expect(slider).toHaveAttribute("aria-valuetext", /2026-08-07.*缓存占比 未提供/);
  await slider.press("Escape");
  await trend.getByRole("tab", { name: "7 天", exact: true }).click();
  await expect(metric.locator("strong")).toHaveText("10.0%");
  await expect(metric).not.toContainText("仅统计");
  await trend.getByRole("tab", { name: "30 天", exact: true }).click();
  payload.trend[0].outputTokens = 0;
  payload.trend[0].cacheReadTokens = 0;
  payload.trend[0].cacheWriteTokens = 0;
  delete payload.trend[0].unclassifiedTokens;
  await page.getByRole("button", { name: "刷新数据", exact: true }).click();
  await expect(metric).toContainText("仅统计 16/30 天");
  await expect(metric).toContainText("已识别缓存占比");
  await expect(metric.locator("strong")).toHaveText("21.2%");
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await metric.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await trend.screenshot({ path: test.info().outputPath("cache-skipped-days-320.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  payload.trend[0].total = 0;
  payload.trend[0].unclassifiedTokens = 0;
  await page.getByRole("button", { name: "刷新数据", exact: true }).click();
  await expect(metric).toContainText("仅统计 16/30 天");
  await expect(metric.locator("strong")).toHaveText("28.1%");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await trend.screenshot({ path: test.info().outputPath("cache-skipped-days-mobile.png"), animations: "disabled" });
  payload.trend = payload.trend.slice(1, 15);
  await page.getByRole("button", { name: "刷新数据", exact: true }).click();
  await expect(metric.locator("strong")).toHaveText("未提供");
  await expect(metric).toContainText("暂无缓存明细");
});

test("built production and Pages menus stay at the viewport edge without changing centered settings", async ({ browser }) => {
  for (const url of ["http://127.0.0.1:18888/", "http://127.0.0.1:18900/"]) {
    const page = await browser.newPage({ baseURL: "http://127.0.0.1:18888", viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
    try {
      if (url.includes("18888")) await login(page);
      else await page.goto(url);
      await page.getByRole("button", { name: "打开导航", exact: true }).tap();
      const drawer = page.getByRole("dialog", { name: "导航", exact: true });
      await expect(drawer).toBeVisible();
      await drawer.locator('[data-mobile-navigation-trigger]').press("Home");
      await expect(drawer).toHaveAttribute("data-drawer-stop", "open");
      // The production CSS compiler can lower individual transforms into
      // transform, so this must run against built assets as well as Vite dev.
      for (const viewport of [{ width: 320, height: 740 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 844, height: 390 }]) {
        await page.setViewportSize(viewport);
        // One floating surface, centred and anchored 12px above the bottom
        // edge, min(100vw - 20px, 520px) wide when fully open and never
        // closer than 12px to the top.
        await expect.poll(async () => {
          const box = await drawer.boundingBox();
          return Boolean(box && Math.abs(box.x - (viewport.width - box.width) / 2) < 1
            && Math.abs(box.y + box.height - (viewport.height - 12)) < 1
            && box.y >= 11.5 && box.height <= viewport.height - 23.5
            && box.width > 240 && Math.abs(box.width - Math.min(520, viewport.width - 20)) < 1
            && box.x >= 0 && box.x + box.width <= viewport.width);
        }).toBe(true);
        const close = drawer.getByRole("button", { name: "关闭导航", exact: true });
        await expect(close).toBeInViewport();
        const before = await close.boundingBox();
        expect(before!.width).toBeGreaterThanOrEqual(44);
        expect(before!.height).toBeGreaterThanOrEqual(44);
        expect(before!.x).toBeGreaterThanOrEqual(0);
        expect(before!.y).toBeGreaterThanOrEqual(0);
        expect(before!.x + before!.width).toBeLessThanOrEqual(viewport.width);
        expect(before!.y + before!.height).toBeLessThanOrEqual(viewport.height);
        const navigation = drawer.getByRole("navigation", { name: "页面导航", exact: true });
        await navigation.evaluate(node => { node.scrollTop = node.scrollHeight; });
        if (viewport.height < 500) expect(await navigation.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
        await expect(close).toBeInViewport();
        expect(Math.abs((await close.boundingBox())!.y - before!.y)).toBeLessThan(1);
        await expect(drawer.getByRole("button", { name: "工作区设置", exact: true })).toBeInViewport();
      }
      await drawer.getByRole("button", { name: "关闭导航", exact: true }).tap();
      await expect(drawer).toBeHidden();
      await page.setViewportSize({ width: 1512, height: 1080 });
      await page.getByRole("button", { name: "打开工作区设置", exact: true }).click();
      const settings = page.getByRole("dialog");
      await expect(settings).toBeVisible();
      await expect.poll(async () => {
        const box = await settings.boundingBox();
        return Boolean(box && Math.abs(box.x + box.width / 2 - 756) < 1 && Math.abs(box.y + box.height / 2 - 540) < 1);
      }).toBe(true);
    } finally { await page.close(); }
  }
});

test("invalid restored keys return to the gate without showing demo data", async ({ page }) => {
  await page.addInitScript(() => { sessionStorage.setItem("cm_access_token", "invalid-fixture-key"); localStorage.setItem("cm_access_token", "stale-fixture-key"); });
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("访问密钥不正确");
  await expect(page.getByRole("heading", { name: "总览", level: 1 })).toHaveCount(0);
  expect(await page.evaluate(() => [localStorage.getItem("cm_access_token"),sessionStorage.getItem("cm_access_token")])).toEqual([null,null]);
});

test("logout cancels requests and returns to authentication", async ({ page }) => {
  await login(page);
  await page.route("**/api/v1/system/update*", route => route.fulfill({ status: 404, json: { error: "未配置在线更新" } }));
  await page.getByRole("button", { name: "打开工作区设置" }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "工作区设置" })).toBeVisible();
  await page.getByRole("button", { name: "退出登录或更换密钥" }).click();
  await expect(page.getByRole("heading", { name: "查看你的用量" })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("cm_access_token"))).toBeNull();
});

test("server demo and relative Pages build remain isolated from APIs and saved keys", async ({ browser }) => {
  for (const url of ["http://127.0.0.1:18888/demo", "http://127.0.0.1:18900/"]) {
    const page = await browser.newPage();
    await page.addInitScript(() => sessionStorage.setItem("cm_access_token", "must-not-be-used"));
    const calls: string[] = [], failures: string[] = [];
    page.on("request", request => { if(request.url().includes("/api/")) calls.push(request.url()); });
    page.on("pageerror", error => failures.push(error.message));
    page.on("response", response => { if(response.status() >= 400) failures.push(`${response.status()} ${response.url()}`); });
    await page.goto(url);
    await expect(page.getByText("当前展示示例数据")).toBeVisible();
    await page.getByRole("link", { name: "历史记录", exact: true }).first().click();
    await expect(page.getByRole("heading", { name: "历史记录", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "打开工作区设置" }).click();
    await expect(page.getByRole("dialog").getByRole("heading", { name: "演示工作区" })).toBeVisible();
    await expect(page.getByLabel("访问密钥", { exact: true })).toHaveCount(0);
    expect(calls).toEqual([]); expect(failures).toEqual([]);
    const manifestURL = await page.locator('link[rel="manifest"]').getAttribute("href");
    const manifest = await (await page.request.get(new URL(manifestURL!, url).href)).json();
    if(url.includes("18900")) expect(manifest.start_url).toBe("./");
    await page.close();
  }
});

test("320px hosted interface supports bottom drawer navigation, theme and accessible authentication", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/");
  await injectAxe(page);
  let violations = await page.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a","wcag2aa","wcag21aa"] } })).violations);
  expect(violations).toEqual([]);
  await login(page);
  // The grip is a full-width 28px drag strip; the tab bar's links and its
  // 更多 button are the 44px tap targets.
  const openNavigation = page.getByRole("button", { name: "打开导航", exact: true });
  const triggerBox = await openNavigation.boundingBox();
  expect(triggerBox!.width).toBeGreaterThanOrEqual(44);
  expect(triggerBox!.height).toBeGreaterThanOrEqual(24);
  const tabBar = page.getByRole("navigation", { name: "常用页面", exact: true });
  const targets = [...await tabBar.getByRole("link").all(), tabBar.getByRole("button", { name: "更多", exact: true })];
  expect(targets).toHaveLength(4);
  for (const target of targets) {
    const targetBox = await target.boundingBox();
    expect(targetBox!.width).toBeGreaterThanOrEqual(44);
    expect(targetBox!.height).toBeGreaterThanOrEqual(44);
  }
  await openNavigation.click();
  const drawer = page.getByRole("dialog", { name: "导航", exact: true });
  const historyLink = drawer.getByRole("navigation", { name: "页面导航", exact: true }).getByRole("link", { name: "历史记录", exact: true });
  const historyBox = await historyLink.boundingBox();
  expect(historyBox!.height).toBeGreaterThanOrEqual(44);
  await historyLink.click();
  await expect(drawer).toBeHidden();
  await expect(page.getByRole("heading", { name: "历史记录", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("combobox", { name: "外观设置" }).click();
  await page.getByRole("option", { name: "深色", exact: true }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.reload();
  await expect(page.getByText("当前展示真实数据")).toBeAttached();
  await expect(page.locator("html")).toHaveClass(/dark/);
  // Cards below the fold stay hidden until they are scrolled to; bring every
  // one into view so the audit covers the whole page.
  await revealAll(page);
  // Check settled colors once every entrance (heading, activity cells) has
  // finished; looping indicators such as the live status dot never finish.
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter(animation =>
    animation.playState === "running" && animation.effect?.getTiming().iterations !== Infinity).length)).toBe(0);
  await injectAxe(page);
  violations = await page.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a","wcag2aa","wcag21aa"] } })).violations);
  expect(violations).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("hosted-mobile-history.png"), fullPage: true });
});


test("interrupted authentication can be retried after a cached page returns", async ({ page }) => {
  await page.route("**/api/v1/tm/overview", async route => {
    await new Promise(resolve => setTimeout(resolve, 800));
    await route.continue().catch(() => {});
  });
  await page.goto("/");
  await page.getByLabel("访问密钥", { exact: true }).fill(READ_TOKEN);
  const started = page.waitForRequest("**/api/v1/tm/overview");
  await page.getByRole("button", { name: "进入工作台" }).click(); await started;
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  await expect(page.getByLabel("访问密钥", { exact: true })).toBeEnabled();
  await page.unroute("**/api/v1/tm/overview");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.getByText("当前展示真实数据")).toBeAttached();
});
