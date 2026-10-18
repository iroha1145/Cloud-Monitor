import { expect, test, type Locator, type Page } from "@playwright/test";

const names = ["overview", "models", "devices", "quota", "history", "search", "settings", "download", "refresh", "close", "menu"];
async function openFixture(page: Page) {
  await page.route("**/__animated-nav-icon-test", async route => {
    // Keep Vite's React refresh preamble when mounting a standalone fixture.
    const response = await route.fetch({ url: new URL("/", route.request().url()).href });
    const body = (await response.text()).replace(/\/src\/main\.tsx(?:\?[^"']*)?/, "/tests/fixtures/animated-nav-icon-fixture.tsx");
    await route.fulfill({ response, body });
  });
  await page.goto("/__animated-nav-icon-test");
  await expect(page.getByRole("button", { name: "overview control", exact: true })).toBeVisible();
}
const animationCount = (icon: Locator) => icon.evaluate(svg => svg.getAnimations({ subtree: true }).length);

test("each icon animates internal strokes from its owning control once and keeps its decorative SVG contract", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openFixture(page);
  for (const name of names) {
    const button = page.getByRole("button", { name: `${name} control`, exact: true });
    const icon = button.locator("svg");
    await expect(icon).toHaveAttribute("width", "19");
    await expect(icon).toHaveAttribute("height", "19");
    await expect(icon).toHaveAttribute("stroke", "currentColor");
    await expect(icon).toHaveAttribute("stroke-width", "2");
    await expect(icon).toHaveAttribute("aria-hidden", "true");
    await expect(icon).toHaveAttribute("focusable", "false");
    await button.hover();
    await expect.poll(() => animationCount(icon)).toBeGreaterThan(0);
    expect(await icon.evaluate(svg => svg.getAnimations().length)).toBe(0);
    await expect.poll(() => animationCount(icon)).toBe(0);
  }
  const button = page.getByRole("button", { name: "search control", exact: true });
  const icon = button.locator("svg");
  await page.locator("body").hover({ position: { x: 1, y: 1 } });
  await button.focus();
  await expect.poll(() => animationCount(icon)).toBeGreaterThan(0);
  await expect.poll(() => animationCount(icon)).toBe(0);
  await button.press("Enter");
  await expect.poll(() => animationCount(icon)).toBeGreaterThan(0);
  await expect(page.getByLabel("Actions", { exact: true })).toHaveText("1");
  await expect.poll(() => animationCount(icon)).toBe(0);
  await button.dispatchEvent("pointerdown", { pointerType: "touch", pointerId: 42 });
  await expect.poll(() => animationCount(icon)).toBeGreaterThan(0);
  await page.getByRole("link", { name: "Link control", exact: true }).click();
  await expect(page).toHaveURL(/#action$/);
});

test("active changes animate without loops and unmount removes running feedback", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openFixture(page);
  const icon = page.locator('[data-animated-icon="overview"]');
  expect(await animationCount(icon)).toBe(0);
  await page.getByRole("button", { name: "Toggle active", exact: true }).click();
  await expect(icon).toHaveAttribute("data-active", "true");
  await expect.poll(() => animationCount(icon)).toBeGreaterThan(0);
  await expect.poll(() => animationCount(icon)).toBe(0);
  await page.getByRole("button", { name: "Toggle active", exact: true }).click();
  await expect(icon).toHaveAttribute("data-active", "false");
  await expect.poll(() => animationCount(icon)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Toggle mounted", exact: true }).click();
  await expect(icon).toHaveCount(0);
  await page.getByRole("button", { name: "overview control", exact: true }).hover();
  await page.getByRole("button", { name: "Toggle mounted", exact: true }).click();
  await expect(icon).toHaveCount(1);
  expect(await animationCount(icon)).toBe(0);
  expect(errors).toEqual([]);
});

test("reduced motion is static for pointer focus press and active changes and cancels in-flight strokes", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openFixture(page);
  const button = page.getByRole("button", { name: "refresh control", exact: true });
  const icon = button.locator("svg");
  await button.hover();
  await button.focus();
  await button.press("Enter");
  await page.getByRole("button", { name: "Toggle active", exact: true }).click();
  expect(await animationCount(icon)).toBe(0);
  expect(await page.locator("svg").evaluateAll(icons => icons.flatMap(svg => svg.getAnimations({ subtree: true })).length)).toBe(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await button.hover();
  await expect.poll(() => animationCount(icon)).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => animationCount(icon)).toBe(0);
});
