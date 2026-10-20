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
  await expect(partial.locator(".project-share-legend")).toContainText("无模型明细42.0%");
  // One part past the coloured three keeps its name instead of 其他 1 个模型.
  const design = card.locator(".project-row").filter({ hasText: "Design system" }).locator(".project-share-legend");
  await expect(design).toContainText("grok-bot-default8.0%");
  await expect(design).not.toContainText("其他");
  await expect(card.locator(".project-note")).toHaveCount(0);

  await card.getByRole("button", { name: "按客户端" }).click();
  await expect(card.getByRole("button", { name: "按客户端" })).toHaveAttribute("aria-pressed", "true");
  await expect(first.locator(".project-share-legend")).toContainText("Codex58.0%");
  await expect(partial.locator(".project-share-legend")).not.toContainText("无客户端明细");
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
  await expect(main.locator(".project-share-legend")).toHaveText(/gpt-5\.2\s*65\.0%.*opus-4\.5\s*13\.3%.*无模型明细\s*21\.7%/s);
  // A project from an older client has no model parts: all of it is unattributed.
  await expect(card.locator(".project-row").filter({ hasText: "notes" }).locator(".project-share-legend")).toHaveText(/无模型明细\s*100\.0%/);
  // Hovering a card that is still scrolling in lets the scroll close the tooltip mid-check.
  await scrollIntoViewAndReveal(main.locator(".metric-bar-trigger"));
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

test("keyboard show-more carries focus to the first project it reveals", async ({ page }) => {
  const overview = structuredClone(contractOverview);
  overview.projects_by_period = {
    today: Array.from({ length: 8 }, (_, index) => ({
      label: `project-${index + 1}`, tokens: 100_000 - index * 1000, costUsd: 0.1,
      clients: { codex: 100_000 - index * 1000 }, models: {}, devices: [],
    })),
    month: [], allTime: [],
  };
  await connect(page, overview);
  const card = page.locator(".projects-panel");
  await expect(card.locator(".project-row")).toHaveCount(6);
  const more = card.getByRole("button", { name: "再显示 2 个项目" });
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(card.locator(".project-row")).toHaveCount(8);
  await expect(more).toHaveCount(0);
  await expect(card.locator(".project-row").nth(6).locator(".metric-bar-trigger")).toBeFocused();
  // Another period starts again from six rows.
  await page.getByRole("tab", { name: "本月" }).click();
  await page.getByRole("tab", { name: "今日" }).click();
  await expect(card.locator(".project-row")).toHaveCount(6);
});

test("an older gateway without per-period projects says so instead of showing none", async ({ page }) => {
  const overview = structuredClone(contractOverview);
  delete overview.projects_by_period;
  delete overview.projects_meta_by_period;
  overview.projects = [{ label: "legacy", tokens: 6_423_160, costUsd: 1.5, clients: { codex: 6_423_160 }, models: {}, devices: [] }];
  await connect(page, overview);
  const card = page.locator(".projects-panel");
  await expect(card.locator(".empty-inline")).toContainText("当前服务没有提供今日的项目数据。");
  await page.getByRole("tab", { name: "累计" }).click();
  await expect(card.locator(".project-row")).toHaveCount(1);
  await expect(card.locator(".client-head")).toContainText("5.0%");
});

/** Rows, names and legend items stay inside the card; nothing scrolls sideways.
 * The card clips overflow, so an unwrapped name widens its row past the card
 * edge without any page overflow: compare against the card itself. */
async function phoneLayout(page: Page) {
  const card = page.locator(".projects-panel");
  await scrollIntoViewAndReveal(card);
  const layout = await page.evaluate(() => {
    const panel = document.querySelector(".projects-panel")!.getBoundingClientRect();
    const rows = [...document.querySelectorAll(".project-row")].map((row) => {
      const box = row.getBoundingClientRect();
      if (box.left < panel.left - 0.5 || box.right > panel.right + 0.5) return false;
      const head = row.querySelector(".client-head")!;
      const legend = [...row.querySelectorAll(".project-share-legend li")];
      return head.scrollWidth <= head.clientWidth + 0.5
        && legend.every((item) => {
          const rect = item.getBoundingClientRect();
          return rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5 && item.scrollWidth <= item.clientWidth + 0.5;
        });
    });
    const switches = [...document.querySelectorAll(".projects-panel .metric-switch button")].map((button) => button.getBoundingClientRect().height);
    return { rows, switches, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  expect(layout.overflow).toBeLessThanOrEqual(0);
  expect(layout.rows.length).toBeGreaterThan(0);
  expect(layout.rows.every(Boolean)).toBe(true);
  expect(Math.min(...layout.switches)).toBeGreaterThanOrEqual(44);
}

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
        await expect(page.locator(".projects-panel .project-row")).toHaveCount(4);
        await phoneLayout(page);
      } finally {
        await context.close();
      }
    });
  }

  test("320px rows wrap long project and model names", async ({ browser }) => {
    const context = await browser.newContext({
      baseURL: String(test.info().project.use.baseURL),
      viewport: { width: 1440, height: 1000 }, isMobile: true, hasTouch: true,
    });
    try {
      const page = await context.newPage();
      const overview = structuredClone(contractOverview);
      overview.projects_by_period = {
        // No hyphens or spaces: only overflow-wrap can break these.
        today: [{
          label: "AVeryLongProjectLabelWithoutAnyNaturalBreakPointsToWrapAtAll", tokens: 900_000,
          costUsd: 1.1, clients: { codex: 900_000 }, devices: [],
          models: { "geminiflashlitepreviewexperimentalbuildwithoutbreaks0617": 600_000, "gpt-5.2": 300_000 },
        }],
        month: [], allTime: [],
      };
      await connect(page, overview);
      await page.setViewportSize({ width: 320, height: 740 });
      await expect(page.locator(".projects-panel .project-row")).toHaveCount(1);
      await phoneLayout(page);
    } finally {
      await context.close();
    }
  });
});
