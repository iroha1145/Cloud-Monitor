const { test, expect } = require("@playwright/test");
const { loginWithToken, sampleOverview, stubOverview } = require("./helpers");

let base;
test.beforeAll(async ({ browser, baseURL }) => { base = (await sampleOverview(browser, baseURL)).payload; });

for (const width of [1440, 390]) {
  test(`v0.64 StepFun and Muse artwork renders in the legacy dashboard at ${width}px`, async ({ page, context }) => {
    const payload = structuredClone(base);
    payload.totals.today.clients = { muse: 50 };
    payload.limits = [
      { provider: "stepfun", status: "ok", accountLabel: "Coding Plan", windows: [
        { kind: "session", label: "5-hour", usedPercent: 20 }, { kind: "weekly", label: "Weekly", usedPercent: 40 },
      ] },
      { provider: "stepfun", status: "ok", accountLabel: "Token Plan", windows: [
        { kind: "billing", label: "Credit", usedPercent: 25 },
      ] },
    ];
    await page.setViewportSize({ width, height: 900 });
    await loginWithToken(context);
    await stubOverview(page, payload);
    await page.goto("/");
    await expect(page.locator("#shell")).toBeVisible();
    await expect(page.locator('#client-dist .client-logo[style*="meta.svg"]')).toBeVisible();
    await page.goto("/#quota");
    const cards = page.locator("#lim-grid .lim-card");
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toContainText("StepFun");
    await expect(cards.nth(0)).toContainText("5-hour");
    await expect(cards.nth(0)).toContainText("Weekly");
    await expect(cards.nth(1)).toContainText("Token Plan");
    await expect(cards.nth(1)).not.toContainText("$");
    await expect(cards.nth(0).locator('.client-logo[style*="stepfun.svg"]')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}
