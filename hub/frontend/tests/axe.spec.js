// §13-3：axe-core 可访问性扫描（gate + demo 四视图）。严重/关键 violation 视为失败。
const path = require("path");
const { test, expect } = require("@playwright/test");

const fs = require("fs");
const AXE_SOURCE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

async function scan(page, label) {
  // 后端 CSP script-src 'self' 禁止内联/外源注入：经同源 /static 路由提供 axe（仅测试拦截）
  await page.route("**/static/__axe-test.js", (route) =>
    route.fulfill({ status: 200, contentType: "application/javascript", body: AXE_SOURCE })
  );
  await page.addScriptTag({ url: "/static/__axe-test.js" });
  const results = await page.evaluate(async () => {
    const r = await window.axe.run(document, {
      resultTypes: ["violations"],
      rules: { "color-contrast": { enabled: true } },
    });
    return r.violations.map((v) => ({
      id: v.id, impact: v.impact, help: v.help,
      nodes: v.nodes.map((n) => n.target.join(" ")),
    }));
  });
  const severe = results.filter((v) => v.impact === "critical" || v.impact === "serious");
  if (results.length) {
    console.log(`[axe:${label}] violations=${results.length}`, JSON.stringify(results, null, 1));
  } else {
    console.log(`[axe:${label}] violations=0`);
  }
  expect(severe, `axe ${label} 严重/关键 violation`).toEqual([]);
  return results;
}

test.describe("axe-core 可访问性（gate + demo 四视图）", () => {
  test("登录门 gate", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#gate")).toBeVisible();
    await scan(page, "gate");
  });

  for (const view of ["overview", "devices", "quota", "history"]) {
    test(`demo 视图 ${view}`, async ({ page }) => {
      await page.goto(`/?demo=1#${view}`);
      await expect(page.locator("#shell")).toBeVisible();
      await page.waitForTimeout(500); // 等 quota/history 辅助数据渲染
      await scan(page, view);
    });
  }
});
