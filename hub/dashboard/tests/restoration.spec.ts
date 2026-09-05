import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const archive = (extra = {}) => ({
  day_basis: "device-local",
  dashboard_time_zone: "Asia/Tokyo",
  retention_days: 370,
  mixed_time_zones: true,
  device_time_zone: null,
  partial: false,
  partial_errors: [],
  items: [
    {
      day: "2026-09-05",
      tokens: 123456789,
      costUsd: -0.45,
      perClient: { 测试客户端: 123456789 },
      perModel: { 测试模型: 123456789 },
      deviceCount: 2,
      complete: true,
      coverage: null,
    },
  ],
  has_more: false,
  next_cursor: null,
  ...extra,
});
const update = (extra = {}) => ({
  current: { version: "v1.0.0", git_sha: "1234567" },
  latest_release: {
    tag: "v1.1.0",
    notes: "修复与改进。",
    html_url: "https://github.com/example/cloud-monitor/releases/tag/v1.1.0",
    published_at: "2026-09-05T00:00:00Z",
  },
  main: { sha: "abcdef123", short_sha: "abcdef1", message: "测试提交" },
  release_ahead: true,
  main_ahead: true,
  apply_enabled: true,
  checked_at: "2026-09-05T00:00:00Z",
  job: { state: "idle" },
  ...extra,
});

test("mobile archive pages preserve unknowns, negative fees, composition and loaded rows on failure", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 740 });
  let failOlder = true;
  await page.route("**/api/**", async (route) => {
    expect(route.request().method()).toBe("GET");
    if (route.request().url().includes("system/update"))
      return route.fulfill({ json: update() });
    if (route.request().url().includes("cursor=")) {
      if (failOlder)
        return route.fulfill({ status: 500, json: { error: "归档暂不可用" } });
      return route.fulfill({
        json: archive({
          items: [
            {
              day: "2026-09-04",
              tokens: 7,
              costUsd: null,
              complete: false,
              coverage: 20,
            },
          ],
          mixed_time_zones: false,
        }),
      });
    }
    return route.fulfill({
      json: archive({ has_more: true, next_cursor: "2026-09-05" }),
    });
  });
  await page.goto("/tests/restoration-harness.html");
  const panel = page.locator(".archive-panel");
  await expect(panel.getByText("2026-09-05", { exact: true })).toBeVisible();
  await expect(panel.getByText("$-0.45", { exact: true })).toBeVisible();
  await expect(panel.getByText(/包含多个设备时区/)).toBeVisible();
  await panel.locator("summary").first().click();
  await expect(panel.getByText(/覆盖率未提供/)).toBeVisible();
  await expect(panel.getByText("测试客户端", { exact: true })).toBeVisible();
  await expect(panel.getByText("测试模型", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "加载更多" }).click();
  await expect(panel.getByRole("alert")).toContainText("归档暂不可用");
  await expect(panel.getByText("2026-09-05", { exact: true })).toBeVisible();
  failOlder = false;
  await panel.getByRole("button", { name: "重试" }).click();
  await expect(panel.getByText("2026-09-04", { exact: true })).toBeVisible();
  await expect(panel.getByText("已显示 2 天", { exact: true })).toBeVisible();
  await expect(panel.getByText("归档不完整", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "加载更多" })).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
  const accessibilityIssues = () =>
    page.evaluate(async () => {
      const result = await (
        window as unknown as {
          axe: {
            run: (
              element: Document,
              options: unknown,
            ) => Promise<{
              violations: {
                id: string;
                nodes: { html: string; failureSummary: string }[];
              }[];
            }>;
          };
        }
      ).axe.run(document, { runOnly: ["wcag2a", "wcag2aa"] });
      return result.violations.map(({ id, nodes }) => ({
        id,
        nodes: nodes.map(({ html, failureSummary }) => ({
          html,
          failureSummary,
        })),
      }));
    });
  expect(await accessibilityIssues()).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("restoration-mobile-light.png"),
    fullPage: true,
  });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  expect(await accessibilityIssues()).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("restoration-mobile-dark.png"),
    fullPage: true,
  });
});

