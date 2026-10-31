import { test, expect, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";

const require = createRequire(import.meta.url);
const fixture = require("./fixtures/overview.json");
const model = "gpt-5.2";
const startedAt = "2026-10-18T01:02:03Z", lastUsedAt = "2026-10-18T01:22:33Z";

function detailedOverview() {
  const overview = structuredClone(fixture);
  overview.generated_at = "2026-10-18T01:23:00Z";
  const today = {
    key: "dev-fixture:codex:observed-session", sessionId: "observed-session", client: "codex",
    title: "已同意同步的会话标题 · " + "LongUnbrokenSessionTitle".repeat(8),
    tokens: 10000, costUsd: 1.2, models: { [model]: 8000, "opus-4.5": 2000 },
    modelCosts: { [model]: 0.9, "opus-4.5": 0.3 }, inputTokens: 1000, outputTokens: 2000,
    cacheReadTokens: 6000, cacheWriteTokens: 1000, reasoningTokens: 500, messageCount: 4,
    startedAt, lastUsedAt, deviceId: "dev-fixture", device: "测试设备", project: "多模型会话",
    contextTokens: 104000, contextWindow: 100000, timedOutputTokens: 1800, timedDurationMs: 30000,
    deviceStale: false, turnEnded: true, zeroValuesUnconfirmed: true,
    nativeSessionId: "11111111-2222-3333-4444-555555555555", t3ThreadId: "t3-linked-thread",
    projectId: "project-with-a-long-identifier-to-check-small-screen-wrapping", providers: { openai: 8000, anthropic: 2000 },
  };
  const month = { ...today, tokens: 40000, inputTokens: 4000, outputTokens: 8000, cacheReadTokens: 24000, cacheWriteTokens: 4000, reasoningTokens: 2000, messageCount: 16, models: { [model]: 32000, "opus-4.5": 8000 }, project: "本月多模型会话" };
  overview.sessions = [today];
  overview.sessions_by_period = { today: [today], month: [month], allTime: [] };
  const meta = { sessions_total: 1, sessions_returned: 1, sessions_omitted_count: 0, session_details_incomplete: false, availability: "available" };
  overview.sessions_meta_by_period = { today: { ...meta, period: "today" }, month: { ...meta, period: "month" }, allTime: { ...meta, period: "allTime", sessions_total: 0, sessions_returned: 0, availability: "unavailable", reason: "not-synced" } };
  overview.totals.today.modelThroughput = { [model]: { timedTokens: 9000, timedOutputTokens: 1800, timedDurationMs: 30000 } };
  return overview;
}

async function connect(page: Page, overview = detailedOverview()) {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.route("**/api/v1/tm/**", route => route.fulfill({ json: route.request().url().endsWith("/overview") ? overview : {} }));
  await page.goto("/");
  await page.getByRole("button", { name: "连接我的数据", exact: true }).click();
  await page.getByLabel("访问密钥", { exact: true }).fill("details-fixture-only");
  await page.getByRole("button", { name: "连接并查看真实用量", exact: true }).click();
  await expect(page.getByText("当前展示真实数据")).toBeAttached();
  await page.locator(".app-toast").getByRole("button", { name: "关闭提示" }).click();
}

for (const width of [320, 390, 1440]) {
  test(`model detail renders reported session facts without inventing individual calls at ${width}px`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await connect(page);
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await page.getByRole("button", { name: `查看 ${model} 详情`, exact: true }).click();
    const dialog = page.locator(".model-dialog");
    await expect(dialog.getByRole("heading", { name: model, exact: true })).toBeVisible();
    await expect(dialog.locator(".model-speed-detail")).toContainText("60.0");
    await dialog.locator(".session-usage-card > summary").click();
    const session = dialog.locator(".session-usage-card");
    const acceptedTitle = Array.from(detailedOverview().sessions_by_period.today[0].title).slice(0, 160).join("");
    await expect(session.locator(".session-card-title")).toContainText("多模型会话");
    await expect(session.locator(".session-card-title")).not.toContainText("已同意同步的会话标题");
    await expect(session.getByText(acceptedTitle, { exact: true })).toBeHidden();
    await expect(session.locator(".session-card-amount")).toContainText("8,000");
    await expect(session.locator(".session-scope-note")).toContainText("整个会话");
    const cells = session.locator(".session-token-grid");
    await expect(cells).toContainText("1,000");
    await expect(cells).toContainText("2,000");
    await expect(cells).toContainText("6,000");
    await expect(cells).toContainText("500");
    await expect(session.locator(".session-context-block")).toContainText("104.0%");
    await expect(session.getByRole("progressbar")).toHaveAttribute("value", "100");
    await expect(session.locator(".session-facts").first()).toContainText("10/18 10:22:33");
    await expect(session.locator(".session-facts").first()).toContainText("4 条");
    await expect(dialog.locator(".local-detail-note")).toContainText("逐次回复、提问正文和工具事件");
    await expect(dialog.locator(".local-detail-note")).toContainText("尚未同步");
    const origin = session.locator(".session-origin-disclosure");
    await origin.locator("summary").click();
    const title = origin.locator("dt").filter({ hasText: /^会话标题$/ }).locator("..").locator("dd");
    await expect(title).toHaveText(acceptedTitle);
    await expect(title).toBeVisible();
    expect(await title.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBeTruthy();
    await expect(origin).toContainText("11111111-2222-3333-4444-555555555555");
    await expect(origin).toContainText("t3-linked-thread");
    await expect(origin).toContainText("project-with-a-long-identifier-to-check-small-screen-wrapping");
    await expect(origin).toContainText("提供商 · OpenAI");
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBeTruthy();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await origin.locator("summary").click();
    await expect(title).toBeHidden();
    await session.locator(".session-token-breakdown").scrollIntoViewIfNeeded();
    const close = dialog.getByRole("button", { name: "关闭", exact: true });
    const closeBox = await close.boundingBox();
    expect(closeBox!.y).toBeGreaterThanOrEqual(0);
    expect(closeBox!.y + closeBox!.height).toBeLessThanOrEqual(width === 1440 ? 1000 : 844);
    mkdirSync("evidence", { recursive: true });
    const screenshot = await page.screenshot({ path: `evidence/usage-details-${width}.png`, animations: "disabled" });
    await testInfo.attach(`usage-details-${width}`, { body: screenshot, contentType: "image/png" });
    await close.click();
    await expect(dialog).toBeHidden();
    expect(errors).toEqual([]);
  });
}

test("accepted session titles stay out of history names, search and CSV until source details are expanded", async ({ page }) => {
  await connect(page);
  await page.getByRole("link", { name: "历史记录", exact: true }).first().click();
  const table = page.locator(".sv-session-table");
  const toggle = table.locator(".sv-session-toggle");
  await expect(toggle).toContainText("多模型会话");
  await expect(toggle).not.toContainText("已同意同步的会话标题");
  const search = page.getByLabel("搜索会话", { exact: true });
  await search.fill("已同意同步的会话标题");
  await expect(page.locator(".sv-session-toggle")).toHaveCount(0);
  await expect(page.getByText("没有匹配的会话", { exact: true })).toBeVisible();
  await search.fill("");
  await expect(toggle).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出会话", exact: true }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  expect(stream).not.toBeNull();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const csv = Buffer.concat(chunks).toString("utf8");
  expect(csv).toContain("多模型会话");
  expect(csv).not.toContain("已同意同步的会话标题");
  await toggle.click();
  const origin = table.locator(".session-origin-disclosure");
  const title = origin.locator("dt").filter({ hasText: /^会话标题$/ }).locator("..").locator("dd");
  await expect(title).toBeHidden();
  await origin.locator("summary").click();
  await expect(title).toBeVisible();
  await expect(title).toHaveText(Array.from(detailedOverview().sessions_by_period.today[0].title).slice(0, 160).join(""));
});

test("today, month and all-time retain their own scope in model details", async ({ page }) => {
  await connect(page);
  await page.getByRole("tab", { name: "本月", exact: true }).click();
  await page.getByRole("button", { name: `查看 ${model} 详情`, exact: true }).click();
  let dialog = page.locator(".model-dialog");
  await dialog.locator(".session-usage-card > summary").click();
  await expect(dialog.locator(".session-token-grid")).toContainText("24,000");
  await expect(dialog.locator(".session-token-grid")).not.toContainText("6,000");
  await expect(dialog.locator(".session-card-title")).toContainText("本月多模型会话");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("tab", { name: "累计", exact: true }).click();
  await page.getByRole("button", { name: `查看 ${model} 详情`, exact: true }).click();
  dialog = page.locator(".model-dialog");
  await expect(dialog.locator(".session-usage-card")).toHaveCount(0);
  await expect(dialog.locator(".session-detail-empty")).toContainText("未同步全部历史会话");
});

test("unconfirmed upstream zeroes remain unknown in the rendered session", async ({ page }) => {
  const overview = detailedOverview();
  const session = overview.sessions_by_period.today[0];
  Object.assign(session, { tokens: 10, inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, messageCount: 0, costUsd: 0, modelCosts: { [model]: 0 }, models: { [model]: 10 }, contextTokens: 0, timedOutputTokens: 0, timedDurationMs: 0 });
  await connect(page, overview);
  await page.getByRole("button", { name: `查看 ${model} 详情`, exact: true }).click();
  const dialog = page.locator(".model-dialog");
  await dialog.locator(".session-usage-card > summary").click();
  await expect(dialog.locator(".session-token-grid")).toContainText("10");
  await expect(dialog.locator(".session-token-grid .value-unavailable")).toHaveCount(5);
  await expect(dialog.locator(".session-card-body")).toContainText("部分零值无法确认");
  // Chinese sentences run on without a space after 。 (toContainText would fold it away).
  expect(await dialog.locator(".session-token-breakdown .detail-footnote").textContent()).toBe("推理用量已包含在输出中。部分零值无法确认，显示为未提供。");
  await expect(dialog.locator(".session-card-body")).not.toContainText("$0.00");
  await expect(dialog.locator(".session-context-block")).toHaveCount(0);
});

test("model session activity and cache expire while the same snapshot remains open", async ({ page }) => {
  const now = new Date();
  await page.clock.install({ time: now });
  const overview = detailedOverview();
  overview.generated_at = now.toISOString();
  Object.assign(overview.sessions_by_period.today[0], {
    // Only Claude's prompt cache counts down since v0.83.
    client: "claude",
    lastUsedAt: new Date(now.getTime() - 20 * 60_000).toISOString(),
    liveActivity: { state: "running", observedAt: now.toISOString() },
    promptCache: { observedAt: now.toISOString(), ttlSeconds: 300 },
  });
  await connect(page, overview);
  await page.getByRole("button", { name: `查看 ${model} 详情`, exact: true }).click();
  const dialog = page.locator(".model-dialog");
  await dialog.locator(".session-usage-card > summary").click();
  await expect(dialog.locator(".session-current-line")).toContainText("运行中");
  await expect(dialog.locator(".session-facts").first()).toContainText("约剩 5 分钟");
  await page.clock.fastForward(61_000);
  await expect(dialog.locator(".session-current-line")).toContainText("闲置");
  await page.clock.fastForward(5 * 60_000);
  await expect(dialog.locator(".session-facts").first()).not.toContainText("约剩");
});
