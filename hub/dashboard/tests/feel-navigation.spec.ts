import { test, expect } from '@playwright/test';

test('floating navigation supports throwing, corner keys and persistent card avoidance', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/demo.html');
  const handle = page.getByRole('button', { name: '移动导航菜单', exact: true });
  const nav = page.locator('.feel-navigation');
  await handle.press('Home');
  await expect.poll(async () => Math.round((await nav.boundingBox())!.x)).toBe(12);
  const wide = page.locator('.page-heading');
  const originalWide = await wide.evaluate(el => ({ width: el.getBoundingClientRect().width, styleWidth: el.style.width, left: el.style.marginLeft, right: el.style.marginRight }));
  await handle.press('ArrowRight');
  await expect.poll(async () => Math.round((await nav.boundingBox())!.x)).toBe(1044);
  await expect.poll(async () => (await wide.boundingBox())!.x + (await wide.boundingBox())!.width - (await nav.boundingBox())!.x).toBeLessThanOrEqual(-15.5);
  expect((await wide.boundingBox())!.width).toBeGreaterThanOrEqual(originalWide.width * 2 / 3);
  await expect(wide).toHaveAttribute('data-menu-avoidance', 'clear');
  const topbar = page.locator('.app-topbar');
  await expect.poll(async () => (await topbar.boundingBox())!.x + (await topbar.boundingBox())!.width - (await nav.boundingBox())!.x).toBeLessThanOrEqual(-15.5);
  await page.screenshot({ path: 'evidence/feel-desktop-avoidance-right.png', fullPage: false });
  const displaced = await page.locator('[data-feel-card]').evaluateAll(elements => elements.map(el => {
    const rect = el.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width };
  }));
  expect(displaced.every(rect => rect.left >= 0 && rect.right <= 1280)).toBeTruthy();
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + 15, box.y + 20); await page.mouse.down();
  await page.mouse.move(120, 740, { steps: 16 }); await page.mouse.up();
  await expect.poll(async () => Math.round((await nav.boundingBox())!.x)).toBe(12);
  await expect.poll(async () => Math.abs((await nav.boundingBox())!.y + (await nav.boundingBox())!.height - 888)).toBeLessThan(2);
  await handle.press('Home');
  await expect.poll(() => page.locator('[data-feel-card][data-feel-moving="true"]').count()).toBe(0);
  expect(await wide.evaluate(el => ({ width: el.getBoundingClientRect().width, styleWidth: el.style.width, left: el.style.marginLeft, right: el.style.marginRight }))).toEqual(originalWide);
});

test('narrow docked cards keep readable width and siblings retain their own slots', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 }); await page.goto('/demo.html');
  const handle = page.getByRole('button', { name: '移动导航菜单', exact: true });
  await handle.press('Home');
  const narrow = page.locator('.clients-panel'), sibling = page.locator('.trend-panel');
  await narrow.scrollIntoViewIfNeeded();
  const before = await narrow.evaluate(el => ({ width: el.getBoundingClientRect().width, styleWidth: el.style.width, left: el.style.marginLeft, right: el.style.marginRight }));
  const siblingBox = (await sibling.boundingBox())!;
  await handle.press('ArrowRight');
  await expect(narrow).toHaveAttribute('data-menu-avoidance', 'overlap');
  await expect.poll(async () => (await narrow.boundingBox())!.width).toBeLessThan(before.width - 20);
  await expect.poll(async () => Math.round((await page.locator('.feel-navigation').boundingBox())!.x)).toBe(1044);
  await expect(sibling).not.toHaveAttribute('data-menu-avoidance');
  const after = (await narrow.boundingBox())!;
  expect(after.width).toBeGreaterThanOrEqual(Math.min(272, before.width));
  expect(after.width).toBeGreaterThanOrEqual(before.width * 2 / 3 - .1);
  expect((await sibling.boundingBox())!.x).toBeCloseTo(siblingBox.x, 1);
  expect((await sibling.boundingBox())!.width).toBeCloseTo(siblingBox.width, 1);
  await handle.press('Home');
  await expect(narrow).not.toHaveAttribute('data-menu-avoidance');
  expect(await narrow.evaluate(el => ({ width: el.getBoundingClientRect().width, styleWidth: el.style.width, left: el.style.marginLeft, right: el.style.marginRight }))).toEqual(before);
});

