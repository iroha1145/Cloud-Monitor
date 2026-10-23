import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { finishAnimations, revealAll, scrollIntoViewAndReveal } from "./motion-helpers";

const destinations = [
  ["overview", "总览"], ["models", "模型分析"], ["devices", "设备"],
  ["quota", "配额与订阅"], ["history", "历史记录"],
] as const;

async function loadedPage(page: Page, id: typeof destinations[number][0]) {
  const markers = {
    overview: [".models-panel", ".insight-trend-canvas"],
    models: [".model-table", ".matrix-panel", ".projects-panel"],
    devices: [".sv-device-main"],
    quota: [".sv-quota-card", ".sv-subscription"],
    history: [".cm-activity-panel", ".sv-session-table", ".archive-panel"],
  };
  for (const marker of markers[id]) await expect(page.locator(marker).first()).toBeVisible();
  await expect(page.locator(".skeleton-stage")).toHaveCount(0);
}

async function fitsPage(page: Page) {
  const size = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  expect(size.scroll).toBeLessThanOrEqual(size.width + 1);
}

for (const width of [320, 1440]) {
  test(`quick search keeps its keyboard hint clear of the close target at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/demo.html");
    await page.getByRole("button", { name: "搜索或快速跳转", exact: true }).click();
    const dialog = page.locator(".search-dialog");
    await finishAnimations(dialog);
    const hint = await dialog.locator(".search-dialog-heading kbd").boundingBox();
    const close = await dialog.getByRole("button", { name: "关闭", exact: true }).boundingBox();
    expect(hint!.x + hint!.width + 8).toBeLessThanOrEqual(close!.x);
    await dialog.getByRole("textbox").fill("不存在的模型");
    await expect(dialog.getByText("没有找到匹配项", { exact: true })).toBeVisible();
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await expect(dialog.getByText("试试模型名称，或输入“设备”。", { exact: true })).toHaveCSS("font-size", "14px");
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(dialog).toBeHidden();
  });
}

for (const width of [320, 390, 768, 1440]) {
  test(`all pages retain a readable hierarchy and fit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    for (const [id, name] of destinations) {
      await page.goto(`/demo.html#${id}`);
      await expect(page.getByRole("heading", { name, exact: true, level: 1 })).toBeVisible();
      await loadedPage(page, id);
      await revealAll(page);
      await fitsPage(page);
      const hierarchy = await page.locator(".main-content").evaluate(root => {
        const size = (element: Element) => parseFloat(getComputedStyle(element).fontSize);
        return { title: size(root.querySelector("h1")!),
          captions: [...root.querySelectorAll(".heading-mode, .panel-head p, .sv-summary-label")]
            .filter(element => element.getClientRects().length).map(size) };
      });
      expect(hierarchy.title).toBeGreaterThanOrEqual(24);
      for (const caption of hierarchy.captions) {
        expect(caption).toBeGreaterThanOrEqual(14);
        expect(caption).toBeLessThan(hierarchy.title);
      }
      if (width === 390 || width === 1440) {
        mkdirSync("evidence/typeui", { recursive: true });
        await page.screenshot({ path: `evidence/typeui/${id}-${width}.png`, animations: "disabled" });
      }
    }
  });
}

