import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

// Captured from a fresh hub (official Node core, no device has reported yet).
const empty = readFileSync(new URL("./fixtures/overview-empty.json", import.meta.url), "utf8");

test("a server with no reports explains how to connect a device instead of showing bare zeros", async ({ page }) => {
  await page.route("**/api/**", (route) =>
    route.request().url().endsWith("/overview")
      ? route.fulfill({ status: 200, contentType: "application/json", body: empty })
      : route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"missing"}' }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "打开工作区设置", exact: true }).click();
  await page.getByLabel("访问密钥", { exact: true }).fill("empty-fixture");
  await page.getByRole("button", { name: "连接并查看真实用量" }).click();
  await expect(page.getByText("当前展示真实数据")).toBeVisible();

  const onboarding = page.getByRole("region", { name: "还没有设备上报用量" });
  await expect(onboarding).toBeVisible();
  await expect(onboarding).toContainText(new URL(page.url()).origin);
  await expect(onboarding).toContainText("TOKEN_MONITOR_SECRET");
  await expect(page.getByRole("region", { name: "用量组成" })).toContainText("这个周期还没有上报用量。");
  await expect(page.getByText("这个周期还没有模型用量")).toBeVisible();
  await expect(page.getByText("没有找到匹配的模型")).toHaveCount(0);
  await expect(page.getByText("还没有客户端上报")).toBeVisible();
});

test("the demo workspace never shows the first-report guide", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("当前展示示例数据")).toBeVisible();
  await expect(page.getByRole("region", { name: "还没有设备上报用量" })).toHaveCount(0);
});
