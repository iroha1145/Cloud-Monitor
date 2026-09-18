import { expect, test, type Locator, type Page } from "@playwright/test";

function countDocumentLoads(page: Page) {
  let count = 0;
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.resourceType() === "document"
      && request.frame() === page.mainFrame()) count++;
  });
  return () => count;
}

async function clickWithoutBrowserFocus(opener: Locator) {
  // Safari-style mouse activation: the click opens the dialog, but does not
  // move activeElement to the button before the dialog is mounted.
  await opener.evaluate((node) => node.addEventListener("mousedown", (event) => event.preventDefault(), { once: true }));
  await opener.click();
}

test("secondary views share one recovery reload even when the module remains unavailable", async ({ page }) => {
  const loads = countDocumentLoads(page);
  await page.route("**/src/SecondaryViews.tsx", (route) => route.fulfill({ status: 404, body: "missing chunk" }));
  await page.goto("/demo.html#devices");
  await expect(page.getByRole("alert")).toContainText("页面已更新，请刷新后继续。");
  for (const id of ["quota", "history"]) {
    await page.locator(`aside a[href="#${id}"]`).click();
    await expect(page).toHaveURL(new RegExp(`#${id}$`));
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("alert")).toContainText("页面已更新，请刷新后继续。");
  }
  expect(loads()).toBe(2);
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith("cm-chunk-reload:"))))
    .toEqual(["cm-chunk-reload:secondary"]);
});

test("one stale secondary chunk recovers after one reload", async ({ page }) => {
  const loads = countDocumentLoads(page);
  let requests = 0;
  await page.route("**/src/SecondaryViews.tsx", (route) => ++requests === 1
    ? route.fulfill({ status: 404, body: "old chunk missing" }) : route.continue());
  await page.goto("/demo.html#devices");
  await expect(page.getByRole("region", { name: "设备概况" })).toBeVisible();
  await page.locator('aside a[href="#quota"]').click();
  await expect(page.locator(".sv-page")).toBeVisible();
  expect(loads()).toBe(2);
  expect(await page.evaluate(() => sessionStorage.getItem("cm-chunk-reload:secondary"))).toBeNull();
});

for (const width of [1512, 390]) {
  test(`failed curve retains totals and working day navigation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const loads = countDocumentLoads(page);
    await page.route("**/liveline.js*", (route) => route.fulfill({ status: 404, body: "missing curve" }));
    await page.goto("/demo.html");
    const trend = page.getByRole("region", { name: "用量趋势" });
    await expect(trend.getByText("趋势曲线暂时无法加载")).toBeVisible();
    await expect(trend.locator(".insight-trend-metrics")).toContainText("区间词元");
    const slider = trend.getByRole("slider");
    const lastDay = await slider.getAttribute("aria-valuetext");
    await trend.getByRole("button", { name: "查看前一天记录" }).click();
    await expect(slider).not.toHaveAttribute("aria-valuetext", lastDay!);
    await slider.focus();
    await slider.press("End");
    await expect(slider).toHaveAttribute("aria-valuetext", lastDay!);
    expect(loads()).toBe(2);
  });

  test(`dialog restores its actual opener without mouse focus at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/demo.html");
    const openers = ["搜索或快速跳转", "查看 gpt-6-astra 详情"];
    // The avatar is intentionally hidden on mobile; its settings entry lives
    // in the navigation drawer and is exercised by the handoff test below.
    if (width > 600) openers.push("打开工作区设置");
    for (const name of openers) {
      const opener = page.getByRole("button", { name, exact: true });
      await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
      await clickWithoutBrowserFocus(opener);
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toBeHidden();
      await expect(opener).toBeFocused();
    }
  });
}

test("mobile drawer-to-settings handoff retains dialog focus and returns to the menu button", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/demo.html");
  const opener = page.getByRole("button", { name: "打开导航", exact: true });
  await clickWithoutBrowserFocus(opener);
  const drawer = page.getByRole("dialog", { name: "导航", exact: true });
  await drawer.getByRole("button", { name: "工作区设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "演示工作区", exact: true });
  await expect(settings).toBeVisible();
  await expect.poll(() => settings.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect(opener).toBeFocused();
});

test("dialog render failure leaves a visible notice and allows a later successful open", async ({ page }) => {
  await page.route("**/src/AppDialogs.tsx", async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const declaration = /^export default function AppDialogs\(.*\) \{/m;
    expect(source).toMatch(declaration);
    await route.fulfill({ response, body: source.replace(declaration,
      '$&\n if (window.__auditDialogFailure) throw new Error("test dialog render failure");') });
  });
  await page.goto("/demo.html");
  await page.evaluate(() => { (window as unknown as { __auditDialogFailure: boolean }).__auditDialogFailure = true; });
  await page.getByRole("button", { name: "搜索或快速跳转" }).click();
  await expect(page.getByRole("alert")).toContainText("对话框未能打开");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.evaluate(() => { (window as unknown as { __auditDialogFailure: boolean }).__auditDialogFailure = false; });
  await page.getByRole("button", { name: "搜索或快速跳转" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
