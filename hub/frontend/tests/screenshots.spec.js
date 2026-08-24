// §13-4：桌面 1440×900 / 手机 375×812 四视图截图 → tests/evidence/
const path = require("path");
const { test, expect } = require("@playwright/test");

const OUT = path.join(__dirname, "evidence");

const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 375, height: 812 },
];

for (const vp of viewports) {
  test.describe(`截图 ${vp.name} ${vp.width}×${vp.height}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });
    test("登录门 + 四视图", async ({ page }) => {
      await page.goto("/");
      await expect(page.locator("#gate")).toBeVisible();
      await page.screenshot({ path: path.join(OUT, `${vp.name}-gate.png`) });
      for (const view of ["overview", "devices", "quota", "history"]) {
        /* 仅 hash 变化的 goto 是同文档导航（不重载、无 hashchange 监听）：
           先到 about:blank 强制整页加载，保证各视图截图落在正确视图 */
        await page.goto("about:blank");
        await page.goto(`/demo#${view}`);
        await expect(page.locator("#shell")).toBeVisible();
        await expect(page.locator(`.view[data-view="${view}"]`)).toBeVisible();
        await page.waitForTimeout(600);
        await page.screenshot({ path: path.join(OUT, `${vp.name}-${view}.png`), fullPage: false });
      }
    });
  });
}
