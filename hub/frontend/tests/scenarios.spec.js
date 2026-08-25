// §13-2：场景测试。登录门/竞态/分页等打真实 FastAPI 后端；
// 标注 [拦截] 的用例用 page.route 定制 overview 等载荷（契约取自 mock.js），
// 未拦截的辅助接口（provider-status / subscriptions / history/daily）仍落真实后端。
const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");
const {
  deferred, loginWithToken, sampleOverview, stubOverview, todayKeyInTz,
} = require("./helpers");

/* 后端官方前端契约夹具（金标准，只读） */
/* 契约夹具随仓库分发（hub/tests/fixtures/frontend-contract）：
   回退路径按本文件位置解析，不再硬编码原开发机的绝对路径 */
const CONTRACT_FIXTURES = process.env.CM_CONTRACT_FIXTURES ||
  path.join(__dirname, "..", "..", "tests", "fixtures", "frontend-contract");
const readFixture = (name) => JSON.parse(fs.readFileSync(path.join(CONTRACT_FIXTURES, name), "utf8"));

const ORIGIN = `http://127.0.0.1:${process.env.CM_E2E_PORT || 18787}`;
const clone = (o) => JSON.parse(JSON.stringify(o));
const tagPayload = (payload, tag) => {
  const p = clone(payload);
  p.devices[0].hostname = tag;
  return p;
};
const fulfillJson = (route, body) => {
  const txt = typeof body === "string" ? body : JSON.stringify(body);
  return route.fulfill({ status: 200, contentType: "application/json", body: txt }).catch(() => {});
};

let base; // 契约载荷缓存
test.beforeAll(async ({ browser }) => {
  base = await sampleOverview(browser, ORIGIN);
});

test.describe("§3 慢请求竞态 / 退出 / 换密钥（真实后端 + [拦截] overview）", () => {
  test("慢请求竞态：先发的慢响应晚到被丢弃，不覆盖后发响应", async ({ page, context }) => {
    const slow = deferred();
    let n = 0;
    await page.route("**/api/v1/tm/overview*", async (route) => {
      n++;
      const mine = n;
      if (mine === 1) await slow.promise; // 第一份请求挂起（慢）
      await fulfillJson(route, tagPayload(base.payload, mine === 1 ? "SLOW-OLD-RESP" : "FAST-NEW-RESP"));
    });
    await page.goto("/"); // 无 token → 登录门
    await expect(page.locator("#gate")).toBeVisible();
    // 第一次提交 → 慢请求 n=1
    await page.fill("#gate-token", "test-token");
    await page.click("#gate-form button[type=submit]");
    await page.waitForTimeout(150);
    // 第二次提交 → n=2（新请求中止旧请求）
    await page.fill("#gate-token", "test-token");
    await page.click("#gate-form button[type=submit]");
    await expect(page.locator("#updated")).toContainText("更新于");
    await page.click('[data-view="devices"].nav-item');
    await expect(page.locator("#dev-grid")).toContainText("FAST-NEW-RESP");
    // 慢响应此刻才返回
    slow.resolve();
    await page.waitForTimeout(400);
    await expect(page.locator("#dev-grid")).toContainText("FAST-NEW-RESP");
    await expect(page.locator("#dev-grid")).not.toContainText("SLOW-OLD-RESP");
  });

  test("退出竞态：加载中退出，在途请求被中止，晚到响应不改变门状态", async ({ page, context }) => {
    await loginWithToken(context);
    const slow = deferred();
    let n = 0;
    await page.route("**/api/v1/tm/overview*", async (route) => {
      n++;
      if (n === 2) await slow.promise;
      await fulfillJson(route, tagPayload(base.payload, n === 2 ? "AFTER-LOGOUT-RESP" : "BOOT-RESP"));
    });
    await page.goto("/");
    await expect(page.locator("#updated")).toContainText("更新于");
    await page.click('[data-view="devices"].nav-item');
    await expect(page.locator("#dev-grid")).toContainText("BOOT-RESP");
    await page.click("#refresh"); // n=2 进入加载中
    await page.waitForTimeout(150);
    await page.click("#logout"); // 加载中退出
    await expect(page.locator("#gate")).toBeVisible();
    await expect(page.locator("#shell")).toBeHidden();
    slow.resolve(); // 晚到响应
    await page.waitForTimeout(400);
    await expect(page.locator("#gate")).toBeVisible();
    await expect(page.locator("#shell")).toBeHidden();
    expect(await page.evaluate(() => sessionStorage.getItem("cm_access_token"))).toBeNull();
  });

  test("加载中换密钥：旧密钥的晚到响应不覆盖新密钥状态", async ({ page, context }) => {
    await loginWithToken(context);
    const slow = deferred();
    let n = 0;
    await page.route("**/api/v1/tm/overview*", async (route) => {
      n++;
      if (n === 2) await slow.promise;
      await fulfillJson(route, tagPayload(base.payload, n === 2 ? "OLD-KEY-RESP" : n === 3 ? "NEW-KEY-RESP" : "BOOT"));
    });
    await page.goto("/");
    await expect(page.locator("#updated")).toContainText("更新于");
    await page.click('[data-view="devices"].nav-item');
    await expect(page.locator("#dev-grid")).toContainText("BOOT");
    await page.click("#refresh"); // n=2 慢
    await page.waitForTimeout(150);
    await page.click("#logout"); // 退出到门
    await page.fill("#gate-token", "test-token");
    await page.click("#gate-form button[type=submit]"); // n=3 新密钥会话
    await expect(page.locator("#updated")).toContainText("更新于");
    await page.click('[data-view="devices"].nav-item');
    await expect(page.locator("#dev-grid")).toContainText("NEW-KEY-RESP");
    slow.resolve(); // 旧密钥响应晚到
    await page.waitForTimeout(400);
    await expect(page.locator("#dev-grid")).toContainText("NEW-KEY-RESP");
    await expect(page.locator("#dev-grid")).not.toContainText("OLD-KEY-RESP");
  });
});

