import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const fixture = JSON.parse(readFileSync(new URL("./fixtures/overview.json", import.meta.url), "utf8"));

async function loadActivity(page: Page, mobile = false, mismatch = false) {
  const payload = structuredClone(fixture);
  payload.features = { ...payload.features, subscriptions: false, provider_status: false, history_daily: false };
  payload.activity.daily = [{ day: "2026-08-22", total: 0 }, { day: "2026-08-23", total: null }, { day: "2026-08-24", total: 400 }, { day: "2026-08-25", total: 1000 }];
  payload.activity.hourly_today = { day: mismatch ? "2026-08-24" : "2026-08-25", buckets: [{ hour: 0, total: 0 }, { hour: 1, total: null }, { hour: 2, total: 500 }, { hour: 3, total: 500 }] };
  payload.activity.hourly = [];
  payload.activity.hourly_day = mismatch ? "2026-08-24" : "2026-08-25";
  payload.activity.daily_day_basis = "hybrid-dashboard-and-device-local";
  payload.activity.daily_mixed_basis = true;
  payload.activity.daily_archive_cutover_day = "2026-08-24";
  payload.activity.coverage = { first_sample_at: "2026-08-25T00:00:00Z", last_sample_at: "2026-08-25T01:00:00Z", expected_buckets: 100, observed_buckets: 33, coverage_percent: 32.8, attribution_mode: "delta-low-coverage", gap_count: 2, reset_count: 0, devices: [{ device_id: "desktop-qa", expected_buckets: 100, observed_buckets: 33, gap_count: 2, reset_count: 0 }] };
  await page.route("**/api/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(route.request().url().endsWith("/overview") ? payload : { items: [] }) }));
  await page.goto("/");
  if (mobile) {
    await page.getByRole("button", { name: "打开导航", exact: true }).click();
    await page.getByRole("button", { name: "工作区设置", exact: true }).click();
  } else await page.getByRole("button", { name: "打开工作区设置", exact: true }).click();
  await page.getByLabel("访问密钥", { exact: true }).fill("activity-local-fixture");
  await page.getByRole("button", { name: "连接并查看真实用量" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.locator(mobile ? ".mobile-bottom-nav" : ".sidebar").getByRole("link", { name: "历史记录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "活动一览", exact: true })).toBeVisible();
}

test("activity restores day/week/month, source coverage, keyboard filtering and continuous tooltip movement", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await loadActivity(page);
  const panel = page.locator(".cm-activity-panel");
  await expect(panel.getByRole("tab", { name: "月", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(panel.locator(".cm-activity-grid-month > *")).toHaveCount(36);
  const zero = panel.locator('[data-day="2026-08-22"]');
  const unknown = panel.locator('[data-day="2026-08-23"]');
  await expect(zero).toHaveAttribute("data-level", "0");
  await expect(unknown).toHaveAttribute("data-level", "unknown");
  await expect(panel).toContainText("3 / 25");
  await expect(panel).toContainText("跨时区设备不可视为同一日期");
  await expect(panel).toContainText("32.8%");
  await panel.locator("summary").click();
  await expect(panel).toContainText("33 / 100");
  await expect(panel).toContainText("缺口 2 · 重置 0");
  await panel.locator("summary").click();
  await panel.locator('[data-day="2026-08-01"]').focus();
  await page.keyboard.press("End");
  await expect(panel.locator('[data-day="2026-08-25"]')).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(panel.locator('[data-day="2026-08-25"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "清除日期筛选" })).toBeVisible();
  await panel.getByRole("button", { name: "取消活动日期选择" }).click();
  const anchor = panel.locator('[data-day="2026-08-11"]');
  await anchor.scrollIntoViewIfNeeded();
  const rect = (await anchor.boundingBox())!;
  await page.mouse.move(rect.x + 10, rect.y + 10);
  const tooltip = page.locator('.metric-tooltip-card[data-input="mouse"]');
  await expect(tooltip).toBeVisible();
  const before = (await tooltip.boundingBox())!;
  await page.mouse.move(rect.x + 22, rect.y + 15);
  await expect.poll(async () => Math.round((await tooltip.boundingBox())!.x - before.x)).toBe(12);
  await expect.poll(async () => Math.round((await tooltip.boundingBox())!.y - before.y)).toBe(5);
  expect(await tooltip.locator('svg, [data-slot="tooltip-arrow"]').count()).toBe(0);
  await page.keyboard.press("Escape");
  await panel.getByRole("tab", { name: "月", exact: true }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(panel.getByRole("tab", { name: "周", exact: true })).toBeFocused();
  await expect(panel.locator(".cm-activity-grid-week > *")).toHaveCount(84);
  await page.keyboard.press("Home");
  await expect(panel.locator(".cm-activity-grid-day button")).toHaveCount(24);
  await expect(panel.locator('[data-hour="0"]')).toHaveAttribute("data-level", "0");
  await expect(panel.locator('[data-hour="1"]')).toHaveAttribute("data-level", "unknown");
  await expect(panel).toContainText("3 / 24");
  await panel.screenshot({ path: "evidence/activity-live-desktop-day.png" });
  expect(errors).toEqual([]);
});

test("stale hourly data stays undisplayed with an explicit explanation", async ({ page }) => {
  await loadActivity(page, false, true);
  const panel = page.locator(".cm-activity-panel");
  await panel.getByRole("tab", { name: "日", exact: true }).click();
  await expect(panel).toContainText("小时记录与当前数据的日期不一致");
  await expect(panel.locator('.cm-activity-grid-day [data-level="unknown"]')).toHaveCount(24);
  await expect(panel).toContainText("0 / 24");
});

for (const width of [320, 390]) {
  test(`mobile activity is square, readable, keyboard accessible and contained at ${width}px`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, colorScheme: width === 390 ? "dark" : "light" });
    const page = await context.newPage();
    await loadActivity(page, true);
    const panel = page.locator(".cm-activity-panel");
    for (const name of ["月", "周", "日"]) {
      await panel.getByRole("tab", { name, exact: true }).tap();
      const size = await panel.locator(".cm-activity-grid").evaluate((node) => ({ width: node.clientWidth, scroll: node.scrollWidth }));
      expect(size.scroll).toBeLessThanOrEqual(size.width + 1);
      const box = (await panel.locator(".cm-activity-grid button").first().boundingBox())!;
      expect(Math.abs(box.width - box.height)).toBeLessThan(1);
      const tab = (await panel.getByRole("tab", { name, exact: true }).boundingBox())!;
      expect(tab.width).toBeGreaterThanOrEqual(44);
      expect(tab.height).toBeGreaterThanOrEqual(44);
    }
    await panel.getByRole("tab", { name: "月", exact: true }).tap();
    const picker = panel.getByLabel("按日期筛选会话", { exact: true });
    await picker.fill("2026-08-25");
    await expect(panel.locator('[data-day="2026-08-25"]')).toHaveAttribute("aria-pressed", "true");
    expect(await picker.evaluate((element) => getComputedStyle(element).fontSize)).toBe("16px");
    await panel.getByRole("button", { name: "取消活动日期选择" }).tap();
    if (width === 390) {
      const target = panel.locator('[data-day="2026-08-13"]');
      await target.scrollIntoViewIfNeeded();
      const box = (await target.boundingBox())!;
      const cdp = await context.newCDPSession(page);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
      const tooltip = page.locator('.metric-tooltip-card[data-input="touch"]');
      await expect(tooltip).toBeVisible();
      const before = (await tooltip.boundingBox())!;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: box.x + box.width / 2 + 10, y: box.y + box.height / 2 + 4 }] });
      await expect.poll(async () => Math.round((await tooltip.boundingBox())!.x - before.x)).toBe(10);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await expect(target).toHaveAttribute("aria-pressed", "false");
      await page.keyboard.press("Escape");
    }
    await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
    const audit = await page.evaluate(async () => (window as any).axe.run(document.querySelector(".cm-activity-panel"), { runOnly: ["wcag2a", "wcag2aa", "wcag21aa"] }));
    expect(audit.violations.map((item: any) => ({ id: item.id, nodes: item.nodes.map((node: any) => node.target) }))).toEqual([]);
    await panel.screenshot({ path: `evidence/activity-live-mobile-${width}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await context.close();
  });
}