test('mobile sheet has three keyboard stops, traps focus, restores scroll and closes on navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/demo.html');
  await page.locator('.feel-nav-peek').click();
  const handle = page.getByRole('button', { name: '调整导航高度', exact: true });
  const dialog = page.getByRole('dialog');
  await expect(handle).toBeFocused();
  await expect.poll(() => page.locator('body').evaluate(el => getComputedStyle(el).overflow)).toBe('hidden');
  await expect.poll(async () => Math.round((await dialog.boundingBox())!.y)).toBe(224);
  await handle.press('ArrowDown');
  await expect.poll(async () => Math.round((await dialog.boundingBox())!.y)).toBe(502);
  await handle.press('ArrowUp');
  await expect.poll(async () => Math.round((await dialog.boundingBox())!.y)).toBe(224);
  await page.keyboard.press('Shift+Tab');
  await expect.poll(() => dialog.evaluate(el => el.contains(document.activeElement))).toBeTruthy();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('.feel-nav-peek')).toBeFocused();
  await expect.poll(() => page.locator('body').evaluate(el => getComputedStyle(el).overflow)).not.toBe('hidden');
  await page.locator('.feel-nav-peek').click();
  await dialog.getByRole('link', { name: '模型分析', exact: false }).click();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test('mobile card touch feedback rebounds and leaves vertical scrolling native', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: String(test.info().project.use.baseURL), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto('/demo.html');
  const card = page.locator('.page-heading[data-feel-card]');
  await expect(card).toBeVisible();
  await expect.poll(() => card.evaluate(el => el.style.getPropertyValue('--feel-avoid-x'))).toBe('0.00px');
  const box = (await card.boundingBox())!, x = box.x + 12, y = box.y + 12;
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= 6; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + i * 14, y }] });
    await page.waitForTimeout(16);
  }
  expect(await card.evaluate(el => parseFloat(el.style.getPropertyValue('--feel-press-x')))).toBeGreaterThan(2);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(() => card.evaluate(el => el.style.getPropertyValue('--feel-press-x'))).toBe('');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y + 60 }] });
  for (let i = 1; i <= 6; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + 60 - i * 18 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(20);
  expect(await card.evaluate(el => el.style.getPropertyValue('--feel-press-x'))).toBe('');
  await context.close();
});

test('reduced motion preserves keyboard placement and mobile drawer controls', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1280, height: 900 }); await page.goto('/demo.html');
  const handle = page.getByRole('button', { name: '移动导航菜单', exact: true });
  await handle.press('End');
  await expect.poll(async () => Math.round((await page.locator('.feel-navigation').boundingBox())!.x)).toBe(1044);
  expect(await page.locator('[data-feel-card][data-feel-moving="true"]').count()).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 }); await page.locator('.feel-nav-peek').click();
  await expect(page.getByRole('button', { name: '调整导航高度', exact: true })).toBeFocused();
  await page.keyboard.press('End'); await expect(page.getByRole('dialog')).toBeHidden();
});