test.describe("§9 Provider Status 失败/超时（真实后端 + [拦截] provider-status）", () => {
  test("provider-status 网络超时（abort）→ 显示「状态页暂不可用」，不误判为空列表", async ({ page, context }) => {
    await loginWithToken(context);
    await stubOverview(page, base.payload);
    await page.route("**/api/v1/tm/provider-status*", (route) => route.abort("timedout"));
    await page.goto("/");
    await expect(page.locator("#provider-panel")).toBeVisible();
    await expect(page.locator("#provider-grid")).toContainText("状态页暂不可用");
  });

  test("provider-status 延迟 2s 后 500 → 仍显示「状态页暂不可用」", async ({ page, context }) => {
    await loginWithToken(context);
    await stubOverview(page, base.payload);
    await page.route("**/api/v1/tm/provider-status*", async (route) => {
      await new Promise((r) => setTimeout(r, 2000));
      await route.fulfill({ status: 500, contentType: "application/json", body: '{"detail":"boom"}' });
    });
    await page.goto("/");
    await expect(page.locator("#provider-grid")).toContainText("状态页暂不可用", { timeout: 10000 });
  });

  test("status=unknown + error_code=timeout → 该卡「状态页暂不可用」语义；partial=true → 面板级提示", async ({ page, context }) => {
    await loginWithToken(context);
    await stubOverview(page, base.payload);
    const now = new Date().toISOString();
    await page.route("**/api/v1/tm/provider-status*", async (route) => {
      await fulfillJson(route, {
        schema_version: 1,
        generated_at: now,
        providers: [
          { provider: "anthropic", observed_as: ["claude"], name: "Anthropic", status: "operational", description: "ok", checked_at: now, source_updated_at: now, stale: false, error_code: null, url: "https://status.claude.com" },
          { provider: "cursor", observed_as: ["cursor"], name: "Cursor", status: "unknown", description: "", checked_at: now, source_updated_at: null, stale: false, error_code: "timeout", url: "https://status.cursor.com" },
        ],
        partial: true,
        errors: [{ error_code: "timeout", source: "cursor" }],
      });
    });
    await page.goto("/");
    // 面板级 partial 提示
    await expect(page.locator("#provider-grid")).toContainText("部分提供商状态来源暂不可用");
    // 正常卡仍正常
    const okCard = page.locator(".pv-card", { hasText: "Anthropic" });
    await expect(okCard).toContainText("正常");
    // unknown+error_code 卡：「状态页暂不可用」语义（非灰点「状态未知」空态）
    const downCard = page.locator(".pv-card", { hasText: "Cursor" });
    await expect(downCard).toContainText("状态页暂不可用");
    await expect(downCard).toContainText("状态页请求超时");
    await expect(downCard).not.toContainText("状态未知");
  });

  test("provider-status 404（Token Monitor 未启用）→ 整块隐藏；features.provider_status=false → 不发请求", async ({ page, context }) => {
    await loginWithToken(context);
    await stubOverview(page, base.payload);
    await page.route("**/api/v1/tm/provider-status*", (route) =>
      route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"未启用 token-monitor 接入"}' })
    );
    await page.goto("/");
    await expect(page.locator("#updated")).toContainText("更新于");
    await expect(page.locator("#provider-panel")).toBeHidden();

    // features 门控：不发请求、整块隐藏
    const p = clone(base.payload);
    p.features = { ...(p.features || {}), provider_status: false };
    const page2 = await context.newPage();
    let pvCalls = 0;
    await page2.route("**/api/v1/tm/provider-status*", async (route) => { pvCalls++; await route.abort(); });
    await page2.route("**/api/v1/tm/overview*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(p) })
    );
    await page2.goto("/");
    await expect(page2.locator("#updated")).toContainText("更新于");
    await expect(page2.locator("#provider-panel")).toBeHidden();
    await page2.waitForTimeout(400);
    expect(pvCalls, "features.provider_status=false 不得请求 provider-status").toBe(0);
    await page2.close();
  });
});

