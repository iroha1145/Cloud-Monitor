import { defineConfig } from "@playwright/test";
const port = Number(process.env.CM_E2E_PORT || 5188);
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  testIgnore: "**/hosted.spec.ts",
  webServer: { command: `npm run dev -- --port ${port}`, url: baseURL, reuseExistingServer: !process.env.CI },
  fullyParallel: false,
  workers: 1,
  use: {
    channel: process.env.CI ? undefined : "chrome",
    baseURL,
    viewport: { width: 1512, height: 1080 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  reporter: "list",
  outputDir: "test-results",
});