test('dragging only the mobile sheet actively repels cards, preserves control gaps and restores native scrolling', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: String(test.info().project.use.baseURL), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto('/demo.html');
  const card = page.locator('.clients-panel'), preceding = page.locator('.trend-panel');
  await expect(card).toBeVisible();
  // A natural page position with seven pixels before the half-height sheet.
  // The existing 18px inter-card gap permits a 10px move while retaining 8px.
  await card.evaluate(el => window.scrollBy(0, el.getBoundingClientRect().bottom - 495));
  await expect.poll(() => card.evaluate(el => parseFloat(el.style.getPropertyValue('--feel-avoid-y')))).toBe(0);
  const before = await card.evaluate(el => ({ rect: el.getBoundingClientRect().toJSON(), width: el.style.width, ml: el.style.marginLeft, mr: el.style.marginRight }));
  const beforeScroll = await page.evaluate(() => window.scrollY);
  const cdp = await context.newCDPSession(page), peek = (await page.locator('.feel-nav-peek').boundingBox())!;
  const x = peek.x + peek.width / 2, y = peek.y + peek.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let index = 1; index <= 10; index++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - index * 26 }] });
    await page.waitForTimeout(18);
  }
  // A stationary release chooses the nearest stop, rather than a flick target.
  await page.waitForTimeout(110);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const dialog = page.getByRole('dialog');
  await expect.poll(async () => Math.round((await dialog.boundingBox())!.y)).toBe(502);
  await expect.poll(() => card.evaluate(el => parseFloat(el.style.getPropertyValue('--feel-avoid-y')))).toBeLessThan(-9.9);
  const after = await card.evaluate(el => ({ rect: el.getBoundingClientRect().toJSON(), width: el.style.width, ml: el.style.marginLeft, mr: el.style.marginRight, pressX: el.style.getPropertyValue('--feel-press-x'), pressY: el.style.getPropertyValue('--feel-press-y') }));
  expect(after.pressX).toBe(''); expect(after.pressY).toBe('');
  expect(after.rect.x).toBe(before.rect.x); expect(after.rect.width).toBe(before.rect.width);
  expect([after.width, after.ml, after.mr]).toEqual([before.width, before.ml, before.mr]);
  expect((await dialog.boundingBox())!.y - after.rect.bottom).toBeGreaterThanOrEqual(16);
  const previousBox = (await preceding.boundingBox())!;
  expect(after.rect.top - (previousBox.y + previousBox.height)).toBeGreaterThanOrEqual(7.9);
  expect(after.rect.top).toBeGreaterThanOrEqual(12);
  expect(await page.evaluate(() => window.scrollY)).toBe(beforeScroll);
  await page.screenshot({ path: 'evidence/feel-mobile-avoidance-390.png', animations: 'disabled' });
  await page.keyboard.press('Escape'); await expect(dialog).toBeHidden();
  await expect.poll(() => card.evaluate(el => parseFloat(el.style.getPropertyValue('--feel-avoid-y')))).toBe(0);
  expect(await card.evaluate(el => ({ rect: el.getBoundingClientRect().toJSON(), width: el.style.width, ml: el.style.marginLeft, mr: el.style.marginRight }))).toEqual(before);
  await page.screenshot({ path: 'evidence/feel-mobile-avoidance-restored-390.png', animations: 'disabled' });
  const startY = before.rect.top + 100;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: before.rect.x + 10, y: startY }] });
  for (let index = 1; index <= 6; index++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: before.rect.x + 10, y: startY - index * 18 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(beforeScroll + 20);
  await context.close();
});

test('reduced motion applies mobile sheet avoidance immediately and releases it on close', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/demo.html'); const card = page.locator('.clients-panel');
  await card.evaluate(el => window.scrollBy(0, el.getBoundingClientRect().bottom - 495));
  const before = (await card.boundingBox())!;
  await page.locator('.feel-nav-peek').click();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  expect(await card.evaluate(el => parseFloat(el.style.getPropertyValue('--feel-avoid-y')))).toBe(-10);
  expect((await card.boundingBox())!.width).toBe(before.width);
  await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  expect(await card.evaluate(el => parseFloat(el.style.getPropertyValue('--feel-avoid-y')))).toBe(0);
});

test('nested model records react independently, remain clickable and return to rest when the menu is folded', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await page.goto('/demo.html#models');
  const handle = page.getByRole('button', { name: '移动导航菜单', exact: true });
  await handle.press('End');
  const panel = page.locator('.models-panel');
  await panel.evaluate(el => window.scrollBy(0, el.getBoundingClientRect().top - 240));
  const rows = panel.locator('tbody > tr[data-feel-item="row"]'), row = rows.first();
  await expect(row).toHaveAttribute('data-feel-item-active', 'true');
  await expect.poll(() => row.evaluate(el => parseFloat(el.style.getPropertyValue('--feel-item-x')))).toBeLessThan(-1);
  const response = await row.evaluate(el => ({ x: parseFloat(el.style.getPropertyValue('--feel-item-x')), scale: parseFloat(el.style.getPropertyValue('--feel-item-scale')), width: el.style.width, outer: el.style.getPropertyValue('--feel-avoid-x') }));
  expect(response.x).toBeGreaterThanOrEqual(-7); expect(response.scale).toBeGreaterThanOrEqual(.988); expect(response.scale).toBeLessThan(1);
  expect(response.width).toBe(''); expect(response.outer).toBe('');
  await expect(panel).toHaveAttribute('data-menu-avoidance', 'clear');
  await expect(rows.last()).not.toHaveAttribute('data-feel-item-active');
  await page.waitForTimeout(700);
  await page.screenshot({ path: 'evidence/feel-nested-models-1440.png' });
  await row.getByRole('button', { name: /查看 .* 详情/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.getByRole('dialog').locator('[data-feel-item-active]').count()).toBe(0);
  await page.keyboard.press('Escape');
  await handle.press('Home'); await page.getByRole('button', { name: '收起导航', exact: true }).click();
  await expect(row).not.toHaveAttribute('data-feel-item-active');
  expect(await row.evaluate(el => ['--feel-item-x', '--feel-item-y', '--feel-item-scale'].map(key => el.style.getPropertyValue(key)))).toEqual(['', '', '']);
  await expect(panel).not.toHaveAttribute('data-menu-avoidance');
});