test.describe("§9 History 分页（真实后端 + [拦截] history/daily）", () => {
  function dayStr(offset) {
    const d = new Date(Date.now() - offset * 86400000);
    return d.toISOString().slice(0, 10);
  }
  // 75 天数据，第二页故意混入一个与第一页重复的日期（游标去重验证）
  // 响应形状 = 新契约：{items, next_cursor, has_more, day_basis, retention_days, …}
  function historyHandler(state) {
    return async (route) => {
      const url = new URL(route.request().url());
      const cursor = url.searchParams.get("cursor");
      state.count++;
      const all = [];
      for (let i = 0; i < 75; i++) {
        all.push({
          day: dayStr(i), tokens: 1000000 + i * 1000, costUsd: 1.5,
          perClient: { claude: 600000, codex: 400000 }, perModel: { "claude-opus-4.1": 1000000 },
          deviceCount: 1, complete: true, coverage: null,
        });
      }
      let start = 0;
      if (cursor) {
        const idx = all.findIndex((r) => r.day < cursor);
        start = idx < 0 ? all.length : idx;
      }
      let pageItems = all.slice(start, start + 30);
      if (state.count === 2 && pageItems.length > 1) pageItems = [all[29]].concat(all.slice(start, start + 29)); // 重复游标日 + 29 新行
      if (state.count === 2) await new Promise((r) => setTimeout(r, 600)); // 慢第二页（防重复请求窗口）
      const more = start + 30 < all.length;
      await fulfillJson(route, {
        schema_version: 1,
        day_basis: "device-local",
        dashboard_time_zone: "Asia/Tokyo",
        retention_days: 370,
        mixed_time_zones: false,
        device_time_zone: null,
        items: pageItems,
        next_cursor: more ? pageItems[pageItems.length - 1].day : null,
        has_more: more,
        partial: false,
        partial_errors: [],
      });
    };
  }

  test("IntersectionObserver 滚动加载下一页、游标去重、加载中不重复发请求", async ({ page, context }) => {
    await loginWithToken(context);
    await stubOverview(page, base.payload);
    const state = { count: 0 };
    await page.route("**/api/v1/tm/history/daily*", historyHandler(state));
    await page.goto("/#history");
    // 第一页 30 行
    await expect(page.locator("#hist-body tr")).toHaveCount(30);
    expect(state.count).toBe(1);
    // 滚动触发哨兵：慢第二页期间反复滚动，不应重复发请求
    await page.evaluate(() => document.querySelector("#hist-sentinel").scrollIntoView());
    await page.waitForTimeout(150);
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => {
        window.scrollBy(0, -300);
        document.querySelector("#hist-sentinel").scrollIntoView();
      });
      await page.waitForTimeout(60);
    }
    await expect(page.locator("#hist-body tr")).toHaveCount(59, { timeout: 8000 }); // 30+30-1 去重
    expect(state.count, "慢页期间不得重复请求").toBe(2);
    // 第三页：先滚离哨兵再滚回（IO 仅在相交状态变化时回调）
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    await page.evaluate(() => document.querySelector("#hist-sentinel").scrollIntoView());
    await expect(page.locator("#hist-body tr")).toHaveCount(75, { timeout: 8000 });
    expect(state.count).toBe(3);
    // 全部日期唯一
    const days = await page.locator("#hist-body tr td .mono").allTextContents();
    expect(new Set(days.map((s) => s.trim())).size).toBe(75);
    // 契约 day_basis=device-local → 口径提示；has_more=false → 不再显示「加载更早记录」
    await expect(page.locator("#hist-sub")).toContainText("日口径：设备本地日");
    await expect(page.locator("#hist-sub")).toContainText("保留 370 天");
    await expect(page.locator("#hist-more")).toHaveText("");
  });

  test("mixed_time_zones=true + item.complete=false → 口径提示与该日「数据不完整」标记", async ({ page, context }) => {
    await loginWithToken(context);
    await stubOverview(page, base.payload);
    await page.route("**/api/v1/tm/history/daily*", async (route) => {
      const items = [0, 1, 2].map((i) => ({
        day: dayStr(i), tokens: 1000000 - i * 1000, costUsd: 1.2,
        perClient: { claude: 600000, codex: 400000 }, perModel: {},
        deviceCount: 2, complete: i !== 1, coverage: i === 1 ? 41.7 : null,
      }));
      await fulfillJson(route, {
        schema_version: 1,
        day_basis: "device-local",
        dashboard_time_zone: "Asia/Tokyo",
        retention_days: 370,
        mixed_time_zones: true, // 多设备时区不一致
        device_time_zone: null,
        items,
        next_cursor: null,
        has_more: false,
        partial: true,
        partial_errors: [{ code: "clients_json_corrupt", day: items[1].day, device_id: "dev-b" }],
      });
    });
    await page.goto("/#history");
    await expect(page.locator("#hist-body tr")).toHaveCount(3);
    await expect(page.locator("#hist-sub")).toContainText("设备时区不一致");
    await expect(page.locator("#hist-sub")).toContainText("部分日期数据不完整");
    await expect(page.locator("#hist-body .hist-inc")).toHaveCount(1);
    await expect(page.locator("#hist-body .hist-inc")).toContainText("数据不完整");
  });

  test("features.history_daily=false → 不发 history/daily 请求，走概览内嵌降级", async ({ page, context }) => {
    await loginWithToken(context);
    const p = clone(base.payload);
    p.features = { ...(p.features || {}), history_daily: false };
    await stubOverview(page, p);
    let histCalls = 0;
    await page.route("**/api/v1/tm/history/daily*", async (route) => {
      histCalls++;
      await fulfillJson(route, { items: [], has_more: false });
    });
    await page.goto("/#history");
    await expect(page.locator("#hist-sub")).toContainText("服务端分页接口不可用");
    await page.waitForTimeout(400);
    expect(histCalls, "features.history_daily=false 不得请求 history/daily").toBe(0);
  });
});

test.describe("§6 多时区热力图（真实后端 + [拦截] overview）", () => {
  async function sparkTodayFor(browser, tz) {
    const ctx = await browser.newContext({ baseURL: ORIGIN });
    await loginWithToken(ctx);
    const p = clone(base.payload);
    p.dashboard_time_zone = tz;
    p.activity.time_zone = tz;
    p.dashboard_period = {}; // 强制前端按 dashboard_time_zone 换算日期键
    const page = await ctx.newPage();
    await stubOverview(page, p);
    await page.goto("/#history");
    await page.waitForSelector("#hm .hm-spark-bars i");
    const days = await page.$$eval("#hm .hm-spark-bars i", (els) => els.map((e) => e.dataset.day));
    const covText = await page.locator("#hm-coverage").textContent().catch(() => "");
    await ctx.close();
    return { days, covText };
  }

  test("不同 dashboard_time_zone → 热力图日期键随之变化", async ({ browser }) => {
    const east = await sparkTodayFor(browser, "Pacific/Kiritimati"); // UTC+14
    const west = await sparkTodayFor(browser, "Etc/GMT+12"); // UTC-12
    expect(east.days.length).toBe(7);
    expect(west.days.length).toBe(7);
    // 近 7 天最后一根 = 该时区「今天」，两时区相差 26 小时，日期键必然不同
    expect(east.days[6]).toBe(todayKeyInTz("Pacific/Kiritimati"));
    expect(west.days[6]).toBe(todayKeyInTz("Etc/GMT+12"));
    expect(east.days[6]).not.toBe(west.days[6]);
    expect(east.covText).toContain("Pacific/Kiritimati");
    expect(west.covText).toContain("Etc/GMT+12");
  });
});

test.describe("§6 热力图「日」视图 hourly_today 优先（真实后端 + [拦截] overview）", () => {
  const mkBuckets = (hour, total) =>
    Array.from({ length: 24 }, (_, h) => ({ hour: h, total: h === hour ? total : 0 }));

  test("hourly_today.day==dashboard_period.today.key → 用 buckets；day 不匹配 → 回退旧 hourly 数组", async ({ page, context }) => {
    await loginWithToken(context);
    const p = clone(base.payload);
    const todayKey = p.dashboard_period.today.key;
    // 旧 hourly 在 5 点放标记值；hourly_today.buckets 在 15 点放标记值
    p.activity.hourly = mkBuckets(5, 111);
    p.activity.hourly_today = { day: todayKey, time_zone: p.activity.time_zone, buckets: mkBuckets(15, 222) };
    await stubOverview(page, p);
    await page.goto("/#history");
    await page.click('#act-seg button[data-v="day"]');
    const v15 = await page.locator('.hm-cell.hm-d[data-h="15"]').getAttribute("data-v");
    const v5 = await page.locator('.hm-cell.hm-d[data-h="5"]').getAttribute("data-v");
    expect(v15, "day 匹配 → 优先 hourly_today.buckets").toBe("222");
    expect(v5).toBe("0");

    // day 与 dashboard_period.today.key 不匹配 → 回退旧 hourly
    const p2 = clone(p);
    p2.activity.hourly_today = { day: "1999-01-01", time_zone: p.activity.time_zone, buckets: mkBuckets(15, 222) };
    const page2 = await context.newPage();
    await stubOverview(page2, p2);
    await page2.goto("/#history");
    await page2.click('#act-seg button[data-v="day"]');
    const w5 = await page2.locator('.hm-cell.hm-d[data-h="5"]').getAttribute("data-v");
    const w15 = await page2.locator('.hm-cell.hm-d[data-h="15"]').getAttribute("data-v");
    expect(w5, "day 不匹配 → 回退旧 hourly").toBe("111");
    expect(w15).toBe("0");
    await page2.close();
  });
});

