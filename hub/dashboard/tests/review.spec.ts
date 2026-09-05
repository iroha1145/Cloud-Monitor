import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const fixture = require("./fixtures/overview.json");
const longName = "private-model-" + "abcdefghijklmnop".repeat(7);

for (const viewport of [
  { width: 320, height: 740 }, { width: 390, height: 844 },
  { width: 844, height: 390 }, { width: 900, height: 900 },
]) {
  test(`long model details fit inside the dialog at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const overview = JSON.parse(JSON.stringify(fixture).replaceAll("gpt-5.2", longName));
    // Malformed dates from an upstream/migrated record cannot crash the chart.
    overview.trend.push({ day: "not-a-date", total: 42 }, { day: "2026-02-30", total: 3 });
    await page.route("**/api/**", route => route.fulfill({ json: route.request().url().endsWith("/overview") ? overview : {} }));
    await page.goto("/");
    if (viewport.width < 760 || viewport.height < 500) {
      await page.getByRole("button", { name: "打开导航" }).click();
      await page.locator(".mobile-nav-dialog").getByRole("button", { name: "工作区设置", exact: true }).click();
    } else {
      await page.getByRole("button", { name: "连接我的数据" }).click();
    }
    await page.getByLabel("访问密钥", { exact: true }).fill("review-fixture-only");
    await page.getByRole("button", { name: "连接并查看真实用量" }).click();
    await expect(page.getByRole("button", { name: `查看 ${longName} 详情`, exact: true })).toBeVisible();
    await page.getByRole("button", { name: `查看 ${longName} 详情`, exact: true }).click();
    const dialog = page.locator(".model-dialog");
    await expect(dialog.getByRole("heading", { name: longName, exact: true })).toBeVisible();
    const dimensions = await dialog.evaluate(element => {
      const box = element.getBoundingClientRect();
      const title = element.querySelector('[data-slot="dialog-title"]')!.getBoundingClientRect();
      return { width: element.clientWidth, scroll: element.scrollWidth, left: box.left, right: box.right, bottom: box.bottom, top: box.top, titleRight: title.right, viewport: innerWidth, height: innerHeight };
    });
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1);
    expect(dimensions.titleRight).toBeLessThanOrEqual(dimensions.right);
    expect(dimensions.left).toBeGreaterThanOrEqual(0);
    expect(dimensions.right).toBeLessThanOrEqual(dimensions.viewport);
    expect(dimensions.top).toBeGreaterThanOrEqual(0);
    expect(dimensions.bottom).toBeLessThanOrEqual(dimensions.height);
    expect(errors).toEqual([]);
    await testInfo.attach("long-model-dialog", { body: await page.screenshot({ path: `evidence/review-long-model-${viewport.width}x${viewport.height}.png`, animations: "disabled" }), contentType: "image/png" });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
}

// Motion writes an inline transform during entry and exit. Positioning the toast
// with a competing CSS translateX used to clip its right side on mobile.
for (const width of [320, 390, 1440]) {
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    test(`toast stays centered and readable at ${width}px (${reducedMotion})`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ reducedMotion });
      await page.goto("/");
      await page.getByRole("button", { name: "刷新数据", exact: true }).click();
      const toast = page.locator(".app-toast");
      await expect(toast).toContainText("示例数据已重新加载");
      await expect(toast).toHaveCSS("opacity", "1");
      const bounds = await toast.evaluate(element => {
        const box = element.getBoundingClientRect();
        const close = element.querySelector("button")!.getBoundingClientRect();
        return { left: box.left, right: box.right, center: (box.left + box.right) / 2,
          width: element.clientWidth, scroll: element.scrollWidth, closeRight: close.right };
      });
      expect(Math.abs(bounds.center - width / 2)).toBeLessThanOrEqual(2);
      expect(bounds.left).toBeGreaterThanOrEqual(12);
      expect(bounds.right).toBeLessThanOrEqual(width - 12);
      expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1);
      expect(bounds.closeRight).toBeLessThanOrEqual(bounds.right);
      await page.screenshot({ path: `evidence/review-toast-${width}-${reducedMotion}.png`, animations: "disabled" });
      await toast.getByRole("button", { name: "关闭提示" }).click();
      await expect(toast).toBeHidden();
    });
  }
}
