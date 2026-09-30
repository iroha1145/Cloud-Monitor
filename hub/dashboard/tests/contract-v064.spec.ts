import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const fixture = require("./fixtures/overview.json");

for (const width of [1440, 390]) {
  test(`v0.64 Muse usage and StepFun plans remain readable at ${width}px`, async ({ page }) => {
    const today = { totalTokens: 50, costUsd: 0.05, clients: { muse: 50 }, clientCosts: { muse: 0.05 },
      models: { "gpt-5": 50 }, modelCosts: { "gpt-5": 0.05 }, clientModels: { muse: { "gpt-5": 50 } } };
    const overview = { ...fixture, generated_at: new Date().toISOString(), totals: { today, month: today, allTime: today },
      limits: [
        { provider: "stepfun", status: "ok", accountLabel: "Coding Plan", windows: [
          { kind: "session", label: "5-hour", usedPercent: 20 }, { kind: "weekly", label: "Weekly", usedPercent: 40 },
        ] },
        { provider: "stepfun", status: "ok", accountLabel: "Token Plan", windows: [
          { kind: "billing", label: "Credit", usedPercent: 25 },
        ] },
      ],
    };
    await page.route("**/api/**", route => route.fulfill({
      json: route.request().url().endsWith("/overview") ? overview : {},
    }));
    await page.goto("/");
    await page.getByRole("button", { name: "连接我的数据" }).click();
    await page.getByLabel("访问密钥", { exact: true }).fill("fixture-read-token");
    await page.getByRole("button", { name: "连接并查看真实用量" }).click();
    await expect(page.getByText("当前展示真实数据")).toBeAttached();
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByText("Muse Code", { exact: true }).first()).toBeVisible();
    await expect(page.locator('[data-brand="meta"]').first()).toBeVisible();
    await page.goto("/#quota");
    const cards = page.locator(".sv-quota-card");
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toContainText("StepFun");
    await expect(cards.nth(0)).toContainText("Coding Plan");
    await expect(cards.nth(0)).toContainText("5-hour");
    await expect(cards.nth(0)).toContainText("Weekly");
    await expect(cards.nth(1)).toContainText("Token Plan");
    await expect(cards.nth(1).locator(".sv-quota-value")).toContainText("25%");
    await expect(cards.nth(1)).not.toContainText("$");
    await expect(cards.nth(0).locator('[data-brand="stepfun"]')).toBeVisible();
    const logo = await page.request.get("/client-logos/stepfun.svg");
    expect(logo.ok()).toBe(true);
    expect(await logo.text()).toContain("<svg");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: `evidence/v064-quota-${width}.png`, fullPage: true, animations: "disabled" });
  });
}
