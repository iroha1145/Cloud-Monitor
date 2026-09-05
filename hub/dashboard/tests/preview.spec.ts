import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const contractOverview = require('./fixtures/overview.json');
const contractProviders = require('./fixtures/provider-status.json');

test('real API contract keeps model cache visible and can return to demo', async ({page}) => {
  await page.goto('/');
  await page.route('**/api/**', route => route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(route.request().url().endsWith('/overview') ? contractOverview : route.request().url().endsWith('/provider-status') ? contractProviders : {})}));
  await page.getByRole('button',{name:'连接我的数据'}).click();
  await page.getByLabel('访问密钥',{exact:true}).fill('local-contract-fixture');
  await page.getByRole('button',{name:'连接并查看真实用量'}).click();
  await expect(page.getByText('当前展示真实数据')).toBeVisible();
  await page.getByRole('button',{name:'查看 gpt-5.2 详情'}).click();
  const dialog=page.getByRole('dialog');
  await expect(dialog.getByText('缓存读取',{exact:true})).toBeVisible();
  await expect(dialog.getByText('28.6 万',{exact:true})).toBeVisible();
  await page.screenshot({path:'evidence/live-contract-model.png',animations:'disabled'});
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'管理数据连接'}).click();
  await page.getByRole('button',{name:'继续浏览示例工作区'}).click();
  await expect(page.getByText('当前展示示例数据')).toBeVisible();
});

test('late connection responses cannot replace a newly selected demo workspace', async ({page}) => {
  await page.route('**/api/**', async route => {
    await new Promise(r=>setTimeout(r,600));
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(route.request().url().endsWith('/overview') ? contractOverview : {})});
  });
  await page.getByRole('button',{name:'连接我的数据'}).click();
  await page.getByLabel('访问密钥',{exact:true}).fill('local-delayed-fixture');
  const request = page.waitForRequest('**/api/v1/tm/overview');
  await page.getByRole('button',{name:'连接并查看真实用量'}).click();await request;
  await page.getByRole('button',{name:'继续浏览示例工作区'}).click();
  await page.waitForTimeout(700); // old request is aborted; its delayed result must stay ignored
  await expect(page.getByText('当前展示示例数据')).toBeVisible();
  await expect(page.getByRole('button',{name:'查看 gpt-6-astra 详情'})).toBeVisible();
});

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "用量，一目了然。" }),
  ).toBeVisible();
});

test("overview preserves cache counts, period changes, and model details", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(
    page.getByRole("button", { name: "查看 gpt-6-astra 详情" }),
  ).toBeVisible();
  const stats = page.getByRole("region", { name: "用量摘要" });
  const today = await stats.textContent();
  await page
    .getByRole("tablist", { name: "统计周期" })
    .getByRole("tab", { name: "本月", exact: true })
    .click();
  await expect(stats).not.toHaveText(today!);
  await page
    .getByRole("tablist", { name: "统计周期" })
    .getByRole("tab", { name: "今日", exact: true })
    .click();
  await page.getByRole("button", { name: "查看 gpt-6-astra 详情" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "gpt-6-astra" }),
  ).toBeVisible();
  await expect(dialog.getByText("缓存读取", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  expect(errors).toEqual([]);
});

test("model search, quick navigation, export and refresh work", async ({
  page,
}) => {
  await page.locator("aside").getByRole("link", { name: "模型分析" }).click();
  await page.getByLabel("搜索模型").fill("not-a-model");
  await expect(page.getByText("没有找到匹配的模型")).toBeVisible();
  await page.getByLabel("搜索模型").fill("gpt");
  await expect(page.locator(".model-table tbody tr")).toHaveCount(1);
  await page.getByRole("button", { name: "搜索或快速跳转" }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("历史");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "历史记录", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "历史记录", exact: true }),
  ).toBeVisible();
  await page
    .locator("aside")
    .getByRole("link", { name: "总览", exact: true })
    .click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出数据", exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toContain("demo-today.csv");
  expect(await fs.readFile((await file.path())!, "utf8")).toContain("缓存读取");
  await page.getByRole("button", { name: "刷新数据", exact: true }).click();
  await expect(page.locator(".app-toast")).toContainText("示例数据已重新加载");
});

test("connection failure stays honest and does not change the demo workspace", async ({
  page,
}) => {
  await page.route("**/api/**", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: '{"detail":"Unauthorized"}',
    }),
  );
  await page.getByRole("button", { name: "连接我的数据" }).click();
  await page
    .getByLabel("访问密钥", { exact: true })
    .fill("preview-test-invalid-key");
  await page.getByRole("button", { name: "连接并查看真实用量" }).click();
  await expect(page.getByRole("alert")).toContainText("访问密钥不正确");
  await page.keyboard.press("Escape");
  await expect(page.getByText("当前展示示例数据")).toBeVisible();
  expect(
    await page.evaluate(() => Object.values(localStorage).join(" ")),
  ).not.toContain("preview-test-invalid-key");
});

test("desktop and dark appearances have no serious accessibility errors", async ({
  page,
}) => {
  await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
  const audit = async () =>
    page.evaluate(async () => {
      const result = await (window as any).axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      });
      return result.violations.map((v: any) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes
          .slice(0, 5)
          .map((n: any) => ({ target: n.target, summary: n.failureSummary })),
      }));
    });
  await fs.mkdir("evidence", { recursive: true });
  await page.screenshot({
    path: "evidence/overview-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  const light = await audit();
  await page.getByRole("button", { name: "切换深色模式" }).click();
  await expect(page.locator("html")).toHaveClass("dark");
  await page.screenshot({
    path: "evidence/overview-dark.png",
    fullPage: true,
    animations: "disabled",
  });
  const dark = await audit();
  await fs.writeFile(
    "evidence/accessibility.json",
    JSON.stringify({ light, dark }, null, 2),
  );
  expect(light).toEqual([]);
  expect(dark).toEqual([]);
});

test("mobile navigation, dialogs and reduced motion are usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.screenshot({
    path: "evidence/overview-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "打开导航" }).click();
  await page
    .getByRole("dialog")
    .getByRole("link", { name: "模型分析" })
    .click();
  await expect(
    page.getByRole("heading", { name: "模型分析", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("button", { name: "查看 gpt-6-astra 详情" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.screenshot({
    path: "evidence/model-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "打开导航" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "工作区设置", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "连接你的用量" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("button", { name: "打开导航" }).click();
  await page.getByRole("dialog").getByRole("link", { name: "设备 3" }).click();
  await expect(page.getByRole("heading", { name: "设备", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).not.toBeVisible();
});


test("a previous refresh timer cannot release a newer in-flight refresh", async ({ page }) => {
  await page.route("**/api/**", route => route.fulfill({ status: 200, json: route.request().url().endsWith("/overview") ? contractOverview : {} }));
  await page.getByRole("button", { name: "连接我的数据" }).click();
  await page.getByLabel("访问密钥", { exact: true }).fill("local-refresh-fixture");
  await page.getByRole("button", { name: "连接并查看真实用量" }).click();
  await expect(page.getByText("当前展示真实数据")).toBeVisible();
  let refreshes = 0;
  await page.route("**/api/v1/tm/overview", async route => {
    refreshes++;
    if (refreshes === 2) await new Promise(resolve => setTimeout(resolve, 2800));
    await route.fulfill({ status: 200, json: contractOverview });
  });
  const button = page.locator(".refresh-button");
  await button.click();
  await expect(button).toContainText("已更新");
  await button.click();
  await page.waitForTimeout(1900);
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute("aria-busy", "true");
  await expect(button).toContainText("刷新中");
  await expect(button).toContainText("已更新");
});
