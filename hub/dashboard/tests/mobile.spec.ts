import { test, expect, type Page } from "@playwright/test";

const destinations = [
  ["总览", "overview"],
  ["模型分析", "models"],
  ["设备", "devices"],
  ["配额与订阅", "quota"],
  ["历史记录", "history"],
] as const;

async function openDemo(page: Page, view = "overview") {
  await page.goto(`/demo.html#${view}`);
  await expect(page.locator(".mobile-bottom-nav")).toBeVisible();
}

for (const viewport of [
  { width: 320, height: 740 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 844, height: 390 },
]) {
  test.describe(`mobile ${viewport.width} × ${viewport.height}`, () => {
    test.use({ viewport, isMobile: true, hasTouch: true });
    test("all five destinations fit, remain reachable and preserve square charts", async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await openDemo(page);
      const nav = page.getByRole("navigation", { name: "移动端主导航" });
      for (const [name, id] of destinations) {
        await nav.getByRole("link", { name, exact: true }).tap();
        await expect(page).toHaveURL(new RegExp(`#${id}$`));
        await expect(
          nav.getByRole("link", { name, exact: true }),
        ).toHaveAttribute("aria-current", "page");
        const dimensions = await page.evaluate(() => ({
          viewport: innerWidth,
          document: document.documentElement.scrollWidth,
          controls: [...document.querySelectorAll(".mobile-bottom-nav a")].map(
            (node) => {
              const rect = node.getBoundingClientRect();
              return { width: rect.width, height: rect.height };
            },
          ),
          squares: [
            ...document.querySelectorAll(".matrix-cell, .cm-activity-cell"),
          ].map((node) => {
            const rect = node.getBoundingClientRect();
            return Math.abs(rect.width - rect.height);
          }),
        }));
        expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
        expect(
          dimensions.controls.every(
            (item) => item.width >= 44 && item.height >= 44,
          ),
        ).toBe(true);
        expect(dimensions.squares.every((difference) => difference < 0.5)).toBe(
          true,
        );
      }
      expect(errors).toEqual([]);
    });
  });
}

test.describe("mobile reading and actions", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test("model summaries retain cost, cache and details without horizontal scrolling", async ({
    page,
  }) => {
    await openDemo(page, "models");
    const table = page.locator(".model-table");
    await expect(table.locator("tbody tr")).toHaveCount(5);
    const first = table.locator("tbody tr").first();
    await expect(first.locator(".money-cell")).toContainText("$");
    await expect(first.locator(".model-read-cell")).toContainText("万");
    await expect(first.locator(".model-cache-cell")).toContainText("94.0%");
    await page
      .getByRole("textbox", { name: "搜索模型", exact: true })
      .fill("claude");
    await expect(table.locator("tbody tr")).toHaveCount(2);
    await page
      .getByRole("textbox", { name: "搜索模型", exact: true })
      .fill("unmatched-model");
    await expect(page.getByText("没有找到匹配的模型")).toBeVisible();
    await page.getByRole("textbox", { name: "搜索模型", exact: true }).fill("");
    await first.locator(".cache-track").tap();
    const tooltip = page.locator(".metric-tooltip-card");
    await expect(tooltip).toContainText("36,351,746");
    const popup = await tooltip.boundingBox();
    expect(popup!.x).toBeGreaterThanOrEqual(12);
    expect(popup!.x + popup!.width).toBeLessThanOrEqual(378);
    expect(popup!.y).toBeGreaterThanOrEqual(12);
    expect(popup!.y + popup!.height).toBeLessThanOrEqual(832);
    const layers = await page.evaluate(() => ({
      tooltip: Number(
        getComputedStyle(document.querySelector(".metric-tooltip-card")!)
          .zIndex,
      ),
      navigation: Number(
        getComputedStyle(document.querySelector(".mobile-bottom-nav")!).zIndex,
      ),
    }));
    expect(layers.tooltip).toBeGreaterThan(layers.navigation);
    await page.touchscreen.tap(5, 5);
    await expect(tooltip).toBeHidden();
    await first.locator(".model-open").tap();
    const dialog = page.locator(".model-dialog");
    await expect(
      dialog.getByRole("heading", { name: "gpt-6-astra", exact: true }),
    ).toBeVisible();
    await expect(dialog.getByText("缓存读取", { exact: true })).toBeVisible();
    await expect
      .poll(async () => {
        const rect = await dialog.boundingBox();
        return rect && rect.y >= 0 && rect.y + rect.height <= 844;
      })
      .toBe(true);
    await dialog.getByRole("button", { name: "关闭", exact: true }).tap();
    await expect(dialog).toBeHidden();
  });

  test("native date selection and calendar taps feed the existing session filters", async ({
    page,
  }) => {
    await openDemo(page, "history");
    const date = page.getByLabel("按日期筛选会话", { exact: true });
    const firstDay = await page
      .locator("button.cm-activity-cell[data-day]")
      .first()
      .getAttribute("data-day");
    await date.fill(firstDay!);
    await expect(
      page.getByRole("heading", { name: "没有匹配的会话" }),
    ).toBeVisible();
    await expect(
      page.locator(".cm-activity-cell[aria-pressed=true]"),
    ).toHaveCount(1);
    await page.getByRole("button", { name: "取消活动日期选择" }).tap();
    await expect(date).toHaveValue("");
    await page.getByRole("searchbox", { name: "搜索会话" }).fill("重构");
    await expect(page.locator(".sv-session-toggle")).toHaveCount(1);
    await page.getByLabel("筛选会话客户端").selectOption("claude");
    await expect(
      page.getByRole("heading", { name: "没有匹配的会话" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "清除筛选", exact: true }).tap();
    await page.locator(".sv-session-toggle").first().tap();
    await expect(page.locator(".sv-session-detail")).toContainText(
      "MacBook Pro",
    );
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出会话", exact: true }).tap();
    expect((await download).suggestedFilename()).toMatch(
      /^cloud-monitor-sessions-\d{4}-\d{2}-\d{2}\.csv$/,
    );
    await page.locator("button.cm-activity-cell[data-day]").first().tap();
    await expect(date).toHaveValue(firstDay!);
    await expect(
      page.getByRole("heading", { name: "没有匹配的会话" }),
    ).toBeVisible();
  });

  test("the drawer keeps settings available and refresh feedback clears the bottom bar", async ({
    page,
  }) => {
    await openDemo(page);
    await page.getByRole("button", { name: "打开导航", exact: true }).tap();
    const drawer = page.locator(".mobile-nav-dialog");
    await expect(drawer).toBeVisible();
    await drawer.getByRole("button", { name: "工作区设置", exact: true }).tap();
    await expect(page.locator(".settings-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "刷新数据", exact: true }).tap();
    await expect(page.locator(".app-toast")).toBeVisible();
    const toast = await page.locator(".app-toast").boundingBox();
    const nav = await page.locator(".mobile-bottom-nav").boundingBox();
    expect(toast!.y + toast!.height).toBeLessThanOrEqual(nav!.y);
  });
});