test("missing archive is an explicit overview fallback and demo makes no API requests", async ({
  page,
}) => {
  let requests = 0;
  await page.route("**/api/**", async (route) => {
    requests++;
    return route.fulfill(
      route.request().url().includes("system/update")
        ? { json: update() }
        : { status: 404, json: { error: "missing" } },
    );
  });
  await page.goto("/tests/restoration-harness.html");
  await expect(page.getByText(/归档接口暂不可用/)).toBeVisible();
  await expect(
    page.locator(".archive-panel").getByText("已显示 1 天", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".archive-panel").getByText("完整性未提供", { exact: true }),
  ).toBeVisible();
  await page.goto("/tests/restoration-harness.html?demo");
  const before = requests;
  await expect(page.getByText(/演示模式不读取服务器版本/)).toBeVisible();
  await expect(page.getByRole("button", { name: "检查更新" })).toBeDisabled();
  await expect(page.getByText(/演示数据 · 展示概览/)).toBeVisible();
  await page.waitForTimeout(250);
  expect(requests).toBe(before);
});

test("update action is explicit and queued status waits for the host without another submission", async ({
  page,
}) => {
  let posts = 0;
  let job = { state: "idle", ref: "", id: "", message: "" };
  await page.route("**/api/**", async (route) => {
    if (!route.request().url().includes("system/update"))
      return route.fulfill({ json: archive() });
    if (route.request().method() === "POST") {
      posts++;
      expect(route.request().postDataJSON()).toEqual({ ref: "v1.1.0" });
      job = {
        state: "queued",
        ref: "v1.1.0",
        id: "fixture-1",
        message: "已提交，等待宿主机监视器",
      };
      return route.fulfill({ json: job });
    }
    return route.fulfill({ json: update({ job }) });
  });
  await page.goto("/tests/restoration-harness.html");
  await expect(
    page.getByRole("button", { name: "升级至 v1.1.0" }),
  ).toBeVisible();
  expect(posts).toBe(0);
  await page.getByRole("button", { name: "升级至 v1.1.0" }).click();
  await expect(page.getByText("等待宿主机处理", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "升级至 v1.1.0" })).toHaveCount(
    0,
  );
  expect(posts).toBe(1);
  job = { ...job, state: "ok", message: "更新完成" };
  await page.getByRole("button", { name: "检查更新" }).click();
  await expect(page.getByText("更新已完成", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "刷新页面" })).toBeVisible();
  expect(posts).toBe(1);
});

test("an uncertain submission removes upgrade actions until a status check succeeds", async ({
  page,
}) => {
  let uncertain = false;
  let posts = 0;
  await page.route("**/api/**", async (route) => {
    if (!route.request().url().includes("system/update"))
      return route.fulfill({ json: archive() });
    if (route.request().method() === "POST") {
      posts++;
      uncertain = true;
      return route.abort("failed");
    }
    if (uncertain) return route.abort("failed");
    return route.fulfill({ json: update() });
  });
  await page.goto("/tests/restoration-harness.html");
  await page.getByRole("button", { name: "升级至 v1.1.0" }).click();
  await expect(page.locator(".system-update-job")).toContainText(
    "提交结果尚未确认",
  );
  await expect(page.getByRole("button", { name: "升级至 v1.1.0" })).toHaveCount(
    0,
  );
  expect(posts).toBe(1);
  uncertain = false;
  await page.getByRole("button", { name: "检查更新" }).click();
  await expect(
    page.getByRole("button", { name: "升级至 v1.1.0" }),
  ).toBeVisible();
  expect(posts).toBe(1);
});

test("archive authentication failure calls the owner instead of showing fallback data", async ({
  page,
}) => {
  await page.route("**/api/**", (route) =>
    route.fulfill(
      route.request().url().includes("system/update")
        ? { json: update() }
        : { status: 401, json: { error: "invalid" } },
    ),
  );
  await page.goto("/tests/restoration-harness.html");
  await expect(page.getByText("鉴权回调已执行", { exact: true })).toBeVisible();
  await expect(page.locator(".archive-panel").getByRole("alert")).toContainText(
    "访问密钥已失效",
  );
  await expect(page.getByText(/归档接口暂不可用/)).toHaveCount(0);
});
