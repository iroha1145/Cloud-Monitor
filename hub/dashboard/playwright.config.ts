import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  testIgnore: "**/hosted.spec.ts",
  webServer: { command: "npm run dev", url: "http://127.0.0.1:5188", reuseExistingServer: !process.env.CI },
  fullyParallel: false,
  workers: 1,
  use: {
    channel: process.env.CI ? undefined : "chrome",
    baseURL: "http://127.0.0.1:5188",
    viewport: { width: 1512, height: 1080 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  reporter: "list",
  outputDir: "test-results",
});
