import { expect, test, type Locator, type Page } from "@playwright/test";

async function expectStaticComposition(
  page: Page,
  card: Locator,
  touch: boolean,
) {
  await expect(
    card.getByRole("heading", { name: "用量组成", exact: true }),
  ).toBeVisible();
  const ring = card.getByRole("img", { name: "用量组成环形图", exact: true });
  await expect(ring).toBeVisible();
  const legend = card.locator(".composition-legend > div");
  await expect(legend).toHaveCount(5);
  const before = await legend.allTextContents();
  for (const target of [
    ring,
    card.locator(".composition-hero strong"),
    ...(await card
      .locator(
        ".composition-legend strong, .composition-legend > div > span:last-child",
      )
      .all()),
  ]) {
    if (touch) await target.tap();
    else await target.hover();
    await expect(page.getByRole("tooltip")).toHaveCount(0);
  }
  expect(await legend.allTextContents()).toEqual(before);
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

    test("composition stays static in overview and model details while model cache details remain available", async ({
      page,
    }) => {
      await page.goto("/demo.html#overview");
      await expectStaticComposition(
        page,
        page.locator(".composition-panel:not(.small)"),
        touch,
      );

      const model = page.locator(".model-table tbody tr").first();
      const cache = model.locator(".cache-rate");
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
      await expectStaticComposition(
        page,
        dialog.locator(".composition-panel.small"),
        touch,
      );
    });
  });
}