test.describe("§5 设备离线判定服从官方上传间隔（真实后端 + [拦截] overview）", () => {
  test("30 分钟设备 50 分钟前上报仍在线；5 分钟设备 20 分钟前上报离线", async ({ page, context }) => {
    await loginWithToken(context);
    const p = clone(base.payload);
    const ago50 = new Date(Date.now() - 50 * 60000).toISOString();
    const ago20 = new Date(Date.now() - 20 * 60000).toISOString();
    p.staleAfterMs = 600000;
    p.devices = [
      { deviceId: "dev-slow-30m", hostname: "SLOW-SYNC-30MIN", receivedAt: ago50, syncUploadIntervalMs: 1800000, trackedClients: ["claude"] },
      { deviceId: "dev-fast-5m", hostname: "FAST-SYNC-5MIN", receivedAt: ago20, syncUploadIntervalMs: 300000, trackedClients: ["claude"] },
    ];
    await stubOverview(page, p);
    await page.goto("/#devices");
    const slowCard = page.locator(".dev-card", { hasText: "SLOW-SYNC-30MIN" });
    const fastCard = page.locator(".dev-card", { hasText: "FAST-SYNC-5MIN" });
    // 官方回退规则：max(30min×2, 10min) = 60min → 50min 前仍在线
    await expect(slowCard.locator(".status")).toContainText("在线");
    // max(5min×2, 10min) = 10min → 20min 前已离线
    await expect(fastCard.locator(".status")).toContainText("离线");
    await expect(page.locator("#dev-summary")).toContainText("服务端按每台设备的上传间隔判定");
  });
});

test.describe("§7 capabilities.tokenComponents=false（demo ?cm-scenario=nocap）", () => {
  test("nocap → 单色条且不标「真实构成」", async ({ page }) => {
    await page.goto("/demo?cm-scenario=nocap");
    await expect(page.locator("#shell")).toBeVisible();
    await expect(page.locator("#client-dist-sub")).toContainText("后端未提供真实构成");
    await expect(page.locator("#client-dist-sub")).not.toContainText("真实构成分段");
    // 每行都是单色总量条（无构成分段 seg- 类）
    const rows = await page.locator("#client-dist .dist-row").count();
    expect(rows).toBeGreaterThan(0);
    await expect(page.locator("#client-dist .dist-part")).toHaveCount(rows);
    await expect(page.locator('#client-dist .dist-part[class*="seg-"]')).toHaveCount(0);
  });

  test("默认场景（tokenComponents=true）→ 标注真实构成分段", async ({ page }) => {
    await page.goto("/demo");
    await expect(page.locator("#shell")).toBeVisible();
    await expect(page.locator("#client-dist-sub")).toContainText("真实构成分段");
  });

  test("客户端分布用 token-monitor logo 标识，不用色点", async ({ page }) => {
    await page.goto("/demo");
    await expect(page.locator("#shell")).toBeVisible();
    const rows = page.locator("#client-dist .dist-row");
    const n = await rows.count();
    expect(n).toBeGreaterThan(0);
    await expect(page.locator("#client-dist .dist-name .client-logo")).toHaveCount(n);
    await expect(page.locator("#client-dist .dist-name i[style*='background']")).toHaveCount(0);
    const mask = await page.locator("#client-dist .client-logo").first().evaluate((el) => {
      const s = getComputedStyle(el);
      return s.maskImage || s.webkitMaskImage || "";
    });
    expect(mask).toMatch(/client-logos\/[a-z0-9-]+\.svg/);
  });

  test("客户端分布进度条轨道等宽", async ({ page }) => {
    await page.goto("/demo");
    await expect(page.locator("#shell")).toBeVisible();
    const tracks = page.locator("#client-dist .dist-track");
    await expect(tracks.first()).toBeVisible();
    const n = await tracks.count();
    expect(n).toBeGreaterThan(1);
    const widths = await tracks.evaluateAll((els) =>
      els.map((el) => +el.getBoundingClientRect().width.toFixed(2))
    );
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(1);
  });

  test("设备 / 配额 / 矩阵用 logo；模型图例与会话明细用色点", async ({ page }) => {
    await page.goto("/demo");
    await expect(page.locator("#shell")).toBeVisible();
    await expect(page.locator("#mx .mx-col .client-logo").first()).toBeVisible();
    await expect(page.locator("#mx .mx-row .client-logo").first()).toBeVisible();
    await expect(page.locator("#mx .mx-col i[style*='background']")).toHaveCount(0);
    await expect(page.locator("#mx .mx-row i[style*='background']")).toHaveCount(0);
    await expect(page.locator("#model-dist .donut-lg-row .client-logo")).toHaveCount(0);
    await expect(page.locator("#model-dist .donut-lg-row i[style*='background']").first()).toBeVisible();

    const sessDots = page.locator("#sess-body .dev-chip i[style*='background']");
    await expect(sessDots.first()).toBeVisible();
    await expect(page.locator("#sess-body .dev-chip .client-logo")).toHaveCount(0);

    await page.goto("/demo#devices");
    await expect(page.locator("#dev-grid .dev-chip .client-logo").first()).toBeVisible();
    await expect(page.locator("#dev-grid .dev-chip i[style*='background']")).toHaveCount(0);

    await page.goto("/demo#quota");
    await expect(page.locator("#lim-grid .lim-provider .client-logo").first()).toBeVisible();
    await expect(page.locator("#sub-grid .sub-card").first()).toBeVisible();
    await expect(page.locator("#sub-grid .sub-provider .client-logo").first()).toBeVisible();
    await expect(page.locator("#sub-grid .sub-provider i[style*='background']")).toHaveCount(0);
  });

  test("提供商状态含今日 DeepSeek / Kimi，不含未上报的 GLM", async ({ page }) => {
    await page.goto("/demo");
    await expect(page.locator("#provider-panel")).toBeVisible();
    await expect(page.locator("#provider-grid")).toContainText("DeepSeek");
    await expect(page.locator("#provider-grid")).toContainText("Kimi");
    await expect(page.locator("#provider-grid")).toContainText("Anthropic");
    await expect(page.locator("#provider-grid")).not.toContainText("GLM");
    await expect(page.locator("#provider-grid")).not.toContainText("智谱");
  });

  test("周/月热力格子保持正方形（桌面与手机）", async ({ page }) => {
    const assertSquare = async (sel, minPx) => {
      const box = await page.locator(sel).first().evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height };
      });
      expect(Math.abs(box.w - box.h)).toBeLessThanOrEqual(1.5);
      expect(box.w).toBeGreaterThanOrEqual(minPx);
    };
    await page.goto("/demo#history");
    await expect(page.locator("#hm .hm-m").first()).toBeVisible();
    await assertSquare("#hm .hm-m:not(.hm-skip)", 28);
    await page.click('#act-seg button[data-v="week"]');
    await expect(page.locator("#hm .hm-w:not(.hm-skip)").first()).toBeVisible();
    await assertSquare("#hm .hm-w:not(.hm-skip)", 20);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.click('#act-seg button[data-v="month"]');
    await expect(page.locator("#hm .hm-m:not(.hm-skip)").first()).toBeVisible();
    await assertSquare("#hm .hm-m:not(.hm-skip)", 28);
    await page.click('#act-seg button[data-v="week"]');
    await expect(page.locator("#hm .hm-w:not(.hm-skip)").first()).toBeVisible();
    await assertSquare("#hm .hm-w:not(.hm-skip)", 26);
  });

  test("nocap 的今日 KPI 不把未知来源伪装成非缓存输入", async ({ page }) => {
    await page.goto("/demo?cm-scenario=nocap");
    await expect(page.locator("#shell")).toBeVisible();
    const firstKpi = page.locator("#kpis .kpi-card").first();
    await expect(firstKpi.locator(".kpi-legend")).toContainText("组成未知");
    await expect(firstKpi.locator(".kpi-legend")).not.toContainText("非缓存输入");
    await expect(firstKpi.locator(".kpi-mix-note")).toContainText("未将剩余量猜作非缓存输入");
  });
});

