import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const fixture = require("./fixtures/overview.json");

async function openWithOverview(page: import("@playwright/test").Page, view: string, overview: object) {
  await page.route("**/api/v1/tm/**", (route) => route.fulfill({
    json: route.request().url().endsWith("/overview") ? overview : {},
  }));
  await page.goto("/");
  await page.getByRole("button", { name: "连接我的数据" }).click();
  await page.getByLabel("访问密钥", { exact: true }).fill("fixture-read-token");
  await page.getByRole("button", { name: "连接并查看真实用量" }).click();
  await expect(page.getByText("当前展示真实数据")).toBeAttached();
  await page.goto(`/#${view}`);
}

test("quota cards show point balances, expiry, reset grants and third-party details", async ({ page }) => {
  const overview = {
    ...fixture,
    limits: [
      { provider: "trae", status: "ok", windows: [{ kind: "billing", metric: "credits", label: "Credits",
        currency: "CREDITS", remaining: 680, usedPercent: 20, limit: 850 }] },
      { provider: "typesafe", status: "ok", balance: { amount: 5, currency: "USD",
        tranches: [{ amount: 5, currency: "USD", expiresAt: "2026-10-01T00:00:00Z" }] },
      windows: [{ kind: "billing", metric: "credits", label: "Balance", remaining: 5,
        currency: "USD", boundaryKind: "expiry", resetsAt: "2026-10-01T00:00:00Z" }] },
      { provider: "claude", status: "ok", resetCredits: { availableCount: 1, grants: [{
        label: "Courtesy grant", resetsLeft: 1, clears: ["five_hour"],
        useRequiresLimit: true, endsAt: "2026-10-01T00:00:00Z",
      }] }, windows: [{ kind: "weekly", label: "7 days", usedPercent: 30 }] },
      { provider: "thirdparty", adapterId: "review-adapter", status: "ok",
        usageSummary: { period: "month", requests: 12, totalTokens: 2500, standardCost: 1.2 },
        windows: [{ kind: "billing", metric: "spend", label: "Usage credits", used: 2.5 }] },
      { provider: "antigravity", status: "ok", actionRequired: "accountVerification",
        windows: [{ kind: "session", label: "5 hours", usedPercent: 40 }] },
    ],
  };
  await openWithOverview(page, "quota", overview);
  await page.setViewportSize({ width: 390, height: 844 });
  const cards = page.locator(".sv-quota-card");
  await expect(cards).toHaveCount(5);
  await expect(cards.nth(0).locator(".sv-quota-value")).toContainText("680");
  await expect(cards.nth(0).locator(".sv-quota-value")).not.toContainText("CREDITS");
  await expect(cards.nth(1)).toContainText("到期于");
  await expect(cards.nth(1)).toContainText("查看预付额度明细");
  await expect(cards.nth(2)).toContainText("可用重置次数：1");
  await cards.nth(2).getByText("查看重置额度明细").click();
  await expect(cards.nth(2)).toContainText("达到额度上限后可用");
  await cards.nth(3).getByText("第三方接口使用摘要").click();
  await expect(cards.nth(3).locator(".sv-quota-value")).toContainText("2.5（单位未提供）");
  await expect(cards.nth(3)).toContainText("请求次数");
  await expect(cards.nth(3)).toContainText("2,500");
  await expect(cards.nth(3)).toContainText("1.2（单位未提供）");
  await expect(cards.nth(4)).toContainText("需要处理");
  await expect(cards.nth(4)).toContainText("完成账户验证");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test("session history shows uploaded context and avoids claiming live status without fresh evidence", async ({ page }) => {
  const now = new Date();
  await page.clock.install({ time: now });
  const overview = {
    ...fixture,
    generated_at: now.toISOString(),
    sessions: [
      { key: "dev:s1", sessionId: "s1", client: "codex", title: "Running work", deviceId: "dev-fixture",
        tokens: 100, lastUsedAt: new Date(now.getTime() - 60_000).toISOString(),
        turnEnded: false, deviceStale: false, contextTokens: 900, contextWindow: 1000,
        sessionKind: "cli" },
      { key: "dev:s2", sessionId: "s2", client: "claude", title: "Unknown work", deviceId: "dev-fixture",
        tokens: 90, lastUsedAt: new Date(now.getTime() - 60_000).toISOString(),
        contextTokens: 500, contextWindow: 1000 },
    ],
  };
  await openWithOverview(page, "history", overview);
  const rows = page.locator(".sv-session-table tbody tr:not(.sv-session-detail)");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("运行中");
  await expect(rows.nth(1)).toContainText("状态未提供");
  await rows.nth(0).getByRole("button", { name: /Running work/ }).click();
  const detail = page.locator(".sv-session-detail");
  await expect(detail).toContainText("上次上报的上下文");
  await expect(detail).toContainText("剩余 10%");
  await expect(detail.getByRole("progressbar", { name: "上次上报的上下文已用比例" })).toHaveAttribute("value", "90");
  await page.clock.fastForward(11 * 60_000);
  await expect(rows.nth(0)).toContainText("闲置");
});