test('nearby heatmap cells keep a bounded separate response and preserve pointer tooltips and keyboard dismissal', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await page.goto('/demo.html#models');
  await page.getByRole('button', { name: '移动导航菜单', exact: true }).press('End');
  const panel = page.locator('.matrix-panel');
  await panel.evaluate(el => window.scrollBy(0, el.getBoundingClientRect().top - 260));
  const active = panel.locator('.matrix-cell[data-feel-item-active="true"]');
  await expect.poll(() => active.count()).toBeGreaterThan(0);
  const cells = await active.evaluateAll(elements => elements.map(el => ({ x: parseFloat((el as HTMLElement).style.getPropertyValue('--feel-item-x')), y: parseFloat((el as HTMLElement).style.getPropertyValue('--feel-item-y')), scale: parseFloat((el as HTMLElement).style.getPropertyValue('--feel-item-scale')) })));
  expect(cells.every(cell => Math.hypot(cell.x, cell.y) <= 1.801 && cell.scale >= .985 && cell.scale < 1)).toBeTruthy();
  const far = panel.locator('.matrix-cell').first();
  await expect(far).not.toHaveAttribute('data-feel-item-active');
  await page.waitForTimeout(700); await page.screenshot({ path: 'evidence/feel-nested-heatmap-1440.png' });
  const cell = active.first();
  await cell.hover(); await expect(page.locator('.metric-tooltip-card')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.locator('.metric-tooltip-card')).toHaveCount(0);
  await page.mouse.move(0, 0); await cell.click(); await expect(page.locator('.metric-tooltip-card')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.locator('.metric-tooltip-card')).toHaveCount(0);
});

test('opening existing details recalculates inner targets, then decorative frames stop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 }); await page.goto('/demo.html');
  await page.getByRole('button', { name: '移动导航菜单', exact: true }).press('Home');
  await page.getByRole('button', { name: '移动导航菜单', exact: true }).press('ArrowRight');
  await expect.poll(async () => Math.round((await page.locator('.feel-navigation').boundingBox())!.x)).toBe(1044);
  // A details element changes the existing parent's height without inserting
  // nodes. Both target positions remain fully visible, so visibility does not
  // invalidate the targets on behalf of the size observer.
  await page.evaluate(() => {
    const menu = document.querySelector('.feel-navigation')!.getBoundingClientRect();
    const fixture = document.createElement('section');
    fixture.id = 'feel-size-fixture'; fixture.dataset.feelCard = '';
    fixture.style.cssText = `position:fixed;left:600px;top:${menu.bottom - 180}px;width:400px;z-index:20;background:white`;
    fixture.innerHTML = '<details><summary style="height:40px">展开既有内容</summary><div style="height:180px">已有说明</div></details><button data-feel-item="row" style="display:block;width:calc(100% - 20px);margin-left:20px;height:50px">保持可点击的记录</button>';
    document.querySelector('.app-shell')!.append(fixture);
  });
  const row = page.locator('#feel-size-fixture [data-feel-item]');
  await expect.poll(() => row.evaluate(el => parseFloat(el.style.getPropertyValue('--feel-item-x')))).toBeLessThan(-5);
  await page.waitForTimeout(700);
  const before = await row.evaluate(el => parseFloat(el.style.getPropertyValue('--feel-item-x')));
  await page.locator('#feel-size-fixture summary').click();
  await expect.poll(() => row.evaluate(el => parseFloat(el.style.getPropertyValue('--feel-item-x')))).toBeGreaterThan(before + 1);
  await page.waitForTimeout(1100);
  const settled = await page.evaluate(async () => {
    const fixture = document.querySelector('#feel-size-fixture')!, row = fixture.querySelector<HTMLElement>('[data-feel-item]')!;
    let writes = 0; const observer = new MutationObserver(records => { writes += records.length; });
    observer.observe(fixture, { attributes: true, attributeFilter: ['style'], subtree: true });
    const before = row.style.cssText;
    for (let i = 0; i < 60; i++) await new Promise(requestAnimationFrame);
    observer.disconnect(); return { writes, same: before === row.style.cssText };
  });
  expect(settled).toEqual({ writes: 0, same: true });
  await row.click(); await expect(row).toBeFocused();
  await page.locator('#feel-size-fixture').evaluate(el => el.remove());
  await page.evaluate(() => window.scrollBy(0, 240));
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
});