test.describe("设备诊断官方结构与显式状态枚举（真实后端 + [拦截] overview）", () => {
  test("clientHealth.clients 被正确展开，not-running/missing 显示异常且元字段不冒充客户端", async ({ page, context }) => {
    await loginWithToken(context);
    const p = clone(base.payload);
    p.devices = [{
      deviceId: "diag-device",
      hostname: "DIAG-MACHINE",
      receivedAt: new Date().toISOString(),
      stale: false,
      trackedClients: ["claude"],
      today: { totalTokens: 1 }, month: { totalTokens: 1 }, allTime: { totalTokens: 1 },
    }];
    p.diagnostics = [{
      deviceId: "diag-device",
      hostname: "DIAG-MACHINE",
      clientStatus: { claude: "missing" },
      clientHealth: {
        version: 1,
        observedAt: new Date().toISOString(),
        clients: {
          claude: {
            source: { state: "detected" },
            collection: { state: "not-running" },
          },
        },
      },
      wslStatus: null,
    }];
    await stubOverview(page, p);
    await page.goto("/#devices");
    const card = page.locator(".dev-card", { hasText: "DIAG-MACHINE" });
    await expect(card.locator(".diag-tool")).toHaveCount(1);
    await expect(card.locator(".diag-tool")).toContainText("claude");
    await expect(card.locator(".diag-tool")).toContainText("异常");
    await expect(card.locator(".diag-health")).not.toContainText("version");
    await expect(card.locator(".diag-health")).not.toContainText("observedAt");
  });
});

test.describe("§8 配额与订阅渲染（demo）", () => {
  test("credits 窗口、topup 充值台账、intervalCount=3 显示「每 3 个月」", async ({ page }) => {
    await page.goto("/demo#quota");
    await expect(page.locator("#shell")).toBeVisible();
    // credits 窗口（余额型，绝对余额展示）
    await expect(page.locator("#lim-grid")).toContainText("预付费额度");
    // topup 订阅 → 充值台账（次数/累计/最近充值，无月费续费）
    await expect(page.locator("#sub-grid")).toContainText("充值台账");
    await expect(page.locator("#sub-grid")).toContainText("累计");
    // intervalCount=3 → 「每 3 个月」
    await expect(page.locator("#sub-grid")).toContainText("每 3 个月");
  });
});

test.describe("XSS 名称转义（真实后端 + [拦截] overview）", () => {
  test("设备名/模型名含 <script>、onerror → 全部转义，无脚本执行", async ({ page, context }) => {
    await loginWithToken(context);
    const p = clone(base.payload);
    const xssName = '<script>window.__xssDev=1</script>';
    const xssModel = '<img src=x onerror="window.__xssModel=1">';
    p.devices[0].hostname = xssName;
    const models = p.totals.today.models || {};
    const first = Object.keys(models)[0];
    models[xssModel] = models[first] || 12345;
    delete models[first];
    await stubOverview(page, p);
    await page.goto("/");
    await expect(page.locator("#shell")).toBeVisible();
    // 无脚本执行
    const leaked = await page.evaluate(() => !!(window.__xssDev || window.__xssModel));
    expect(leaked).toBe(false);
    // 原文作为文本呈现（已转义）
    await expect(page.locator("#model-dist")).toContainText(xssModel);
    await page.click('[data-view="devices"].nav-item');
    await expect(page.locator("#dev-grid")).toContainText("<script>window.__xssDev=1</script>");
    // DOM 中不存在注入的 script/img 节点
    expect(await page.locator("#dev-grid script").count()).toBe(0);
    expect(await page.locator('#model-dist img[src="x"]').count()).toBe(0);
  });
});

test.describe("模型分布环形图中心文字（demo）", () => {
  test("主数字落在圆环几何中心", async ({ page }) => {
    await page.goto("/demo");
    await expect(page.locator("#shell")).toBeVisible();
    const donut = page.locator("#model-dist .donut");
    await expect(donut).toBeVisible();
    const svgBox = await donut.locator("svg").boundingBox();
    const numBox = await donut.locator(".donut-center b").boundingBox();
    expect(svgBox).toBeTruthy();
    expect(numBox).toBeTruthy();
    const dx = (numBox.x + numBox.width / 2) - (svgBox.x + svgBox.width / 2);
    const dy = (numBox.y + numBox.height / 2) - (svgBox.y + svgBox.height / 2);
    expect(Math.abs(dx), `horizontal offset ${dx}`).toBeLessThan(3);
    expect(Math.abs(dy), `vertical offset ${dy}`).toBeLessThan(3);
    expect(Math.abs(svgBox.width - svgBox.height), "donut svg not square").toBeLessThan(1);
  });
});

