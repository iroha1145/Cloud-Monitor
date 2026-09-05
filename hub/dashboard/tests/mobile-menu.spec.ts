import { expect, test, type Page } from "@playwright/test";

async function expectDrawerAtViewportEdge(page: Page) {
  const drawer = page.getByRole("dialog", { name: "导航", exact: true });
  await expect(drawer).toBeVisible();
  await expect
    .poll(async () => {
      const box = await drawer.boundingBox();
      const viewport = page.viewportSize()!;
      return Boolean(
        box &&
        Math.abs(box.x) < 1 &&
        Math.abs(box.y) < 1 &&
        Math.abs(box.height - viewport.height) < 1 &&
        box.width > 240 &&
        box.width <= viewport.width - 44,
      );
    })
    .toBe(true);
  const close = drawer.getByRole("button", { name: "关闭", exact: true });
  const closeBox = await close.boundingBox();
  expect(closeBox!.x).toBeGreaterThanOrEqual(0);
  expect(closeBox!.y).toBeGreaterThanOrEqual(0);
  expect(closeBox!.x + closeBox!.width).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  expect(closeBox!.y + closeBox!.height).toBeLessThanOrEqual(
    page.viewportSize()!.height,
  );
  return drawer;
}

for (const viewport of [
  { width: 320, height: 740 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 844, height: 390 },
]) {
  test.describe(`mobile menu ${viewport.width} × ${viewport.height}`, () => {
    test.use({ viewport, hasTouch: true, isMobile: true });
    test("drawer stays at the viewport edge after page scrolling and keeps its close control visible while menu content scrolls", async ({
      page,
    }) => {
      await page.goto("/demo.html#overview");
      const trigger = page.getByRole("button", {
        name: "打开导航",
        exact: true,
      });
      await expect(trigger).toBeVisible();
      for (const scrolled of [false, true]) {
        if (scrolled) {
          await page.evaluate(() =>
            window.scrollTo({ top: 920, behavior: "instant" }),
          );
          await expect
            .poll(() => page.evaluate(() => scrollY))
            .toBeGreaterThan(500);
          // Activating the existing button without scrolling it into view keeps
          // the background's scroll position and exercises viewport anchoring.
          await trigger.evaluate((button: HTMLButtonElement) => button.click());
        } else {
          await trigger.tap();
        }
        const drawer = await expectDrawerAtViewportEdge(page);
        if (scrolled)
          expect(await page.evaluate(() => scrollY)).toBeGreaterThan(500);
        const close = drawer.getByRole("button", { name: "关闭", exact: true });
        const before = await close.boundingBox();
        const content = drawer.getByRole("navigation", {
          name: "侧边导航",
          exact: true,
        });
        await content.evaluate((node) => {
          node.scrollTop = node.scrollHeight;
        });
        if (viewport.height < 500)
          expect(
            await content.evaluate((node) => node.scrollTop),
          ).toBeGreaterThan(0);
        const after = await close.boundingBox();
        expect(Math.abs(before!.y - after!.y)).toBeLessThan(1);
        await expect(
          drawer.getByRole("button", { name: "工作区设置", exact: true }),
        ).toBeInViewport();
        await close.tap();
        await expect(drawer).toBeHidden();
      }
    });
  });
}

test.describe("mobile menu rotation", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  test("an open drawer stays attached to the left edge when the phone rotates", async ({
    page,
  }) => {
    await page.goto("/demo.html#overview");
    await page.getByRole("button", { name: "打开导航", exact: true }).tap();
    await expectDrawerAtViewportEdge(page);
    await page.setViewportSize({ width: 844, height: 390 });
    await expectDrawerAtViewportEdge(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const drawer = await expectDrawerAtViewportEdge(page);
    await drawer.locator('a[href="#devices"]').tap();
    await expect(drawer).toBeHidden();
    await expect(page).toHaveURL(/#devices$/);
  });
});