test('reduced motion clears inner row and cell decoration', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await page.goto('/demo.html#models');
  await page.getByRole('button', { name: '移动导航菜单', exact: true }).press('End');
  await page.locator('.models-panel').evaluate(el => window.scrollBy(0, el.getBoundingClientRect().top - 240));
  await expect.poll(() => page.locator('[data-feel-item-active]').count()).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('[data-feel-item-active]')).toHaveCount(0);
  await page.locator('.matrix-panel').evaluate(el => window.scrollBy(0, el.getBoundingClientRect().top - 260));
  await page.evaluate(() => new Promise(requestAnimationFrame));
  expect(await page.locator('[data-feel-item-active]').count()).toBe(0);
});

test('mobile navigation returns to its actual opener without scrolling the background', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/demo.html#overview');
  const top = page.getByRole('button', { name: '打开导航', exact: true }), peek = page.locator('.feel-nav-peek');
  const dialog = page.getByRole('dialog', { name: '导航', exact: true });
  await top.press('Enter'); await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape'); await expect(dialog).toBeHidden(); await expect(top).toBeFocused();
  await page.evaluate(() => window.scrollTo({ top: 920, behavior: 'instant' }));
  const before = await page.evaluate(() => window.scrollY); expect(before).toBeGreaterThan(500);
  for (const activation of ['click', 'Enter', 'ArrowUp', 'drag'] as const) {
    if (activation === 'click') await peek.click();
    else if (activation === 'drag') {
      const box = (await peek.boundingBox())!, x = box.x + box.width / 2, y = box.y + box.height / 2;
      await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x, y - 260, { steps: 10 });
      await page.waitForTimeout(110); await page.mouse.up();
    } else await peek.press(activation);
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBe(before);
    if (activation === 'Enter') await dialog.getByRole('button', { name: '关闭导航', exact: true }).click();
    else if (activation === 'drag') await dialog.getByRole('link', { name: '总览', exact: true }).click();
    else await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden(); await expect(peek).toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBe(before);
  }
  await peek.click(); await dialog.locator('a[href="#models"]').click();
  await expect(dialog).toBeHidden(); await expect(page).toHaveURL(/#models$/); await expect(peek).toBeFocused();
});

test('closing navigation for workspace settings leaves focus inside the new dialog', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/demo.html#overview');
  await page.evaluate(() => window.scrollTo({ top: 920, behavior: 'instant' }));
  const before = await page.evaluate(() => window.scrollY);
  await page.locator('.feel-nav-peek').click();
  const navigation = page.getByRole('dialog', { name: '导航', exact: true });
  await navigation.getByRole('button', { name: '工作区设置', exact: true }).click();
  await expect(navigation).toBeHidden();
  const settings = page.getByRole('dialog', { name: '演示工作区', exact: true });
  await expect(settings).toBeVisible();
  await expect.poll(() => settings.evaluate(el => el.contains(document.activeElement))).toBeTruthy();
  await page.waitForTimeout(150);
  expect(await settings.evaluate(el => el.contains(document.activeElement))).toBeTruthy();
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
});

test('navigation focus falls back when its opener disappears or the layout changes to desktop', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/demo.html#overview');
  const top = page.getByRole('button', { name: '打开导航', exact: true });
  await page.locator('.feel-nav-peek').click();
  await expect(page.getByRole('dialog', { name: '导航', exact: true })).toBeVisible();
  await page.locator('.feel-nav-peek').evaluate(el => el.remove());
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0); await expect(top).toBeFocused();
  await page.reload(); await page.locator('.feel-nav-peek').click();
  await expect(page.getByRole('dialog', { name: '导航', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '移动导航菜单', exact: true })).toBeFocused();
});
