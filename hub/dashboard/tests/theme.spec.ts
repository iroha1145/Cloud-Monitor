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

for (const colorScheme of ["light", "dark"] as const) {
  test(`new visitors follow ${colorScheme} before the app loads`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.route("**/src/main.tsx*", route => route.abort());
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
    await expect(page.locator("html")).toHaveCSS("color-scheme", colorScheme);
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", colorScheme === "dark" ? "#111111" : "#fafafa");
  });
}

test("manual mode can return to system and stays automatic after refresh", async ({ page }) => {
  const errors = await openDashboard(page);
  await page.getByRole("button", { name: "切换深色模式" }).click();
  await expectTheme(page, "dark");
  await page.reload();
  await expectTheme(page, "dark");
  await page.getByRole("button", { name: "跟随系统", exact: true }).click();
  await expect(page.getByRole("button", { name: "跟随系统", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("cm_theme"))).toBe("system");
  await page.reload();
  await expect(page.getByRole("button", { name: "跟随系统", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#111111");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(errors).toEqual([]);
});

test("legacy manual preference can be replaced with persistent system mode", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("cm-preview-theme", "dark"));
  await openDashboard(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("button", { name: "跟随系统", exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "跟随系统", exact: true }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("button", { name: "跟随系统", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("unavailable storage preserves manual override in memory and allows automatic mode", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Unavailable", "SecurityError"); } });
  });
  const errors = await openDashboard(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "切换浅色模式" }).click();
  await page.emulateMedia({ colorScheme: "light" });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "跟随系统", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(errors).toEqual([]);
});

test("system mode remains available in a 320px topbar without overflow", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await openDashboard(page);
  const follow = page.getByRole("button", { name: "跟随系统", exact: true });
  await expect(follow).toBeVisible();
  await follow.click();
  await expect(follow).toHaveAttribute("aria-pressed", "true");
  expect(await page.locator(".app-topbar").evaluate(bar => bar.scrollWidth <= bar.clientWidth)).toBe(true);
});
