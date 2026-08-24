// §13-1：真实 FastAPI 静态路由 + 登录门 e2e（无任何路由拦截，全部打真实后端）
// 后端基线 cm-current：e2e 夹具未配置 TOKEN_MONITOR_SECRET（Token Monitor 未启用），
// /api/v1/tm/provider-status 与 /api/v1/tm/history/daily 按契约返回 404。
const { test, expect } = require("@playwright/test");
const { watchConsole, loginWithToken, sampleOverview, stubOverview } = require("./helpers");

const ORIGIN = `http://127.0.0.1:${process.env.CM_E2E_PORT || 18787}`;
const TOKEN = process.env.CM_E2E_TOKEN || "test-token";

test.describe("真实 FastAPI 后端（零拦截）", () => {
  test("GET / 与 /static 核心资源全部 200", async ({ request }) => {
    for (const path of ["/", "/static/tm.css", "/static/tm.js", "/static/icons.svg"]) {
      const res = await request.get(path);
      expect(res.status(), `GET ${path}`).toBe(200);
    }
  });

  test("GET /demo 在测试夹具中可打开演示页", async ({ request, page }) => {
    const res = await request.get("/demo");
    expect(res.status()).toBe(200);
    await page.goto("/demo");
    await expect(page.locator("#shell")).toBeVisible();
    await expect(page.locator("#demo-badge")).toBeVisible();
    await expect(page.locator("#gate-demo")).toHaveCount(0);
  });

  test("GET / 带后端 CSP 安全头", async ({ request }) => {
    const res = await request.get("/");
    const csp = res.headers()["content-security-policy"] || "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
  });

  test("Chromium 打开 / 可见登录门，控制台无 404、无外部资源请求", async ({ page }) => {
    const watch = watchConsole(page, ORIGIN);
    await page.goto("/");
    // 登录门可见
    await expect(page.locator("#gate")).toBeVisible();
    await expect(page.locator("#gate-token")).toBeVisible();
    await expect(page.locator("#gate-form button[type=submit]")).toBeVisible();
    await expect(page.locator("#gate-demo")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("查看演示数据");
    // 无 404 响应
    expect(watch.notFound, "控制台/网络 404").toEqual([]);
    // CSP 下无外部资源请求（fonts.googleapis / fonts.gstatic 等）
    expect(watch.external, "外部资源请求").toEqual([]);
    // 无页面级 JS 错误
    expect(watch.errors.filter((e) => e.startsWith("pageerror")), "JS 异常").toEqual([]);
  });

  test("错误密钥 → 显示错误提示，且不写入 sessionStorage", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#gate")).toBeVisible();
    await page.fill("#gate-token", "definitely-wrong-token");
    await page.click("#gate-form button[type=submit]");
    // 真实后端返回 401 → 错误提示可见
    await expect(page.locator("#gate-error")).toBeVisible();
    await expect(page.locator("#gate-error")).toContainText("密钥不正确");
    // 仍停留在登录门
    await expect(page.locator("#gate")).toBeVisible();
    await expect(page.locator("#shell")).toBeHidden();
    // 失效 Token 不残留在 sessionStorage
    const stored = await page.evaluate(() => sessionStorage.getItem("cm_access_token"));
    expect(stored).toBeNull();
  });

  test("真实后端鉴权：错误/正确密钥的 API 行为符合契约", async ({ request }) => {
    const bad = await request.get("/api/v1/tm/overview", {
      headers: { Authorization: "Bearer definitely-wrong-token" },
    });
    expect(bad.status()).toBe(401);
    // 正确密钥：夹具未配置 TOKEN_MONITOR_SECRET，后端按契约返回业务错误而非 401
    const good = await request.get("/api/v1/tm/overview", {
      headers: { Authorization: `Bearer ${process.env.CM_E2E_TOKEN || "test-token"}` },
    });
    expect(good.status()).not.toBe(401);
  });

  test("Cloud 扩展真实端点：未启用 Token Monitor → provider-status / history-daily 契约 404（零拦截）", async ({ request }) => {
    const auth = { headers: { Authorization: `Bearer ${TOKEN}` } };
    // 真实后端（未配置 TOKEN_MONITOR_SECRET）：两条 Cloud 扩展均按契约 404
    const pv = await request.get("/api/v1/tm/provider-status", auth);
    expect(pv.status(), "provider-status 未启用 → 404").toBe(404);
    const hd = await request.get("/api/v1/tm/history/daily?limit=30", auth);
    expect(hd.status(), "history/daily 未启用 → 404").toBe(404);
    // 错误密钥仍走鉴权前置（401 而非 404）
    const bad = await request.get("/api/v1/tm/provider-status", {
      headers: { Authorization: "Bearer definitely-wrong-token" },
    });
    expect(bad.status()).toBe(401);
  });

  test("前端优雅降级：仅 [拦截] overview，Cloud 扩展打真实后端 404", async ({ page, context, browser }) => {
    const { payload } = await sampleOverview(browser, ORIGIN);
    await loginWithToken(context);
    await stubOverview(page, payload); // 唯一拦截点；aux 接口落真实后端
    const auxRequests = [];
    page.on("request", (req) => {
      if (/\/api\/v1\/tm\/(provider-status|history\/daily)/.test(req.url())) auxRequests.push(req.url());
    });
    await page.goto("/");
    await expect(page.locator("#updated")).toContainText("更新于");
    // provider-status 真实 404 → unsupported → 整块隐藏（不伪装成空列表、不报错误态）
    await expect.poll(() => auxRequests.some((u) => u.includes("provider-status"))).toBe(true);
    await expect(page.locator("#provider-panel")).toBeHidden();
    // history/daily 真实 404 → 日归档回退概览内嵌数据并显式标注（点击导航，非 hash 跳转）
    await page.click('[data-view="history"].nav-item');
    await expect(page.locator("#hist-sub")).toContainText("服务端分页接口不可用");
    await expect.poll(() => auxRequests.some((u) => u.includes("history/daily"))).toBe(true);
    // 回退行来自 overview 内嵌 trend/activity（非空）
    await expect(page.locator("#hist-body tr").first()).toBeVisible();
  });
});
