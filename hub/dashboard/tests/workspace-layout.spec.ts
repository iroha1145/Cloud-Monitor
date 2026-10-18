import { test, expect } from '@playwright/test';

test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  await info.attach('layout-geometry', { contentType: 'application/json', body: JSON.stringify(await page.locator('.feel-navigation, [data-feel-card]').evaluateAll(elements => elements.map(node => ({
    className: node.className, rect: node.getBoundingClientRect().toJSON(), style: node.getAttribute('style'), avoidance: node.getAttribute('data-menu-avoidance'),
  }))), null, 2) });
});

for (const width of [800, 1024, 1280, 1920]) {
  test(`workspace stays centered while only nearby notices and controls avoid navigation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/demo.html');
    const handle = page.getByRole('button', { name: '移动导航菜单', exact: true });
    const nav = page.locator('.feel-navigation');
    const main = page.locator('.main-content');
    const below = page.locator('.models-panel');
    // The menu is 216px wide (196px between 961 and 1250px) and keeps 16px from every edge.
    const navWidth = width >= 961 && width <= 1250 ? 196 : 216;
    await handle.press('Home');
    await expect.poll(async () => Math.round((await nav.boundingBox())!.x)).toBe(16);
    expect(Math.round((await nav.boundingBox())!.y)).toBe(16);
    expect(Math.round((await nav.boundingBox())!.width)).toBe(navWidth);
    const frame = (await main.boundingBox())!;
    expect(Math.abs(frame.x - (width - frame.x - frame.width))).toBeLessThan(1);
    const topbar = page.locator('.app-topbar');
    // The bar spans the window, so the menu at the top left covers its search side, which gives way.
    await expect.poll(async () => (await topbar.boundingBox())!.x - ((await nav.boundingBox())!.x + (await nav.boundingBox())!.width)).toBeGreaterThanOrEqual(15.5);
    const lowerBefore = (await below.boundingBox())!;
    expect(Math.abs(lowerBefore.x - (width - lowerBefore.x - lowerBefore.width))).toBeLessThan(1);
    expect(lowerBefore.y).toBeGreaterThan((await nav.boundingBox())!.y + (await nav.boundingBox())!.height + 64);

    for (const selector of ['.workspace-notices', '.page-controls']) {
      const block = page.locator(selector);
      await expect.poll(async () => (await block.boundingBox())!.x - ((await nav.boundingBox())!.x + (await nav.boundingBox())!.width)).toBeGreaterThanOrEqual(15.5);
    }
    await handle.press('ArrowRight');
    await expect.poll(async () => Math.round((await nav.boundingBox())!.x)).toBe(width - navWidth - 16);
    // As in game-manage, the bar spans the window: with the menu on the right
    // its search returns to the window's left edge and only its right side gives way.
    await expect.poll(async () => (await topbar.boundingBox())!.x).toBeCloseTo(width <= 960 ? 16 : 24, 1);
    await expect.poll(async () => (await nav.boundingBox())!.x - ((await topbar.boundingBox())!.x + (await topbar.boundingBox())!.width)).toBeGreaterThanOrEqual(15.5);
    for (const selector of ['.workspace-notices', '.page-controls']) {
      const block = page.locator(selector);
      await expect.poll(async () => (await nav.boundingBox())!.x - ((await block.boundingBox())!.x + (await block.boundingBox())!.width)).toBeGreaterThanOrEqual(15.5);
    }
    const lowerAfter = (await below.boundingBox())!;
    expect(lowerAfter.x).toBeCloseTo(lowerBefore.x, 1);
    expect(lowerAfter.width).toBeCloseTo(lowerBefore.width, 1);
    expect(await below.evaluate(el => (el as HTMLElement).style.width)).toBe('');
    await page.getByRole('tab', { name: '本月', exact: true }).click();
    await expect(page.getByRole('tab', { name: '本月', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.locator('.workspace-notices summary').click();
    await expect(page.locator('.workspace-notices')).toHaveAttribute('open', '');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `evidence/workspace-centered-${width}.png` });
  });
}

for (const width of [320, 390, 1280]) {
  test(`model records retain square corners and independent movement at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/demo.html#models');
    await page.getByRole('tab', { name: '本月', exact: true }).click();
    await expect(page.getByRole('tab', { name: '本月', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.locator('.workspace-notices summary').click();
    await expect(page.locator('.workspace-notices')).toHaveAttribute('open', '');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const record = page.locator('.model-table tbody tr[data-feel-item]').first();
    await expect(record).toBeVisible();
    const radii = await record.evaluate(el => [el, ...el.querySelectorAll('td')].map(node => {
      const style = getComputedStyle(node);
      return [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius];
    }));
    expect(radii.flat().every(radius => parseFloat(radius) === 0)).toBe(true);
    await expect(page.locator('.app-topbar .mobile-menu')).toHaveCount(0);
    await record.getByRole('button').first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });
}
