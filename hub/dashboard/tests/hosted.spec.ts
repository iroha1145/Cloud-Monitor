import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const READ_TOKEN = "b".repeat(32);
const WRITE_TOKEN = "a".repeat(32);
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
  await expect(page.locator(".insight-trend-tooltip")).toContainText("986,000");
  await expect(page.locator(".insight-trend-tooltip")).toContainText("53.4%");
  await slider.press("Escape");
  await page.getByRole("tablist", { name: "统计周期" }).getByRole("tab").nth(1).click();
  await expect(metric.locator("strong")).toHaveText("53.4%");
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
      // The production CSS compiler can lower individual transforms into
      // transform, so this must run against built assets as well as Vite dev.
      for (const viewport of [{ width: 844, height: 390 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport);
        await expect.poll(async () => {
          const box = await drawer.boundingBox();
          return Boolean(box && Math.abs(box.x) < 1 && Math.abs(box.y) < 1 && Math.abs(box.height - viewport.height) < 1);
        }).toBe(true);
        await expect(drawer.getByRole("button", { name: "关闭", exact: true })).toBeInViewport();
      }
      await drawer.getByRole("button", { name: "关闭", exact: true }).tap();
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
  await expect(page.getByRole("heading", { name: "用量，一目了然。" })).toHaveCount(0);
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

test("320px hosted interface supports bottom navigation, theme and accessible authentication", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/");
  await injectAxe(page);
  let violations = await page.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a","wcag2aa","wcag21aa"] } })).violations);
  expect(violations).toEqual([]);
  await login(page);
  await page.getByRole("navigation", { name: "移动端主导航" }).getByRole("link", { name: "历史记录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "历史记录", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "切换深色模式" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.reload();
  await expect(page.getByText("当前展示真实数据")).toBeAttached();
  await expect(page.locator("html")).toHaveClass(/dark/);
  // Check settled colors after the requested heading entrance animation.
  await expect.poll(() => page.locator(".heading-copy > p").evaluate(element => getComputedStyle(element).opacity)).toBe("1");
  await injectAxe(page);
  violations = await page.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a","wcag2aa","wcag21aa"] } })).violations);
  expect(violations).toEqual([]);
  await page.screenshot({ path: "evidence/hosted-mobile-history.png", fullPage: true });
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
