import { expect, test, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { scrollIntoViewAndReveal } from "./motion-helpers";

const require = createRequire(import.meta.url);
const contractOverview = require("./fixtures/overview.json");

async function connect(page: Page, overview: unknown) {
  await page.route("**/api/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(route.request().url().endsWith("/overview") ? overview : {}),
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "连接我的数据" }).click();
  await page.getByLabel("访问密钥", { exact: true }).fill("local-projects");
  await page.getByRole("button", { name: "连接并查看真实用量" }).click();
  await expect(page.getByText("当前展示真实数据")).toBeVisible();
  await page.locator("aside").getByRole("link", { name: "模型分析" }).click();
}

test("demo project card splits each project by model or client and follows the period", async ({ page }) => {
  await page.goto("/");
  await page.locator("aside").getByRole("link", { name: "模型分析" }).click();
  const card = page.locator(".projects-panel");
  await expect(card.getByRole("heading", { name: "项目用量" })).toBeVisible();
  await expect(card.locator(".project-row")).toHaveCount(4);
  const first = card.locator(".project-row").first();
  const partial = card.locator(".project-row").filter({ hasText: "Release tooling" });
  await expect(first.locator(".client-head")).toContainText("36.0%");
  await expect(first.locator(".project-share-legend")).toContainText("gpt-6-astra58.0%");
  // Usage an older client reported without models stays its own part.
  await expect(partial.locator(".project-share-legend")).toContainText("未区分模型42.0%");
  await expect(card.locator(".project-note")).toHaveCount(0);

  await card.getByRole("button", { name: "按客户端" }).click();
  await expect(card.getByRole("button", { name: "按客户端" })).toHaveAttribute("aria-pressed", "true");
  await expect(first.locator(".project-share-legend")).toContainText("Codex58.0%");
  await expect(partial.locator(".project-share-legend")).not.toContainText("未区分");
  await expect(card.locator(".table-foot")).toContainText("客户端占比按项目自身用量计算");

  await page.getByRole("tab", { name: "累计" }).click();
  await expect(card.locator(".project-note")).toHaveText("部分设备没有同步项目明细，项目用量可能不全。");
  await expect(first.locator(".client-foot")).toContainText("亿 词元");
  await expect(card.locator(".table-foot")).toContainText("项目占比按累计全部用量计算");
});

test("live projects keep their own breakdown and flag an incomplete period", async ({ page }) => {
  const overview = structuredClone(contractOverview);
  overview.projects_by_period = {
    today: [
      { label: "cloud-monitor", tokens: 923_160, costUsd: 2.41, unpricedTokens: 1200,
        clients: { codex: 600_000, claude: 323_160 }, models: { "gpt-5.2": 600_000, "opus-4.5": 123_160 },
        devices: ["MacBook-Pro", "ThinkPad"] },
      { label: "notes", tokens: 92_316, costUsd: 0.2, clients: { claude: 92_316 }, models: {}, devices: ["MacBook-Pro"] },
    ],
    month: [],
  };
  overview.projects_meta_by_period = { today: { incomplete: true }, month: { incomplete: false } };
  await connect(page, overview);
  const card = page.locator(".projects-panel");
  await expect(card.locator(".project-note")).toBeVisible();
  const main = card.locator(".project-row").filter({ hasText: "cloud-monitor" });
  await expect(main.locator(".client-head")).toContainText("50.0%");
  await expect(main.locator(".project-share-legend")).toHaveText(/gpt-5\.2\s*65\.0%.*opus-4\.5\s*13\.3%.*未区分模型\s*21\.7%/s);
  // A project from an older client has no model parts: all of it is unattributed.
  await expect(card.locator(".project-row").filter({ hasText: "notes" }).locator(".project-share-legend")).toHaveText(/未区分模型\s*100\.0%/);
  await main.locator(".metric-bar-trigger").hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toContainText("cloud-monitor · 按模型");
  await expect(tooltip).toContainText("来自 MacBook-Pro、ThinkPad。");
  await expect(tooltip).toContainText("另有 1,200 词元未提供单价");

  await page.getByRole("tab", { name: "本月" }).click();
  await expect(card.locator(".project-note")).toHaveCount(0);
  await expect(card.locator(".empty-inline")).toContainText("设备开启项目统计");
  // No all-time list: the older `projects` field (empty here) still answers.
  await page.getByRole("tab", { name: "累计" }).click();
  await expect(card.locator(".empty-inline")).toContainText("设备开启项目统计");
});

test("an older gateway without per-period projects says so instead of showing none", async ({ page }) => {
  const overview = structuredClone(contractOverview);
  overview.projects = [{ label: "legacy", tokens: 6_423_160, costUsd: 1.5, clients: { codex: 6_423_160 }, models: {}, devices: [] }];
  await connect(page, overview);
  const card = page.locator(".projects-panel");
  await expect(card.locator(".empty-inline")).toContainText("当前服务没有提供今日的项目数据。");
  await page.getByRole("tab", { name: "累计" }).click();
  await expect(card.locator(".project-row")).toHaveCount(1);
  await expect(card.locator(".client-head")).toContainText("5.0%");
});

test.describe("phone project card", () => {
  for (const width of [390, 320]) {
    test(`${width}px rows wrap their legend inside the card`, async ({ browser }) => {
      const context = await browser.newContext({
        baseURL: String(test.info().project.use.baseURL),
        viewport: { width, height: 844 }, isMobile: true, hasTouch: true,
      });
      try {
        const page = await context.newPage();
        await page.goto("/#models");
        const card = page.locator(".projects-panel");
        await expect(card.locator(".project-row")).toHaveCount(4);
        await scrollIntoViewAndReveal(card);
        const layout = await page.evaluate(() => {
          const rows = [...document.querySelectorAll(".project-row")].map((row) => {
            const box = row.getBoundingClientRect();
            const legend = [...row.querySelectorAll(".project-share-legend li")].map((item) => item.getBoundingClientRect());
            return legend.every((item) => item.left >= box.left - 0.5 && item.right <= box.right + 0.5);
          });
          const switches = [...document.querySelectorAll(".projects-panel .metric-switch button")].map((button) => button.getBoundingClientRect().height);
          return { rows, switches, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
        });
        expect(layout.overflow).toBeLessThanOrEqual(0);
        expect(layout.rows.every(Boolean)).toBe(true);
        expect(Math.min(...layout.switches)).toBeGreaterThanOrEqual(44);
      } finally {
        await context.close();
      }
    });
  }
});