test.describe("模型分布环形图选中态（颜色不串 / 100% 整环外凸）", () => {
  test("无底环，悬停非最大段时各弧 fill 不变", async ({ page }) => {
    await page.goto("/demo");
    await expect(page.locator("#shell")).toBeVisible();
    await page.locator('#model-seg button[data-p="month"]').click();
    const arcs = page.locator("#model-dist .donut-arc");
    await expect(arcs).not.toHaveCount(0);
    const n = await arcs.count();
    expect(n).toBeGreaterThan(2);
    await expect(page.locator("#model-dist .donut-bg")).toHaveCount(0);
    const fillByName = {};
    for (let i = 0; i < n; i++) {
      const name = await arcs.nth(i).getAttribute("data-name");
      fillByName[name] = await arcs.nth(i).getAttribute("fill");
    }
    expect(new Set(Object.values(fillByName)).size, "多模型应有多种弧色").toBeGreaterThan(1);

    const row = page.locator("#model-dist .donut-lg-row").nth(1);
    const hotName = await row.getAttribute("data-name");
    expect(hotName).toBeTruthy();
    await row.hover();
    await expect(page.locator("#model-dist")).toHaveClass(/has-hot/);
    await expect(page.locator(`#model-dist .donut-arc[data-name="${hotName}"]`)).toHaveClass(/is-hot/);
    await expect(page.locator("#model-dist .donut-arc.is-hot")).toHaveCount(1);
    const after = await page.locator("#model-dist .donut-arc").evaluateAll((els) =>
      Object.fromEntries(els.map((el) => [el.getAttribute("data-name"), el.getAttribute("fill")]))
    );
    expect(after, "选中后各弧 fill 必须保持").toEqual(fillByName);
    const xf = await page.locator(`#model-dist .donut-arc[data-name="${hotName}"]`).evaluate((el) => getComputedStyle(el).transform);
    expect(xf === "none" || xf === "matrix(1, 0, 0, 1, 0, 0)", "选中不得 scale").toBeTruthy();
  });

  test("两段合计 100% 时只有两段 path，无第三段灰弧", async ({ page, context }) => {
    await loginWithToken(context);
    const p = clone(base.payload);
    const pair = {
      "cursor-grok-4.6-xhigh-fast": 22630000,
      "cursor-grok-4.6-high-fast": 3156000,
    };
    for (const key of ["today", "month", "allTime"]) {
      if (p.totals && p.totals[key]) p.totals[key].models = { ...pair };
    }
    await stubOverview(page, p);
    await page.goto("/");
    await expect(page.locator("#shell")).toBeVisible();
    const arcs = page.locator("#model-dist .donut-arc");
    await expect(arcs).toHaveCount(2);
    await expect(page.locator("#model-dist .donut-lg-row")).toHaveCount(2);
    await expect(page.locator("#model-dist .donut-bg")).toHaveCount(0);
    const meta = await arcs.evaluateAll((els) => els.map((el) => ({
      name: el.getAttribute("data-name"),
      fill: el.getAttribute("fill"),
      start: Number(el.getAttribute("data-start")),
      end: Number(el.getAttribute("data-end")),
      tag: el.tagName,
    })));
    expect(meta.every((m) => m.tag === "path"), "必须是 path 扇区").toBeTruthy();
    expect(meta[0].start).toBeLessThanOrEqual(0);
    expect(meta[1].end).toBeGreaterThanOrEqual(360);
    expect(meta[1].end - meta[0].start).toBeGreaterThanOrEqual(360);
    expect(meta[0].fill).not.toBe(meta[1].fill);
    expect(meta.every((m) => m.fill && m.fill !== "none")).toBeTruthy();
  });

  test("单模型 100% 弧无接缝，悬停只加大外径、不 scale", async ({ page, context }) => {
    await loginWithToken(context);
    const p = clone(base.payload);
    const only = { "solo-model": 12638361 };
    for (const key of ["today", "month", "allTime"]) {
      if (p.totals && p.totals[key]) p.totals[key].models = { ...only };
    }
    await stubOverview(page, p);
    await page.goto("/");
    await expect(page.locator("#shell")).toBeVisible();
    const arc = page.locator("#model-dist .donut-arc");
    await expect(arc).toHaveCount(1);
    await expect(arc).toHaveAttribute("data-full", "1");
    expect((await arc.evaluate((el) => el.tagName)).toLowerCase(), "满环用 circle 避免 3 点接缝").toBe("circle");
    await expect(page.locator("#model-dist .donut-bg")).toHaveCount(0);
    const box0 = await arc.evaluate((el) => {
      const b = el.getBBox();
      return { w: b.width, h: b.height };
    });
    expect(Math.abs(box0.w - box0.h), "满环应为同心圆").toBeLessThan(0.5);

    await page.locator("#model-dist .donut-lg-row").first().hover();
    await expect(page.locator("#model-dist")).toHaveClass(/has-hot/);
    await expect(arc).toHaveClass(/is-hot/);
    const after = await arc.evaluate((el) => {
      const t = getComputedStyle(el).transform;
      const b = el.getBBox();
      return { t, w: b.width, h: b.height };
    });
    expect(after.t === "none" || after.t === "matrix(1, 0, 0, 1, 0, 0)", "禁止 scale").toBeTruthy();
    expect(after.w, "悬停应加大外径").toBeGreaterThan(box0.w + 6);
    expect(Math.abs(after.w - after.h), "外凸后仍同心").toBeLessThan(0.5);
  });
});

test.describe("夜间模式与趋势文案（demo）", () => {
  test("右上角按钮切换夜间模式并持久化", async ({ page }) => {
    await page.goto("/demo");
    await expect(page.locator("#shell")).toBeVisible();
    const btn = page.locator("#theme-toggle");
    await expect(btn).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await btn.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#0b1220");
    expect(await page.evaluate(() => localStorage.getItem("cm_theme"))).toBe("dark");
    await page.reload();
    await expect(page.locator("#shell")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("#theme-toggle")).toBeVisible();
    await expect(page.locator("#refresh")).toBeVisible();
  });

  test("近 30 天趋势副标题不再写堆叠着色说明", async ({ page }) => {
    await page.goto("/demo");
    await expect(page.locator("#shell")).toBeVisible();
    const sub = page.locator(".chart-panel .panel-sub");
    await expect(sub).toHaveText("每日 token 合计");
    await expect(sub).not.toContainText("按模型堆叠着色");
    await expect(sub).not.toContainText("悬停查看明细");
  });
});

