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
  await expect(page.getByRole("combobox", { name: "外观设置" })).toBeVisible();
}

async function chooseTheme(page: Page, name: string) {
  await page.getByRole("combobox", { name: "外观设置" }).click();
  await page.getByRole("option", { name, exact: true }).click();
}

async function expectSelection(page: Page, name: string) {
  await page.getByRole("combobox", { name: "外观设置" }).click();
  await expect(page.getByRole("option", { name, exact: true })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
}

test("theme reveal starts at the menu trigger and settles in both directions", async ({ page }) => {
  const errors = await openDashboard(page);
  await page.evaluate(() => {
    const start = document.startViewTransition.bind(document);
    document.startViewTransition = ((update: () => void) => {
      document.documentElement.dataset.snapshotMenuCount = String(document.querySelectorAll('[role="listbox"]').length);
      return start(update);
    }) as typeof document.startViewTransition;
  });
  const box = await page.getByRole("combobox", { name: "外观设置" }).boundingBox();
  for (const [label, appearance] of [["深色", "dark"], ["浅色", "light"]] as const) {
    await chooseTheme(page, label);
    await expectTheme(page, appearance);
    await expect(page.locator("html")).toHaveAttribute("data-snapshot-menu-count", "0");
    await expect(page.locator("html")).toHaveAttribute("data-theme-switching", "");
    const origin = await page.locator("html").evaluate(root => ({
      x: (root as HTMLElement).style.getPropertyValue("--theme-x"),
      y: (root as HTMLElement).style.getPropertyValue("--theme-y"),
      animation: getComputedStyle(root, "::view-transition-new(root)").animationName,
    }));
    expect(origin).toEqual({ x: `${box!.x + box!.width / 2}px`, y: `${box!.y + box!.height / 2}px`, animation: "theme-reveal" });
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(page.locator("html")).not.toHaveAttribute("data-theme-switching");
  }
  expect(errors).toEqual([]);
});

test("successive menu choices keep the latest appearance and keyboard focus", async ({ page }) => {
  const errors = await openDashboard(page);
  await chooseTheme(page, "深色");
  await chooseTheme(page, "浅色");
  await expectTheme(page, "light");
  await expect(page.locator("html")).not.toHaveAttribute("data-theme-switching");
  await expect(page.getByRole("combobox", { name: "外观设置" })).toBeFocused();
  expect(errors).toEqual([]);
});

for (const fallback of ["reduce", "unsupported"] as const) {
  test(`theme changes immediately with ${fallback}`, async ({ page }) => {
    if (fallback === "reduce") await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(mode => {
      Object.defineProperty(document, "startViewTransition", { configurable: true, value: mode === "unsupported" ? undefined : () => { throw new Error("Reduced motion must not animate"); } });
    }, fallback);
    const errors = await openDashboard(page);
    await chooseTheme(page, "深色");
    await expectTheme(page, "dark");
    await chooseTheme(page, "浅色");
    await expectTheme(page, "light");
    await expect(page.locator("html")).not.toHaveAttribute("data-theme-switching");
    expect(errors).toEqual([]);
  });
}

test("theme toggle follows a changed system preference until the user chooses", async ({ page }) => {
  const errors = await openDashboard(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await chooseTheme(page, "浅色");
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
  await chooseTheme(page, "深色");
  await expectTheme(page, "dark");
  await page.reload();
  await expectTheme(page, "dark");
  await chooseTheme(page, "跟随系统");
  await expectSelection(page, "跟随系统");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("cm_theme"))).toBe("system");
  await page.reload();
  await expectSelection(page, "跟随系统");
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
  await expectSelection(page, "深色");
  await chooseTheme(page, "跟随系统");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expectSelection(page, "跟随系统");
});

test("unavailable storage preserves manual override in memory and allows automatic mode", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Unavailable", "SecurityError"); } });
  });
  const errors = await openDashboard(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await chooseTheme(page, "浅色");
  await page.emulateMedia({ colorScheme: "light" });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await chooseTheme(page, "跟随系统");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(errors).toEqual([]);
});

test("system mode remains available in a 320px topbar without overflow", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await openDashboard(page);
  await expectSelection(page, "跟随系统");
  await chooseTheme(page, "深色");
  await expectTheme(page, "dark");
  expect(await page.locator(".app-topbar").evaluate(bar => bar.scrollWidth <= bar.clientWidth)).toBe(true);
});
