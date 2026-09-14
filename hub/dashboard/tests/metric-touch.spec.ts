import { expect, test } from "@playwright/test";

for (const width of [320, 390]) {
  test.describe(`horizontal bar touch boundaries at ${width}px`, () => {
    test.use({
      viewport: { width, height: 844 },
      isMobile: true,
      hasTouch: true,
    });

    for (const [view, selector] of [
      ["overview", ".cache-track"],
      ["models", ".cache-track"],
      ["overview", ".client-track"],
    ]) {
      test(`${view} ${selector} accepts nearby touches and ignores surrounding space`, async ({
        page,
        context,
      }) => {
        await page.goto(`/demo.html#${view}`);
        const bar = page.locator(selector).first();
        await bar.scrollIntoViewIfNeeded();
        const box = (await bar.boundingBox())!;
        const x = box.x + box.width / 2;
        const tooltip = page.locator(".metric-tooltip-card");

        // A fingertip may miss the visible bar slightly in either direction.
        for (const y of [
          box.y - 6,
          box.y + box.height / 2,
          box.y + box.height + 6,
        ]) {
          await page.touchscreen.tap(x, y);
          await expect(tooltip).toContainText("用量明细");
          await page.touchscreen.tap(5, 5);
          await expect(tooltip).toBeHidden();
        }
        // Native touch adjustment must not extend the intended hit area.
        for (const y of [box.y - 14, box.y + box.height + 14]) {
          await page.touchscreen.tap(x, y);
          await expect(tooltip).toBeHidden();
        }
        if (selector === ".cache-track") {
          await page.locator(".cache-rate > span:last-child").first().tap();
          await expect(tooltip).toBeHidden();
        }

        // Horizontal inspection still follows the finger; only vertical
        // panning is claimed by the browser for page scrolling (pan-y).
        const cdp = await context.newCDPSession(page);
        const y = box.y + box.height / 2;
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x, y }],
        });
        await expect(tooltip).toBeVisible();
        const before = (await tooltip.boundingBox())!;
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: x + 30, y }],
        });
        await expect
          .poll(async () =>
            Math.round((await tooltip.boundingBox())!.x - before.x),
          )
          .toBe(30);
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
        await expect(tooltip).toBeVisible();
        await page.touchscreen.tap(x, box.y + box.height + 14);
        await expect(tooltip).toBeHidden();

        // A vertical drag scrolls the page instead of scrubbing: the browser
        // takes over the gesture, the tooltip is cancelled, and the page moves.
        const scrollBefore = await page.evaluate(() => window.scrollY);
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x, y }],
        });
        await expect(tooltip).toBeVisible();
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x, y: y - 80 }],
        });
        await expect(tooltip).toBeHidden();
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
        await expect
          .poll(() => page.evaluate(() => window.scrollY))
          .toBeGreaterThan(scrollBefore);
        await cdp.detach();
      });
    }
  });
}