for (const width of [320, 390, 1440]) {
  test(`model details keep their heading separate from scrollable session content at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    await page.goto("/demo.html#models");
    await page.getByRole("button", { name: "查看 gpt-6-astra 详情", exact: true }).click();
    const dialog = page.locator(".model-dialog");
    await finishAnimations(dialog);
    const header = dialog.locator(".model-detail-heading");
    const body = dialog.locator(".model-details-content");
    const summary = dialog.locator(".session-usage-card > summary").first();
    const sessionHeading = dialog.locator(".model-session-section > .detail-section-heading");
    const sectionBox = await sessionHeading.boundingBox();
    const cardBox = await dialog.locator(".session-usage-card").first().boundingBox();
    const countBox = await sessionHeading.locator("span").boundingBox();
    expect(cardBox!.y - (sectionBox!.y + sectionBox!.height)).toBeGreaterThanOrEqual(12);
    expect(sectionBox!.x).toBeCloseTo(cardBox!.x, 1);
    expect(countBox!.x + countBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width);
    const titleBox = await summary.locator(".session-card-title").boundingBox();
    const amountBox = await summary.locator(".session-card-amount").boundingBox();
    expect(titleBox!.x + titleBox!.width <= amountBox!.x || titleBox!.y + titleBox!.height <= amountBox!.y).toBe(true);
    await summary.click();
    await dialog.locator(".session-token-breakdown").first().scrollIntoViewIfNeeded();
    const metrics = await dialog.evaluate(root => {
      const header = root.querySelector(".model-detail-heading")!.getBoundingClientRect();
      const body = root.querySelector(".model-details-content")!;
      const title = root.querySelector('[data-slot="dialog-title"]')!;
      const section = root.querySelector(".detail-section-heading h3")!;
      const label = root.querySelector(".session-token-grid dt")!;
      const size = (element: Element) => parseFloat(getComputedStyle(element).fontSize);
      return { headerBottom: header.bottom, bodyTop: body.getBoundingClientRect().top,
        scroll: body.scrollWidth, width: body.clientWidth,
        title: size(title), section: size(section), label: size(label) };
    });
    expect(metrics.bodyTop).toBeGreaterThanOrEqual(metrics.headerBottom - 1);
    expect(metrics.scroll).toBeLessThanOrEqual(metrics.width + 1);
    expect(metrics.title).toBeGreaterThan(metrics.section);
    expect(metrics.section).toBeGreaterThan(metrics.label);
    expect(metrics.label).toBeGreaterThanOrEqual(14);
    const headingBefore = await header.boundingBox();
    await body.hover();
    await page.mouse.wheel(0, 1200);
    await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    expect((await header.boundingBox())!.y).toBeCloseTo(headingBefore!.y, 1);
    const close = dialog.getByRole("button", { name: "关闭", exact: true });
    const closeBox = await close.boundingBox();
    expect(closeBox!.width).toBeGreaterThanOrEqual(44);
    expect(closeBox!.height).toBeGreaterThanOrEqual(44);
    await expect(close).toBeInViewport();
    await fitsPage(page);
    await dialog.locator(".session-token-breakdown").first().scrollIntoViewIfNeeded();
    mkdirSync("evidence/typeui", { recursive: true });
    await page.screenshot({ path: `evidence/typeui/model-session-${width}.png`, animations: "disabled" });
    await close.click();
    await expect(dialog).toBeHidden();
  });
}

test("all pages and model details reflow when reading text is enlarged to 200 percent", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const [id, name] of destinations) {
    await page.goto(`/demo.html#${id}`);
    await page.addStyleTag({ content: ":root { font-size: 200%; }" });
    await expect.poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))).toBe(32);
    await expect(page.getByRole("heading", { name, exact: true, level: 1 })).toBeVisible();
    await loadedPage(page, id);
    await revealAll(page);
    await fitsPage(page);
  }
  await page.goto("/demo.html#models");
  await page.addStyleTag({ content: ":root { font-size: 200%; }" });
  await expect.poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))).toBe(32);
  await page.getByRole("button", { name: "查看 gpt-6-astra 详情", exact: true }).click();
  const dialog = page.locator(".model-dialog");
  await finishAnimations(dialog);
  await dialog.locator(".session-usage-card > summary").first().click();
  const facts = dialog.locator(".session-facts").first();
  await facts.scrollIntoViewIfNeeded();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await facts.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await expect(dialog.getByRole("button", { name: "关闭", exact: true })).toBeInViewport();
  await fitsPage(page);
});

