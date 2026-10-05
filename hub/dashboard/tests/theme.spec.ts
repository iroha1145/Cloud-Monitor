import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
});

async function openDashboard(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "总览", level: 1 })).toBeVisible();
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

// A document view transition blocks pointer input while its snapshot animates,
// so the toggle swaps only the button's icons (App.tsx). Guard against a
// transition coming back, with and without reduced motion.
for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`theme switching never starts a document view transition (${reducedMotion})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await page.addInitScript(() => {
      (window as unknown as { viewTransitions: number }).viewTransitions = 0;
      document.startViewTransition = ((update?: () => void) => {
        (window as unknown as { viewTransitions: number }).viewTransitions += 1;
        update?.();
        return undefined as unknown as ViewTransition;
      }) as typeof document.startViewTransition;
    });
    const errors = await openDashboard(page);
    await page.getByRole("button", { name: "切换深色模式" }).click();
    await expectTheme(page, "dark");
    await page.getByRole("button", { name: "切换浅色模式" }).click();
    await expectTheme(page, "light");
    expect(await page.evaluate(() => (window as unknown as { viewTransitions: number }).viewTransitions)).toBe(0);
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