test.describe("模型分布缓存率（demo）", () => {
  test("无缓存率切换，悬停图例行显示该模型缓存率", async ({ page }) => {
    await page.goto("/demo");
    await expect(page.locator("#shell")).toBeVisible();
    await expect(page.locator("#model-metric-seg")).toHaveCount(0);
    await expect(page.locator("#model-dist-sub")).toContainText("按 token 占比");
    await expect(page.locator("#model-dist-sub")).not.toContainText("缓存");
    const row = page.locator("#model-dist .donut-lg-row").first();
    await expect(row).toBeVisible();
    await row.hover();
    const tip = page.locator(".float-tip");
    await expect(tip).toBeVisible();
    await expect(tip).toContainText("tokens");
    await expect(tip).toContainText("占比");
    await expect(tip).toContainText("模型使用费用");
    await expect(tip).toContainText("$");
    await expect(tip).toContainText("缓存率");
    await expect(tip.locator(".tip-row")).toHaveCount(4);
  });
});

test.describe("§10 键盘导航（demo）", () => {
  test("seg 支持 ArrowRight/Home/End 与 aria-selected 切换", async ({ page }) => {
    await page.goto("/demo");
    await expect(page.locator("#shell")).toBeVisible();
    const seg = page.locator("#model-seg");
    const btns = seg.locator("button[data-p]");
    const count = await btns.count();
    expect(count).toBeGreaterThan(2);
    await btns.nth(0).focus();
    // ArrowRight → 第二项
    await page.keyboard.press("ArrowRight");
    await expect(btns.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(btns.nth(0)).toHaveAttribute("aria-selected", "false");
    // End → 最后一项
    await page.keyboard.press("End");
    await expect(btns.nth(count - 1)).toHaveAttribute("aria-selected", "true");
    // Home → 第一项
    await page.keyboard.press("Home");
    await expect(btns.nth(0)).toHaveAttribute("aria-selected", "true");
    // act-seg（data-v 属性）同样可用（hash 变化不触发重载，需新页面）
    const page2 = await page.context().newPage();
    await page2.goto("/demo#history");
    await expect(page2.locator("#shell")).toBeVisible();
    const actSeg = page2.locator("#act-seg");
    const monthBtn = actSeg.locator('button[data-v="month"]');
    await monthBtn.focus();
    await page2.keyboard.press("ArrowLeft");
    await expect(actSeg.locator('button[data-v="week"]')).toHaveAttribute("aria-selected", "true");
  });
});

test.describe("官方前端契约夹具对齐（金标准，真实后端 + [拦截] 对应端点）", () => {
  test("overview.json：month 周期 caps=false 且拆分为 0/unclassified=全量 → 单色总量条，无 0 值彩色分段", async ({ page, context }) => {
    await loginWithToken(context);
    await stubOverview(page, readFixture("overview.json"));
    await page.goto("/");
    await expect(page.locator("#shell")).toBeVisible();
    await page.click('#client-seg button[data-p="month"]');
    await expect(page.locator("#client-dist-sub")).toContainText("后端未提供真实构成");
    const rows = await page.locator("#client-dist .dist-row").count();
    expect(rows).toBeGreaterThan(0);
    await expect(page.locator("#client-dist .dist-part")).toHaveCount(rows);
    await expect(page.locator('#client-dist .dist-part[class*="seg-"]')).toHaveCount(0);
    // overview 不得内嵌 370 天 history：夹具确认无该字段
    expect("history" in readFixture("overview.json")).toBe(false);
  });

  test("provider_status.json：两张 operational 卡按新字段渲染", async ({ page, context }) => {
    await loginWithToken(context);
    await stubOverview(page, base.payload);
    await page.route("**/api/v1/tm/provider-status*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: fs.readFileSync(path.join(CONTRACT_FIXTURES, "provider_status.json"), "utf8") })
    );
    await page.goto("/");
    await expect(page.locator(".pv-card")).toHaveCount(2);
    await expect(page.locator("#provider-grid")).toContainText("Anthropic");
    await expect(page.locator("#provider-grid")).toContainText("OpenAI");
    await expect(page.locator("#provider-grid .pv-status").first()).toContainText("正常");
  });

  test("history_daily.json：items 形状渲染单行，has_more=false 停止分页", async ({ page, context }) => {
    await loginWithToken(context);
    await stubOverview(page, base.payload);
    const state = { count: 0 };
    await page.route("**/api/v1/tm/history/daily*", async (route) => {
      state.count++;
      await route.fulfill({ status: 200, contentType: "application/json", body: fs.readFileSync(path.join(CONTRACT_FIXTURES, "history_daily.json"), "utf8") });
    });
    await page.goto("/#history");
    await expect(page.locator("#hist-body tr")).toHaveCount(1);
    /* 日期断言取夹具自身的 day：夹具由后端导出测试按当天日期再生，
       硬编码日期字面量会在再生后过期（原 "2026-08-23" 即此病） */
    const histDay = readFixture("history_daily.json").items[0].day;
    await expect(page.locator("#hist-body")).toContainText(histDay);
    await expect(page.locator("#hist-body")).toContainText("$4.82");
    await expect(page.locator("#hist-sub")).toContainText("保留 370 天");
    await expect(page.locator("#hist-sub")).toContainText("日口径：设备本地日");
    await expect(page.locator("#hist-more")).toHaveText("");
    await page.waitForTimeout(300);
    expect(state.count, "has_more=false 不得再翻页").toBe(1);
  });
});

test.describe("移动端无页面级横向溢出（demo，§13 四档尺寸）", () => {
  const sizes = [
    [320, 568], [375, 812], [768, 1024], [1440, 900],
  ];
  for (const [w, h] of sizes) {
    test(`${w}×${h} 四视图 + 登录门无横向溢出`, async ({ browser }) => {
      const ctx = await browser.newContext({ baseURL: ORIGIN, viewport: { width: w, height: h } });
      const page = await ctx.newPage();
      const check = async (label) => {
        const m = await page.evaluate(() => ({
          doc: document.documentElement.scrollWidth,
          body: document.body.scrollWidth,
          win: window.innerWidth,
        }));
        expect(m.doc, `${label} documentElement.scrollWidth`).toBeLessThanOrEqual(m.win + 1);
        expect(m.body, `${label} body.scrollWidth`).toBeLessThanOrEqual(m.win + 1);
      };
      await page.goto("/");
      await expect(page.locator("#gate")).toBeVisible();
      await check("gate");
      for (const view of ["overview", "devices", "quota", "history"]) {
        await page.goto(`/demo#${view}`);
        await expect(page.locator("#shell")).toBeVisible();
        await page.waitForTimeout(300);
        await check(view);
      }
      await ctx.close();
    });
  }
});

test.describe("审计回归批 2026-08-25（demo）", () => {
  test("§3-11 辅助接口在途跨过一次主刷新（gen 递增）后仍能就绪，不卡 loading", async ({ page }) => {
    await page.goto("/demo#quota");
    await expect(page.locator("#shell")).toBeVisible();
    // 订阅：打回 idle 重新加载，在途期间递增 requestGeneration（模拟轮询/
    // 手动刷新/页面切回）。旧实现丢弃响应且不复位 → 永久「正在加载订阅清单…」
    await page.evaluate(async () => {
      state.aux.subs.status = "idle";
      state.aux.subs.data = null;
      ensureSubs();
      state.requestGeneration++;
      await new Promise((r) => setTimeout(r, 500));
    });
    expect(await page.evaluate(() => state.aux.subs.status)).toBe("ready");
    await expect(page.locator("#sub-grid .sub-card").first()).toBeVisible();

    // 历史分页同路径：旧实现 finally 只在 gen 匹配时清 loading → 永久空转
    await page.evaluate(async () => {
      resetHistory();
      state.requestGeneration++;
      await new Promise((r) => setTimeout(r, 500));
    });
    const hist = await page.evaluate(() => ({
      status: state.aux.history.status,
      rows: state.aux.history.rows.length,
      loading: state.aux.history.loading,
    }));
    expect(hist.status).toBe("ready");
    expect(hist.rows).toBeGreaterThan(0);
    expect(hist.loading).toBe(false);
  });

  test("夜间模式下矩阵色阶图例与格子同源：CSS 类驱动，无内联色", async ({ page }) => {
    await page.goto("/demo");
    await expect(page.locator("#shell")).toBeVisible();
    await page.locator("#theme-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const legendSwatches = page.locator(".mx-scale .mx-cell");
    await expect(legendSwatches).toHaveCount(6); // is-zero + lv0..4
    const pair = await page.evaluate(() => {
      const bg = (el) => (el ? getComputedStyle(el).backgroundColor : null);
      const lg = document.querySelector(".mx-scale .mx-cell.mx-lv4");
      const cell = document.querySelector(".mx-grid .mx-cell.mx-lv4");
      return {
        legendLv4: bg(lg),
        cellLv4: bg(cell),
        anyInline: [...document.querySelectorAll(".mx-scale .mx-cell")]
          .some((el) => (el.getAttribute("style") || "").includes("background")),
      };
    });
    expect(pair.anyInline, "图例不得再用内联色").toBe(false);
    expect(pair.cellLv4, "网格最大值格恒为 lv4").toBeTruthy();
    expect(pair.legendLv4).toBe(pair.cellLv4);
  });

  test("月摘要紧凑数字的中文单位与数字同行（不被 display:block 挤下去）", async ({ page }) => {
    await page.goto("/demo#history");
    await expect(page.locator("#shell")).toBeVisible();
    await expect(page.locator(".hm-sum b .num-unit").first()).toBeVisible();
    const m = await page.evaluate(() => {
      const unit = document.querySelector(".hm-sum b .num-unit");
      const int = unit.closest(".num-compact").querySelector(".num-int");
      const u = unit.getBoundingClientRect();
      const i = int.getBoundingClientRect();
      return { unitTop: u.top, intBottom: i.bottom, unitDisplay: getComputedStyle(unit).display };
    });
    expect(m.unitDisplay).not.toBe("block");
    expect(m.unitTop, "单位与数字垂直区间必须重叠（同一行）").toBeLessThan(m.intBottom);
  });

  test("手机端矩阵列表头只显示图标，行名仍带文字", async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto("/demo");
    await expect(page.locator("#shell")).toBeVisible();
    await expect(page.locator("#mx .mx-col .client-logo").first()).toBeVisible();
    await expect(page.locator("#mx .mx-row .mx-label").first()).toBeVisible();
    const vis = await page.evaluate(() => {
      const colLabel = document.querySelector("#mx .mx-col .mx-label");
      const rowLabel = document.querySelector("#mx .mx-row .mx-label");
      const cs = (el) => (el ? getComputedStyle(el).display : null);
      return { col: cs(colLabel), row: cs(rowLabel), colCount: document.querySelectorAll("#mx .mx-col").length };
    });
    expect(vis.colCount).toBeGreaterThan(0);
    expect(vis.col, "窄屏不得显示截断的模型名").toBe("none");
    expect(vis.row, "行客户端名仍显示").not.toBe("none");
    await ctx.close();
  });

  test("矩阵跨 768px 断点 resize 后重渲染布局", async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto("/demo");
    await expect(page.locator("#shell")).toBeVisible();
    const gridStyle = () => page.evaluate(() => document.querySelector(".mx-grid").getAttribute("style") || "");
    expect(await gridStyle()).toContain("minmax(48px");
    await page.setViewportSize({ width: 500, height: 800 });
    await page.waitForTimeout(400); // resize 防抖 160ms + 渲染余量
    expect(await gridStyle(), "缩窄后应切换为窄屏列模板").toContain("minmax(0");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(400);
    expect(await gridStyle(), "拉宽后应切回桌面列模板").toContain("minmax(48px");
    await ctx.close();
  });
});

test.describe("系统偏好夜间（demo）", () => {
  test.use({ colorScheme: "dark" });
  test("无存储选择时首屏即夜间模式，且不把缺省回写 localStorage", async ({ page }) => {
    await page.goto("/demo");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("#shell")).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("cm_theme"))).toBeNull();
    // 显式切到日间 → 落盘 light，系统偏好不再覆盖
    await page.locator("#theme-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    expect(await page.evaluate(() => localStorage.getItem("cm_theme"))).toBe("light");
  });
});