test("portalled model details keep the same type roles after history styles load and in dark mode", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await page.goto("/demo.html#overview");
  const inspect = async () => {
    await page.getByRole("button", { name: "查看 gpt-6-astra 详情", exact: true }).click();
    const dialog = page.locator(".model-dialog");
    await finishAnimations(dialog);
    const values = await dialog.locator('[data-slot="dialog-title"], .detail-section-heading h3, .detail-footnote').evaluateAll(elements =>
      elements.map(element => ({ size: getComputedStyle(element).fontSize, height: getComputedStyle(element).lineHeight })));
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.keyboard.press("Escape");
    return values;
  };
  const before = await inspect();
  await page.getByRole("button", { name: "打开导航", exact: true }).click();
  await page.getByRole("dialog", { name: "导航", exact: true }).getByRole("link", { name: "历史记录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "历史记录", level: 1 })).toBeVisible();
  await loadedPage(page, "history");
  await page.getByRole("link", { name: "总览", exact: true }).filter({ visible: true }).click();
  expect(await inspect()).toEqual(before);
});

test("a long model name and 200 percent text leave phone details scrollable and closable", async ({ page }) => {
  const fixture = createRequire(import.meta.url)("./fixtures/overview.json");
  const longName = "private-model-" + "abcdefghijklmnop".repeat(7);
  const overview = JSON.parse(JSON.stringify(fixture).replaceAll("gpt-5.2", longName));
  await page.setViewportSize({ width: 320, height: 568 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/**", route => route.fulfill({ json: route.request().url().endsWith("/overview") ? overview : {} }));
  await page.goto("/");
  await page.getByRole("button", { name: "打开导航", exact: true }).click();
  await page.getByRole("dialog", { name: "导航", exact: true }).getByRole("button", { name: "工作区设置", exact: true }).click();
  await page.getByLabel("访问密钥", { exact: true }).fill("typeui-long-name-fixture");
  await page.getByRole("button", { name: "连接并查看真实用量", exact: true }).click();
  await page.locator(".app-toast").getByRole("button", { name: "关闭提示" }).click();
  await page.getByRole("button", { name: `查看 ${longName} 详情`, exact: true }).click();
  const dialog = page.locator(".model-dialog");
  await finishAnimations(dialog);
  await page.addStyleTag({ content: ":root { font-size: 200%; }" });
  await expect(dialog.getByRole("heading", { name: longName, exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))).toBe(32);
  await expect(dialog.locator('[data-slot="dialog-title"]')).toHaveCSS("font-size", "48px");
  const body = dialog.locator(".model-details-content");
  expect(await body.evaluate(element => {
    const style = getComputedStyle(element);
    return element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  })).toBeGreaterThanOrEqual(120);
  expect(await body.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await expect(dialog.getByRole("button", { name: "关闭", exact: true })).toBeInViewport();
  const identity = dialog.getByLabel("模型名称与统计周期", { exact: true });
  await identity.focus();
  await expect(identity).toBeFocused();
  await identity.press("End");
  await expect.poll(() => identity.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await page.screenshot({ path: "evidence/typeui/long-model-200-percent.png", animations: "disabled" });
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog).toBeHidden();
});

test("metric details keep enlarged text inside the viewport and close on real scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/demo.html#models");
  await loadedPage(page, "models");
  await page.addStyleTag({ content: ":root { font-size: 200%; }" });
  await expect.poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))).toBe(32);
  const cache = page.locator(".model-table .cache-track").first();
  await scrollIntoViewAndReveal(cache);
  await cache.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toContainText("缓存读取");
  await expect(tooltip).toContainText("费用");
  const bounds = await tooltip.evaluate(element => {
    const box = element.getBoundingClientRect();
    return { left: box.left, top: box.top, right: box.right, bottom: box.bottom,
      width: element.clientWidth, scroll: element.scrollWidth };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(1440);
  expect(bounds.bottom).toBeLessThanOrEqual(1000);
  expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1);
  await expect(tooltip.locator("dt").first()).toHaveCSS("font-size", "28px");
  await page.mouse.wheel(0, 120);
  await expect(tooltip).toBeHidden();
});

for (const width of [320, 390]) {
  test(`phone quick navigation gives its four places equal width at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 760 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/demo.html#overview");
    await loadedPage(page, "overview");
    const places = await page.locator(".feel-quick-navigation > *").evaluateAll(elements => elements.map(element => {
      const label = element.querySelector("span")!;
      return { width: element.getBoundingClientRect().width, fits: label.scrollWidth <= label.clientWidth + 1 && label.getBoundingClientRect().right <= element.getBoundingClientRect().right };
    }));
    expect(places).toHaveLength(4);
    for (const place of places) {
      expect(place.width).toBeCloseTo(places[0].width, 0);
      expect(place.fits).toBe(true);
    }
  });
}

test("text stays light: grayscale smoothing and no weight above 500 except the brand name", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const [id] of destinations) {
    await page.goto(`/demo.html#${id}`);
    await loadedPage(page, id);
    await revealAll(page);
    const heavy = await page.evaluate(() => {
      const found = new Set<string>();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const element = node.parentElement;
        if (!node.textContent?.trim() || !element || !element.getClientRects().length || element.closest(".app-brand, .sr-only")) continue;
        if (Number(getComputedStyle(element).fontWeight) > 500) found.add(`${element.className || element.tagName}: ${node.textContent.trim().slice(0, 20)}`);
      }
      return [...found];
    });
    expect(heavy).toEqual([]);
    expect(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue("-webkit-font-smoothing"))).toBe("antialiased");
  }
});

test("session details keep one hierarchy in the model dialog and in history rows", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const roles = (root: Element) => {
    const size = (selector: string) => parseFloat(getComputedStyle(root.querySelector(selector)!).fontSize);
    return { subheading: size(".session-details-content .detail-section-heading h3"), label: size(".session-facts dt"),
      value: size(".session-facts dd"), note: parseFloat(getComputedStyle(root.querySelector(".session-token-breakdown .detail-footnote")!).marginTop) };
  };
  // History first, so its page sheet is loaded before the dialog opens.
  await page.goto("/demo.html#history");
  await loadedPage(page, "history");
  await page.locator(".sv-session-table tbody button").first().click();
  const history = await page.locator(".sv-session-detail").first().evaluate(roles);
  await page.locator("aside").getByRole("link", { name: "模型分析" }).click();
  await loadedPage(page, "models");
  await page.getByRole("button", { name: "查看 gpt-6-astra 详情", exact: true }).click();
  const dialog = page.locator(".model-dialog");
  await finishAnimations(dialog);
  const summary = dialog.locator(".session-usage-card > summary").first();
  await summary.click();
  const inDialog = await dialog.evaluate(roles);
  expect(inDialog).toEqual(history);
  const cardTitle = await summary.locator(".session-card-title strong").evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  expect(inDialog.subheading).toBeLessThan(cardTitle);
  expect(inDialog.value).toBe(16);
  expect(inDialog.label).toBe(14);
  expect(inDialog.note).toBeGreaterThanOrEqual(8);
  await expect(dialog.locator(".session-token-breakdown .detail-footnote").first()).not.toContainText("。 ");
});

for (const width of [320, 1440]) {
  test(`quick search centres its close button on the heading row at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/demo.html");
    await page.getByRole("button", { name: "搜索或快速跳转", exact: true }).click();
    const dialog = page.locator(".search-dialog");
    await finishAnimations(dialog);
    const heading = (await dialog.locator(".search-dialog-heading").boundingBox())!;
    const close = (await dialog.getByRole("button", { name: "关闭", exact: true }).boundingBox())!;
    const box = (await dialog.boundingBox())!;
    expect(close.y + close.height / 2).toBeCloseTo(heading.y + heading.height / 2, 0);
    expect(close.y + close.height).toBeLessThanOrEqual(heading.y + heading.height);
    expect(heading.x - box.x).toBeLessThanOrEqual(1.5);
  });
}
