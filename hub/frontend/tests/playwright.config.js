// §13 Playwright 配置：真实 FastAPI 后端（scratch 夹具，见 start-e2e-server.sh）
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: ["e2e-real-backend.spec.js", "scenarios.spec.js", "axe.spec.js", "screenshots.spec.js"],
  timeout: 30000,
  expect: { timeout: 8000 },
  retries: 0,
  workers: 1, // 夹具后端单实例，串行避免互相干扰
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${process.env.CM_E2E_PORT || 18787}`,
    headless: true,
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
  },
  webServer: {
    command: `bash ${__dirname}/start-e2e-server.sh`,
    url: `http://127.0.0.1:${process.env.CM_E2E_PORT || 18787}/api/v1/health/live`,
    reuseExistingServer: true,
    timeout: 30000,
  },
});
