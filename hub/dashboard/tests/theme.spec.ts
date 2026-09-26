import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
});

async function openDashboard(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "用量，一目了然。" })).toBeVisible();
  return errors;
}

async function expectTheme(page: Page, theme: "light" | "dark") {
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("cm_theme"))).toBe(theme);
  await expect(page.getByRole("button", {
    name: theme === "light" ? "切换深色模式" : "切换浅色模式",
  })).toBeVisible();
}

test("theme switching keeps both rapid pointer clicks", async ({ page }) => {
  const errors = await openDashboard(page);
  await page.getByRole("button", { name: "切换深色模式" }).dblclick({ delay: 80 });
  await expectTheme(page, "light");
  expect(errors).toEqual([]);
});

test("theme changes queued before the next render preserve every activation", async ({ page }) => {
  const errors = await openDashboard(page);
  await page.getByRole("button", { name: "切换深色模式" }).evaluate(button => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expectTheme(page, "light");
  expect(errors).toEqual([]);
});

for (const fallback of ["reduced motion", "missing view transitions"] as const) {
  test(`theme switching works with ${fallback}`, async ({ page }) => {
    if (fallback === "reduced motion") {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.addInitScript(() => {
        document.startViewTransition = () => { throw new Error("Reduced motion must not start a view transition"); };
      });
    } else {
      await page.addInitScript(() => {
        Object.defineProperty(document, "startViewTransition", { value: undefined });
      });
    }
    const errors = await openDashboard(page);
    await page.getByRole("button", { name: "切换深色模式" }).click();
    await expectTheme(page, "dark");
    await page.getByRole("button", { name: "切换浅色模式" }).click();
    await expectTheme(page, "light");
    expect(errors).toEqual([]);
  });
}

test("theme toggle follows a changed system preference until the user chooses", async ({ page }) => {
  const errors = await openDashboard(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "切换浅色模式" }).click();
  await expectTheme(page, "light");
  await page.emulateMedia({ colorScheme: "light" });
  await page.emulateMedia({ colorScheme: "dark" });
  await expectTheme(page, "light");
  expect(errors).toEqual([]);
});
