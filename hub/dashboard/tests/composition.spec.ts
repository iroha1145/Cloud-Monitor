import { expect, test, type Locator, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { scrollIntoViewAndReveal } from "./motion-helpers";

const require = createRequire(import.meta.url);
const overviewFixture = require("./fixtures/overview.json");

async function expectStaticComposition(
  page: Page,
  card: Locator,
  touch: boolean,
  chart: RegExp,
  figure?: Locator,
) {
  await expect(
    card.getByRole("heading", { name: "用量组成", exact: true }),
  ).toBeVisible();
  const graphic = card.getByRole("img", { name: chart });
  await expect(graphic).toBeVisible();
  const legend = card.locator(".composition-legend > div");
  await expect(legend).toHaveCount(5);
  const before = await legend.allTextContents();
  for (const target of [
    graphic,
    ...(figure ? [figure] : []),
    ...(await card
      .locator(
        ".composition-legend strong, .composition-legend > div > span:last-child",
      )
      .all()),
  ]) {
    // Centre each target first: a row near the bottom edge can sit "in view"
    // under the fixed phone menu bar, and a tap there opens the menu instead.
    if (touch) {
      await target.evaluate(element => element.scrollIntoView({ block: "center", behavior: "instant" }));
      await target.tap();
    } else await target.hover();
    await expect(page.getByRole("tooltip")).toHaveCount(0);
  }
  expect(await legend.allTextContents()).toEqual(before);
}

for (const scenario of [
  { name: "complete", read: 50, unclassified: 0, note: null, rate: "50.0%" },
  { name: "partial", read: 50, unclassified: 10, note: "部分用量未分类", rate: "50.0%" },
  { name: "unknown", read: null, unclassified: 100, note: "用量尚未分类", rate: "未提供" },
  { name: "inconsistent", read: 110, unclassified: 0, note: "数据不一致", rate: "未提供" },
]) {
  test(`composition guidance reflects ${scenario.name} model data`, async ({ page }, testInfo) => {
    const model = "composition-check";
    const known = scenario.read !== null;
    const period = {
      totalTokens: 100,
      models: { [model]: 100 },
      modelCacheReads: known ? { [model]: scenario.read } : {},
      modelCacheWrites: known ? { [model]: 10 } : {},
      modelOutputs: known ? { [model]: 20 } : {},
      modelUnclassifiedTokens: { [model]: scenario.unclassified },
    };
    const overview = {
      ...overviewFixture,
      totals: { today: period, month: period, allTime: period },
    };
    await page.route("**/api/**", route => route.fulfill({
      json: route.request().url().endsWith("/overview") ? overview : {},
    }));
    await page.goto("/");
    await page.getByRole("button", { name: "连接我的数据" }).click();
    await page.getByLabel("访问密钥", { exact: true }).fill("composition-fixture-only");
    await page.getByRole("button", { name: "连接并查看真实用量" }).click();
    await expect(page.getByText("当前展示真实数据")).toBeAttached();
    await page.locator(".app-toast").getByRole("button", { name: "关闭提示" }).click();
    await expect(page.locator(".app-toast")).toBeHidden();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: `查看 ${model} 详情`, exact: true }).click();
    const card = page.locator(".model-dialog .composition-panel");
    await expect(card.locator(".composition-center strong")).toHaveText(scenario.rate);
    if (scenario.note) {
      await expect(card.locator(".composition-note")).toContainText(scenario.note);
      await expect(card.locator(".composition-note")).toBeVisible();
    } else {
      await expect(card.locator(".composition-note")).toHaveCount(0);
    }
    await expect(card.locator(".composition-legend > div")).toHaveCount(5);
    await card.screenshot({ path: testInfo.outputPath(`composition-${scenario.name}.png`), animations: "disabled" });
  });
}

for (const touch of [false, true]) {
  test.describe(touch ? "touch composition" : "pointer composition", () => {
    test.use({
      viewport: touch
        ? { width: 390, height: 844 }
        : { width: 1512, height: 1080 },
      hasTouch: touch,
      isMobile: touch,
    });

    test("composition stays static in the overview spectrum and model details while model cache details remain available", async ({
      page,
    }) => {
      await page.goto("/demo.html#overview");
      await expectStaticComposition(
        page,
        page.getByRole("region", { name: "用量组成" }),
        touch,
        /用量组成色谱/,
      );

      const model = page.locator(".model-table tbody tr").first();
      const cache = model.locator(".cache-track");
      // The models card starts below the fold and rises in once scrolled to.
      await scrollIntoViewAndReveal(cache);
      if (touch) await cache.tap();
      else await cache.hover();
      await expect(page.getByRole("tooltip")).toContainText("缓存读取");
      await expect(page.getByRole("tooltip")).toContainText("费用");
      if (touch) await page.touchscreen.tap(5, 5);
      else await page.mouse.move(5, 5);
      await expect(page.getByRole("tooltip")).toHaveCount(0);

      if (touch) await model.locator(".model-open").tap();
      else await model.locator(".model-open").click();
      const dialog = page.locator(".model-dialog");
      await expect(dialog).toBeVisible();
      const card = dialog.locator(".composition-panel.small");
      await expectStaticComposition(
        page,
        card,
        touch,
        /用量组成环形图/,
        card.locator(".composition-hero strong"),
      );
    });
  });
}
