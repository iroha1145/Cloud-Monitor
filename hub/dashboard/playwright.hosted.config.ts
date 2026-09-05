import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests", testMatch: "**/hosted.spec.ts", workers: 1,
  use: { channel: process.env.CI ? undefined : "chrome", baseURL: "http://127.0.0.1:18888", viewport: { width: 1512, height: 1080 }, trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: [
    { command: `${process.env.CM_TEST_PYTHON || "python3"} tests/serve-hosted.py`, url: "http://127.0.0.1:18888/api/v1/health/live", timeout: 30000, reuseExistingServer: false },
    { command: `${process.env.CM_TEST_PYTHON || "python3"} -m http.server 18900 --bind 127.0.0.1 --directory dist-showcase`, url: "http://127.0.0.1:18900", reuseExistingServer: false },
  ], reporter: "list", outputDir: "evidence/hosted-test-results",
});
