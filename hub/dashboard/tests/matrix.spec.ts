import { expect, test, type Page } from "@playwright/test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const contractOverview = require("./fixtures/overview.json");

async function expectMatrixCellsColored(page: Page) {
  await expect(page.getByRole("heading", { name: "客户端 × 模型" })).toBeVisible();
  const table = page.locator(".matrix-table");
  await expect(table.locator(".matrix-cell").first()).toBeVisible();
  const cells = await table.locator(".matrix-cell").evaluateAll((nodes) =>
    nodes.map((node) => {
      const text = (node.textContent || "").replace(/\s+/g, " ").trim();
      const level = Number(
        [...node.classList]
          .find((name) => name.startsWith("level-"))
          ?.slice("level-".length),
      );
      return {
        text,
        level,
        background: getComputedStyle(node).backgroundColor,
      };
    }),
  );
  expect(cells.length).toBeGreaterThan(0);
  const empty = cells.filter((cell) => cell.text === "—");
  const used = cells.filter((cell) => cell.text !== "—");
  expect(used.length).toBeGreaterThan(0);
  for (const cell of used) {
    expect(cell.level, cell.text).toBeGreaterThanOrEqual(1);
    expect(cell.level, cell.text).toBeLessThanOrEqual(4);
  }
  for (const cell of empty) expect(cell.level).toBe(0);
  if (empty.length && used.length) {
    const emptyBackground = empty[0].background;
    expect(
      used.some((cell) => cell.background !== emptyBackground),
      "used cells should not share the empty-cell background",
    ).toBe(true);
  }
}

test("demo matrix paints a color on every reported token and cost cell", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("aside").getByRole("link", { name: "模型分析" }).click();
  await expect(
    page.getByRole("heading", { name: "模型分析", exact: true }),
  ).toBeVisible();
  await expectMatrixCellsColored(page);
  await page.locator(".matrix-panel").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "evidence/matrix-demo-tokens.png",
    animations: "disabled",
  });
  await page.getByRole("button", { name: "使用费用" }).click();
  await expect(page.getByRole("button", { name: "使用费用" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expectMatrixCellsColored(page);
});

test("skewed live matrix keeps 万-scale cells colored against a 亿-scale peak", async ({
  page,
}) => {
  const skewed = structuredClone(contractOverview);
  const today = skewed.totals.today;
  today.clients = {
    grok: 260_000_000,
    codex: 184_000_000,
    cursor: 32_000_000,
    zcode: 130_000_000,
  };
  today.models = {
    "grok-4.6": 260_000_000,
    "gpt-6-astra": 184_000_000,
    "glm-4.5-flash": 130_000_000,
    "cursor-grok-4-x": 17_972_000,
    "gpt-5-solotel": 14_295_000,
    "gemini-3-propreview": 77_000,
  };
  today.clientModels = {
    grok: { "grok-4.6": 260_000_000 },
    codex: {
      "gpt-6-astra": 184_000_000,
      "gpt-5-solotel": 14_295_000,
    },
    cursor: {
      "cursor-grok-4-x": 17_972_000,
      "gemini-3-propreview": 77_000,
    },
    zcode: { "glm-4.5-flash": 130_000_000 },
  };
  today.clientModelCosts = {
    grok: { "grok-4.6": 12.4 },
    codex: { "gpt-6-astra": 8.1, "gpt-5-solotel": 0.18 },
    cursor: { "cursor-grok-4-x": 0.42, "gemini-3-propreview": 0.03 },
    zcode: { "glm-4.5-flash": 1.1 },
  };
  today.totalTokens = 606_000_000;
  await page.route("**/api/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        route.request().url().endsWith("/overview") ? skewed : {},
      ),
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "连接我的数据" }).click();
  await page.getByLabel("访问密钥", { exact: true }).fill("local-matrix-skew");
  await page.getByRole("button", { name: "连接并查看真实用量" }).click();
  await expect(page.getByText("当前展示真实数据")).toBeVisible();
  await page.locator("aside").getByRole("link", { name: "模型分析" }).click();
  await expectMatrixCellsColored(page);
  await expect(page.locator(".matrix-cell.level-4")).toHaveCount(1);
  await expect(page.locator(".matrix-cell.level-4")).toContainText("2.60 亿");
  const small = page
    .locator(".matrix-cell.level-1")
    .filter({ hasText: "7.7 万" });
  await expect(small).toHaveCount(1);
  await expect(small).toBeVisible();
  await page.locator(".matrix-panel").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "evidence/matrix-skewed-tokens.png",
    animations: "disabled",
  });
  await page.getByRole("button", { name: "使用费用" }).click();
  await expectMatrixCellsColored(page);
  await page.locator(".matrix-panel").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "evidence/matrix-skewed-costs.png",
    animations: "disabled",
  });
});
