import { test, expect, type CDPSession, type Locator, type Page } from '@playwright/test';
import { waitForReveal } from './motion-helpers';

const box = async (locator: Locator) => (await locator.boundingBox())!;
const layout = (el: Element) => { const { style } = el as HTMLElement; return { width: el.getBoundingClientRect().width, styleWidth: style.width, left: style.marginLeft, right: style.marginRight }; };
const avoidY = (el: Element) => parseFloat((el as HTMLElement).style.getPropertyValue('--feel-avoid-y')) || 0;
const itemProperties = (el: Element) => ['--feel-item-x', '--feel-item-y', '--feel-item-scale'].map(key => (el as HTMLElement).style.getPropertyValue(key));

/** Scroll a card to `top` px below the viewport edge once it has risen into view. */
async function scrollCardTo(card: Locator, top: number) {
  await card.scrollIntoViewIfNeeded();
  await waitForReveal(card);
  await card.evaluate((el, top) => window.scrollBy({ top: el.getBoundingClientRect().top - top, behavior: 'instant' }), top);
}

/** Press the desktop menu's grip and nudge it without letting go: inner
 * records answer the menu only while it is dragged or still springing. */
async function holdMenu(page: Page) {
  const grip = await box(page.getByRole('button', { name: '移动导航菜单', exact: true }));
  const x = grip.x + 15, y = grip.y + grip.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x, y + 10, { steps: 2 }); await page.mouse.move(x, y, { steps: 2 });
  await expect(page.locator('.feel-navigation')).toHaveAttribute('data-dragging', 'true');
}

test('floating navigation supports throwing, corner keys and persistent card avoidance', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/demo.html');
  const handle = page.getByRole('button', { name: '移动导航菜单', exact: true });
  const nav = page.locator('.feel-navigation');
  // 216px wide and 16px from every edge: the right column starts at 1280 - 216 - 16.
  await handle.press('End');
  await expect.poll(async () => Math.round((await box(nav)).x)).toBe(1048);
  await expect.poll(async () => Math.round((await box(nav)).y + (await box(nav)).height)).toBe(884);
  expect(Math.round((await box(nav)).width)).toBe(216);
  // The grip is the transparent 28px strip across the top of the menu.
  expect(Math.round((await box(handle)).height)).toBe(28);
  const wide = page.locator('.page-heading');
  await expect(wide).not.toHaveAttribute('data-menu-avoidance');
  const originalWide = await wide.evaluate(layout);
  await handle.press('Home');
  await expect.poll(async () => { const b = await box(nav); return [Math.round(b.x), Math.round(b.y)]; }).toEqual([16, 16]);
  await handle.press('ArrowRight');
  await expect.poll(async () => Math.round((await box(nav)).x)).toBe(1048);
  await expect.poll(async () => (await box(wide)).x + (await box(wide)).width - (await box(nav)).x).toBeLessThanOrEqual(-15.5);
  expect((await box(wide)).width).toBeGreaterThanOrEqual(originalWide.width * 2 / 3);
  await expect(wide).toHaveAttribute('data-menu-avoidance', 'clear');
  const topbar = page.locator('.app-topbar');
  await expect.poll(async () => (await box(topbar)).x + (await box(topbar)).width - (await box(nav)).x).toBeLessThanOrEqual(-15.5);
  await page.screenshot({ path: 'evidence/feel-desktop-avoidance-right.png', fullPage: false });
  const displaced = await page.locator('[data-feel-card]').evaluateAll(elements => elements.map(el => {
    const rect = el.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width };
  }));
  expect(displaced.every(rect => rect.left >= 0 && rect.right <= 1280)).toBeTruthy();
  // Once its spring has settled, a card makes room with its width alone: no
  // transform or layer of its own.
  await expect(wide).not.toHaveAttribute('data-feel-moving');
  expect(await wide.evaluate(el => [(el as HTMLElement).style.translate, (el as HTMLElement).style.scale, getComputedStyle(el).willChange])).toEqual(['', '', 'auto']);
  // A mouse drag moves the menu without leaving a keyboard focus ring on the grip.
  await handle.evaluate(el => (el as HTMLElement).blur());
  const grip = await box(handle);
  await page.mouse.move(grip.x + 15, grip.y + grip.height / 2); await page.mouse.down();
  await page.mouse.move(120, 740, { steps: 16 });
  await expect(nav).toHaveAttribute('data-dragging', 'true');
  await page.mouse.up();
  await expect(nav).toHaveAttribute('data-dragging', 'false');
  await expect.poll(async () => Math.round((await box(nav)).x)).toBe(16);
  await expect.poll(async () => Math.abs((await box(nav)).y + (await box(nav)).height - 884)).toBeLessThan(2);
  expect(await handle.evaluate(el => el.matches(':focus-visible'))).toBe(false);
  // Enter and Space carry the menu on to the next corner, clockwise.
  await handle.press('Enter');
  await expect.poll(async () => { const b = await box(nav); return [Math.round(b.x), Math.round(b.y)]; }).toEqual([16, 16]);
  await handle.press(' ');
  await expect.poll(async () => { const b = await box(nav); return [Math.round(b.x), Math.round(b.y)]; }).toEqual([1048, 16]);
  await handle.press('End');
  await expect(wide).not.toHaveAttribute('data-menu-avoidance');
  expect(await wide.evaluate(layout)).toEqual(originalWide);
});

test('narrow docked cards keep readable width and siblings retain their own slots', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1200 }); await page.goto('/demo.html');
  const handle = page.getByRole('button', { name: '移动导航菜单', exact: true });
  await handle.press('End');
  const narrow = page.locator('.clients-panel'), sibling = page.locator('.trend-panel');
  await scrollCardTo(narrow, 32);
  await waitForReveal(sibling);
  await expect(narrow).not.toHaveAttribute('data-menu-avoidance');
  await expect(sibling).not.toHaveAttribute('data-menu-avoidance');
  const before = await narrow.evaluate(layout);
  const siblingBox = await box(sibling);
  await handle.press('Home'); await handle.press('ArrowRight');
  await expect(narrow).toHaveAttribute('data-menu-avoidance', 'overlap');
  await expect.poll(async () => (await box(narrow)).width).toBeLessThan(before.width - 20);
  await expect.poll(async () => Math.round((await box(page.locator('.feel-navigation'))).x)).toBe(1048);
  await expect(sibling).not.toHaveAttribute('data-menu-avoidance');
  const after = await box(narrow);
  expect(after.width).toBeGreaterThanOrEqual(Math.min(272, before.width));
  expect(after.width).toBeGreaterThanOrEqual(before.width * 2 / 3 - .1);
  expect((await box(sibling)).x).toBeCloseTo(siblingBox.x, 1);
  expect((await box(sibling)).width).toBeCloseTo(siblingBox.width, 1);
  await handle.press('End');
  await expect(narrow).not.toHaveAttribute('data-menu-avoidance');
  expect(await narrow.evaluate(layout)).toEqual(before);
});

// Product bug, left for the fix: lib/feel-cards.ts measure() reads each card's
// slot with getBoundingClientRect() while scroll reveal still holds a
// below-the-fold card at scale(.98) (motion.css [data-reveal="pending"]). Such a
// card later makes room from a slot 2% too narrow, so beside the menu it stops
// about 11px short of the 16px line the other cards keep, until some unrelated
// element insertion re-measures it.
test('a card that rises into view after load makes room from its full slot', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 }); await page.goto('/demo.html');
  const handle = page.getByRole('button', { name: '移动导航菜单', exact: true });
  await handle.press('Home'); await handle.press('ArrowRight');
  await expect.poll(async () => Math.round((await box(page.locator('.feel-navigation'))).x)).toBe(1048);
  const lower = page.locator('.models-panel');
  await expect(lower).toHaveAttribute('data-reveal', 'pending');
  await scrollCardTo(lower, 120);
  await expect(lower).toHaveAttribute('data-menu-avoidance', 'clear');
  // Every card beside the right-hand menu ends 16px before it, at x = 1032.
  await expect.poll(async () => { const b = await box(lower); return Math.round(b.x + b.width); }).toBe(1032);
});

test('mobile sheet has three keyboard stops, traps focus, restores scroll and closes on navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/demo.html');
  const surface = page.locator('.feel-nav-drawer');
  await page.locator('.feel-nav-peek').click();
  const handle = page.getByRole('button', { name: '调整导航高度', exact: true });
  const dialog = page.getByRole('dialog');
  await expect(handle).toBeFocused();
  await expect.poll(() => page.locator('body').evaluate(el => getComputedStyle(el).overflow)).toBe('hidden');
  await expect(surface).toHaveAttribute('data-drawer-stop', 'half');
  await handle.press('ArrowUp');
  await expect(surface).toHaveAttribute('data-drawer-stop', 'open');
  // Fully open, the panel holds the whole menu, docked to the bottom edge
  // and reaching 48px below it.
  const openHeight = await surface.evaluate(el => parseFloat((el as HTMLElement).style.getPropertyValue('--nav-open-height')));
  expect(openHeight).toBeGreaterThan(84); expect(openHeight).toBeLessThanOrEqual(844 - 24);
  await expect.poll(async () => Math.round((await box(dialog)).y)).toBe(844 - openHeight);
  expect(Math.round((await box(dialog)).height)).toBe(openHeight + 48);
  await handle.press('ArrowDown');
  await expect(surface).toHaveAttribute('data-drawer-stop', 'half');
  await page.keyboard.press('Shift+Tab');
  await expect.poll(() => dialog.evaluate(el => el.contains(document.activeElement))).toBeTruthy();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('.feel-nav-peek')).toBeFocused();
  await expect.poll(() => page.locator('body').evaluate(el => getComputedStyle(el).overflow)).not.toBe('hidden');
  await page.locator('.feel-nav-peek').click();
  await dialog.getByRole('navigation', { name: '常用页面', exact: true }).getByRole('link', { name: '模型分析', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test('mobile card touch feedback rebounds and leaves vertical scrolling native', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: String(test.info().project.use.baseURL), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto('/demo.html');
  const card = page.locator('.page-heading[data-feel-card]');
  await expect(card).toBeVisible();
  const pressed = () => card.evaluate(el => { const { style } = el as HTMLElement; return [style.translate, style.rotate, style.scale].join(''); });
  // At rest a card carries no transform and no layer of its own.
  await expect.poll(pressed).toBe('');
  expect(await card.evaluate(el => getComputedStyle(el).willChange)).toBe('auto');
  // Record the strongest pull the elastic feedback writes during each gesture.
  await card.evaluate(el => {
    const pull = { x: 0, y: 0 };
    (window as unknown as { pull: typeof pull }).pull = pull;
    new MutationObserver(() => {
      const [x = '0', y = '0'] = (el as HTMLElement).style.translate.split(' ');
      pull.x = Math.max(pull.x, Math.abs(parseFloat(x) || 0)); pull.y = Math.max(pull.y, Math.abs(parseFloat(y) || 0));
    }).observe(el, { attributes: true, attributeFilter: ['style'] });
  });
  const readPull = () => page.evaluate(() => { const w = window as unknown as { pull: { x: number; y: number } }; const value = { ...w.pull }; w.pull.x = w.pull.y = 0; return value; });
  const box0 = await box(card), x = box0.x + 12, y = box0.y + 12;
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= 6; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + i * 14, y }] });
    await page.waitForTimeout(16);
  }
  // A horizontal pull follows the finger sideways only.
  const sideways = await readPull();
  expect(sideways.x).toBeGreaterThan(2); expect(sideways.y).toBe(0);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(pressed).toBe('');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y + 60 }] });
  for (let i = 1; i <= 6; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + 60 - i * 18 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(20);
  expect(await readPull()).toEqual({ x: 0, y: 0 });
  expect(await pressed()).toBe('');
  await context.close();
});

test('reduced motion preserves keyboard placement and mobile drawer controls', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1280, height: 900 }); await page.goto('/demo.html');
  const handle = page.getByRole('button', { name: '移动导航菜单', exact: true });
  await handle.press('End');
  await expect.poll(async () => Math.round((await box(page.locator('.feel-navigation'))).x)).toBe(1048);
  expect(await page.locator('[data-feel-card][data-feel-moving="true"]').count()).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 }); await page.locator('.feel-nav-peek').click();
  await expect(page.getByRole('button', { name: '调整导航高度', exact: true })).toBeFocused();
  await page.keyboard.press('End'); await expect(page.getByRole('dialog')).toBeHidden();
});

/** Phones space cards 16px apart (surface.css --gap), so a card may rise 8px
 * and still keep 8px before its predecessor. Placed 9px above the half-open
 * drawer, it needs 7px to keep its 16px clearance and takes all 8. */
const PHONE_CARD_GAP = 16, CARD_RISE = PHONE_CARD_GAP - 8, ABOVE_HALF_STOP = 9;
/** The top of the half-open drawer: an 84px tab bar plus half of the menu above it. */
const halfStopTop = (surface: Locator) => surface.evaluate(el => {
  const open = parseFloat((el as HTMLElement).style.getPropertyValue('--nav-open-height'));
  return innerHeight - (84 + (open - 84) / 2);
});

test('dragging only the mobile sheet actively repels cards, preserves control gaps and restores native scrolling', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: String(test.info().project.use.baseURL), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto('/demo.html');
  const card = page.locator('.clients-panel'), preceding = page.locator('.trend-panel'), surface = page.locator('.feel-nav-drawer');
  await expect(card).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  await waitForReveal(card); await waitForReveal(preceding);
  expect(Math.round((await box(card)).y - ((await box(preceding)).y + (await box(preceding)).height))).toBe(PHONE_CARD_GAP);
  // A natural page position a few pixels above the half-height sheet.
  const halfTop = await halfStopTop(surface);
  await card.evaluate((el, bottom) => window.scrollBy({ top: el.getBoundingClientRect().bottom - bottom, behavior: 'instant' }), halfTop - ABOVE_HALF_STOP);
  await expect.poll(() => card.evaluate(avoidY)).toBe(0);
  const before = await card.evaluate(el => ({ rect: el.getBoundingClientRect().toJSON(), width: (el as HTMLElement).style.width, ml: (el as HTMLElement).style.marginLeft, mr: (el as HTMLElement).style.marginRight }));
  const beforeScroll = await page.evaluate(() => window.scrollY);
  const cdp = await context.newCDPSession(page), peek = await box(page.locator('.feel-nav-peek'));
  const travel = await surface.evaluate(el => parseFloat((el as HTMLElement).style.getPropertyValue('--nav-open-height')) - 84);
  const x = peek.x + peek.width / 2, y = peek.y + peek.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let index = 1; index <= 10; index++) {
    // Ten steps that end a little short of the half stop.
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - index * travel * .045 }] });
    await page.waitForTimeout(18);
  }
  // A stationary release chooses the nearest stop, rather than a flick target.
  await page.waitForTimeout(110);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const dialog = page.getByRole('dialog');
  await expect(surface).toHaveAttribute('data-drawer-stop', 'half');
  await expect.poll(() => card.evaluate(avoidY)).toBeLessThan(-(CARD_RISE - .1));
  const after = await card.evaluate(el => { const { style } = el as HTMLElement; return { rect: el.getBoundingClientRect().toJSON(), width: style.width, ml: style.marginLeft, mr: style.marginRight, elastic: [style.translate, style.rotate, style.scale].join('') }; });
  expect(after.elastic).toBe('');
  expect(after.rect.x).toBe(before.rect.x); expect(after.rect.width).toBe(before.rect.width);
  expect([after.width, after.ml, after.mr]).toEqual([before.width, before.ml, before.mr]);
  expect((await box(dialog)).y - after.rect.bottom).toBeGreaterThanOrEqual(16);
  const previousBox = await box(preceding);
  expect(after.rect.top - (previousBox.y + previousBox.height)).toBeGreaterThanOrEqual(7.9);
  expect(after.rect.top).toBeGreaterThanOrEqual(12);
  expect(await page.evaluate(() => window.scrollY)).toBe(beforeScroll);
  await page.screenshot({ path: 'evidence/feel-mobile-avoidance-390.png', animations: 'disabled' });
  await page.keyboard.press('Escape'); await expect(dialog).toBeHidden();
  await expect.poll(() => card.evaluate(avoidY)).toBe(0);
  await expect.poll(() => card.evaluate(el => ({ rect: el.getBoundingClientRect().toJSON(), width: (el as HTMLElement).style.width, ml: (el as HTMLElement).style.marginLeft, mr: (el as HTMLElement).style.marginRight }))).toEqual(before);
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

/** Touch-drag from the middle of `target` up by `distance` px without letting go. */
async function pressAndDrag(page: Page, cdp: CDPSession, target: Locator, distance: number, steps: number) {
  const grip = await box(target), x = grip.x + grip.width / 2, y = grip.y + grip.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let index = 1; index <= steps; index++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - distance * index / steps }] });
    await page.waitForTimeout(18);
  }
}
/** Lift the finger after holding still, so the release picks the nearest stop. */
async function releaseStill(page: Page, cdp: CDPSession) {
  await page.waitForTimeout(110);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test('a nudge on the half-open sheet keeps the menu where it was scrolled', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: String(test.info().project.use.baseURL), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto('/demo.html');
  const surface = page.locator('.feel-nav-drawer'), menu = surface.locator('.feel-nav-content');
  const cdp = await context.newCDPSession(page);
  const travel = await surface.evaluate(el => parseFloat((el as HTMLElement).style.getPropertyValue('--nav-open-height')) - 84);
  await pressAndDrag(page, cdp, page.locator('.feel-nav-peek'), travel * .45, 10);
  await releaseStill(page, cdp);
  await expect(surface).toHaveAttribute('data-drawer-stop', 'half');
  await expect(surface).not.toHaveAttribute('data-drawer-moving', 'true');
  expect(await menu.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(120);
  await menu.evaluate(el => { el.scrollTop = 120; });
  await pressAndDrag(page, cdp, surface.locator('.feel-sheet-handle'), 6, 3);
  await expect(surface).toHaveAttribute('data-drawer-moving', 'true');
  // The list does not jump while the sheet moves, and stays put once it rests.
  expect(await menu.evaluate(el => el.scrollTop)).toBe(120);
  await releaseStill(page, cdp);
  await expect(surface).toHaveAttribute('data-drawer-stop', 'half');
  await expect(surface).not.toHaveAttribute('data-drawer-moving', 'true');
  expect(await menu.evaluate(el => el.scrollTop)).toBe(120);
  await context.close();
});

test('records inside a rising card group answer from where they are, not where they were', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: String(test.info().project.use.baseURL), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto('/demo.html#devices');
  const group = page.locator('.sv-device-grid'), surface = page.locator('.feel-nav-drawer');
  await expect(group.locator('[data-feel-item]').first()).toBeVisible();
  await group.scrollIntoViewIfNeeded(); await waitForReveal(group);
  const halfTop = await halfStopTop(surface);
  await group.evaluate((el, bottom) => window.scrollBy({ top: el.getBoundingClientRect().bottom - bottom, behavior: 'instant' }), halfTop - ABOVE_HALF_STOP);
  await expect.poll(() => group.evaluate(avoidY)).toBe(0);
  // Cards that scrolled into view finish rising first: each step of a reveal
  // re-measures everything, which would refresh stale boxes on its own.
  await expect.poll(() => page.evaluate(() => !document.querySelector('[data-reveal="shown"]')
    && [...document.querySelectorAll('[data-reveal="pending"]')].every(el => el.getBoundingClientRect().top >= innerHeight * .9))).toBe(true);
  const cdp = await context.newCDPSession(page);
  const travel = await surface.evaluate(el => parseFloat((el as HTMLElement).style.getPropertyValue('--nav-open-height')) - 84);
  // Hold the sheet just short of the half stop: the group rises after its
  // records first answered the sheet.
  await pressAndDrag(page, cdp, page.locator('.feel-nav-peek'), travel * .45, 10);
  const snapshot = () => group.evaluate(el => ({
    rise: parseFloat((el as HTMLElement).style.getPropertyValue('--feel-avoid-y')) || 0,
    records: [...el.querySelectorAll<HTMLElement>('[data-feel-item]')].map(item => ['--feel-item-x', '--feel-item-y', '--feel-item-scale'].map(key => parseFloat(item.style.getPropertyValue(key)) || 0)),
  }));
  const settled = async () => {
    let previous = JSON.stringify(await snapshot());
    for (let attempt = 0; attempt < 20; attempt++) {
      await page.waitForTimeout(150);
      const next = JSON.stringify(await snapshot());
      if (next === previous) return JSON.parse(next) as Awaited<ReturnType<typeof snapshot>>;
      previous = next;
    }
    throw new Error('records kept moving');
  };
  const held = await settled();
  expect(held.rise).toBeLessThan(-(CARD_RISE - .1));
  expect(held.records.some(([, y]) => y < -.5)).toBe(true);
  const unchanged = (next: typeof held) => next.records.forEach((record, index) => record.forEach((value, axis) => expect(Math.abs(value - held.records[index][axis])).toBeLessThan(.05)));
  // A scroll event reads every box again: records that followed the group's
  // rise keep the same answer.
  await page.evaluate(() => document.dispatchEvent(new Event('scroll')));
  unchanged(await settled());
  // So does a full re-measure (a card added or removed) while the group is up.
  await page.evaluate(() => { const probe = document.createElement('i'); document.querySelector('.app-shell')!.append(probe); probe.remove(); });
  unchanged(await settled());
  await releaseStill(page, cdp);
  await context.close();
});

test('a menu scrolled to its end at the half stop opens without a jump', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: String(test.info().project.use.baseURL), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto('/demo.html#overview');
  const surface = page.locator('.feel-nav-drawer');
  const menu = page.getByRole('dialog', { name: '导航', exact: true }).getByRole('navigation', { name: '页面导航', exact: true });
  await page.locator('.feel-nav-peek').tap();
  await expect(surface).toHaveAttribute('data-drawer-stop', 'half');
  // At rest the menu's box ends at the tab bar, so the rows the half stop
  // hides scroll up into view.
  await menu.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(menu.getByRole('button', { name: '工作区设置', exact: true })).toBeInViewport();
  // The last row stays in place while the panel opens above it, and nothing
  // jumps when the panel comes to rest.
  const path = await menu.evaluate(async el => {
    const last = [...el.querySelectorAll('button')].at(-1)!, bottoms: number[] = [];
    (document.querySelector('.feel-nav-peek') as HTMLElement).click();
    const drawer = document.querySelector<HTMLElement>('.feel-nav-drawer')!;
    for (let i = 0; i < 90 && drawer.dataset.drawerStop !== 'open'; i++) { await new Promise(requestAnimationFrame); bottoms.push(last.getBoundingClientRect().bottom); }
    for (let i = 0; i < 5; i++) { await new Promise(requestAnimationFrame); bottoms.push(last.getBoundingClientRect().bottom); }
    return { bottoms, scrollTop: el.scrollTop, stop: drawer.dataset.drawerStop };
  });
  expect(path.stop).toBe('open');
  expect(path.scrollTop).toBe(0);
  // Only the magnet's swing of a few px at the open stop, never the ~200px
  // a clamped scroll position would jump.
  const spread = Math.max(...path.bottoms) - Math.min(...path.bottoms);
  expect(spread).toBeLessThan(8);
  await context.close();
});

test('a moving drawer writes nothing that rows inherit, so a rising card restyles alone', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: String(test.info().project.use.baseURL), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto('/demo.html');
  const card = page.locator('.clients-panel'), surface = page.locator('.feel-nav-drawer');
  await card.scrollIntoViewIfNeeded(); await waitForReveal(card);
  const halfTop = await halfStopTop(surface);
  await card.evaluate((el, bottom) => window.scrollBy({ top: el.getBoundingClientRect().bottom - bottom, behavior: 'instant' }), halfTop - ABOVE_HALF_STOP);
  // The name of every inline style property that changes while the panel moves.
  await page.evaluate(() => {
    const names = new Set<string>();
    const parse = (text: string | null) => new Map((text || '').split(';').map(part => part.split(':')).filter(pair => pair.length > 1).map(([name, ...value]) => [name.trim(), value.join(':').trim()]));
    new MutationObserver(records => {
      for (const record of records) {
        const before = parse(record.oldValue), after = parse((record.target as Element).getAttribute('style'));
        for (const name of new Set([...before.keys(), ...after.keys()])) if (before.get(name) !== after.get(name)) names.add(name);
      }
    }).observe(document.body, { attributes: true, attributeFilter: ['style'], attributeOldValue: true, subtree: true });
    (window as unknown as { __styleNames: Set<string> }).__styleNames = names;
  });
  const cdp = await context.newCDPSession(page), peek = await box(page.locator('.feel-nav-peek'));
  const travel = await surface.evaluate(el => parseFloat((el as HTMLElement).style.getPropertyValue('--nav-open-height')) - 84);
  const x = peek.x + peek.width / 2, y = peek.y + peek.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let index = 1; index <= 10; index++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - index * travel * .05 }] });
    await page.waitForTimeout(18);
  }
  await expect.poll(() => card.evaluate(avoidY)).toBeLessThan(-(CARD_RISE - .1));
  // Registered and not inherited: the card's own offset never reaches its rows.
  const [own, inner] = await card.evaluate(el => [getComputedStyle(el).getPropertyValue('--feel-avoid-y'), getComputedStyle(el.firstElementChild!).getPropertyValue('--feel-avoid-y')]);
  expect(parseFloat(own)).toBeLessThan(-(CARD_RISE - .1)); expect(inner).toBe('0px');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(surface).toHaveAttribute('data-drawer-stop', 'half');
  const names = await page.evaluate(() => [...(window as unknown as { __styleNames: Set<string> }).__styleNames].sort());
  // Transforms, opacity and the registered offsets; once per stop the menu's
  // box and spacer, and the page's scroll lock when the menu opens.
  const allowed = new Set(['transform', 'opacity', 'translate', 'rotate', 'scale', 'bottom', 'height', '--feel-avoid-y', '--feel-item-x', '--feel-item-y', '--feel-item-scale', '--nav-open-height', 'overflow', 'padding-right']);
  expect(names.filter(name => !allowed.has(name))).toEqual([]);
  await context.close();
});

test('records in a card inside a group move with the group as it makes room', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: String(test.info().project.use.baseURL), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto('/demo.html');
  const surface = page.locator('.feel-nav-drawer');
  // The menu's size sets the stops; measure them once the page has settled.
  await expect(page.locator('.clients-panel')).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const halfTop = await halfStopTop(surface);
  // A group whose bottom sits 16px into the half-open panel rises its full
  // 32px; the record inside its card stays 56px above the card's bottom edge.
  await page.evaluate(halfTop => {
    const group = document.createElement('div');
    group.id = 'feel-group-fixture'; group.dataset.feelGroup = '';
    group.style.cssText = `position:fixed;left:16px;width:358px;top:${halfTop + 16 - 116}px;height:116px;z-index:20`;
    group.innerHTML = '<section data-feel-card style="box-sizing:border-box;height:116px;padding:20px 16px 0;background:white"><div data-feel-item="row" style="height:40px">嵌套卡片里的记录</div></section>';
    document.querySelector('.app-shell')!.append(group);
  }, halfTop);
  const group = page.locator('#feel-group-fixture'), row = group.locator('[data-feel-item]');
  const cdp = await context.newCDPSession(page), peek = await box(page.locator('.feel-nav-peek'));
  const travel = await surface.evaluate(el => parseFloat((el as HTMLElement).style.getPropertyValue('--nav-open-height')) - 84);
  const x = peek.x + peek.width / 2, y = peek.y + peek.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let index = 1; index <= 10; index++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - index * travel * .05 }] });
    await page.waitForTimeout(18);
  }
  // Held at the half stop, everything settles under the finger.
  await expect.poll(() => group.evaluate(avoidY)).toBeLessThan(-31.9);
  await page.waitForTimeout(1200);
  const seen = await row.evaluate(el => {
    const style = (el as HTMLElement).style, rect = el.getBoundingClientRect(), y = parseFloat(style.getPropertyValue('--feel-item-y')) || 0;
    const scale = parseFloat(style.getPropertyValue('--feel-item-scale')) || 1;
    return { y, bottom: rect.bottom - y + rect.height * (1 / scale - 1) / 2, sheet: document.querySelector('.feel-nav-drawer')!.getBoundingClientRect().top };
  });
  // The response for where the record really is (feel-physics itemRepulsion,
  // mobile rows), not for where it was before the group rose 32px.
  const response = (distance: number) => { const t = Math.max(0, 1 - distance / 144); return -7 * t * t * (3 - 2 * t); };
  const expected = response(seen.sheet - seen.bottom), stale = response(seen.sheet - seen.bottom - 32);
  expect(Math.abs(expected - stale)).toBeGreaterThan(1);
  expect(Math.abs(seen.y - expected)).toBeLessThan(0.35);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await context.close();
});

test('reduced motion applies mobile sheet avoidance immediately and releases it on close', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/demo.html'); const card = page.locator('.clients-panel');
  // Reduced motion shows every card at once: nothing waits to rise into view.
  await expect(page.locator('[data-reveal]')).toHaveCount(0);
  const halfTop = await halfStopTop(page.locator('.feel-nav-drawer'));
  await card.evaluate((el, bottom) => window.scrollBy({ top: el.getBoundingClientRect().bottom - bottom, behavior: 'instant' }), halfTop - ABOVE_HALF_STOP);
  const before = await box(card);
  await page.locator('.feel-nav-peek').click();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  expect(await card.evaluate(avoidY)).toBe(-CARD_RISE);
  // Applied at once, the offset then holds still: no frame-by-frame rewrites.
  const frames = await card.evaluate(async el => {
    const values: string[] = [];
    for (let i = 0; i < 10; i++) { await new Promise(requestAnimationFrame); values.push((el as HTMLElement).style.getPropertyValue('--feel-avoid-y')); }
    return values;
  });
  expect(frames).toEqual(Array(10).fill(`${-CARD_RISE}px`));
  expect((await box(card)).width).toBe(before.width);
  await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  expect(await card.evaluate(avoidY)).toBe(0);
  expect(await card.evaluate(el => el.hasAttribute('data-menu-avoidance'))).toBe(false);
});

test('nested model records react independently, remain clickable and return to rest when the menu settles', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await page.goto('/demo.html#models');
  const handle = page.getByRole('button', { name: '移动导航菜单', exact: true });
  await handle.press('End');
  await expect.poll(async () => Math.round((await box(page.locator('.feel-navigation'))).x)).toBe(1440 - 216 - 16);
  const panel = page.locator('.models-panel');
  await scrollCardTo(panel, 240);
  const rows = panel.locator('tbody > tr[data-feel-item="row"]'), row = rows.first();
  await expect(panel).toHaveAttribute('data-menu-avoidance', 'clear');
  // A resting menu leaves the records where they are.
  await expect(page.locator('[data-feel-item-active]')).toHaveCount(0);
  await holdMenu(page);
  await expect(row).toHaveAttribute('data-feel-item-active', 'true');
  await expect.poll(() => row.evaluate(el => parseFloat((el as HTMLElement).style.getPropertyValue('--feel-item-x')))).toBeLessThan(-1);
  const response = await row.evaluate(el => { const { style } = el as HTMLElement; return { x: parseFloat(style.getPropertyValue('--feel-item-x')), scale: parseFloat(style.getPropertyValue('--feel-item-scale')), layout: [style.width, style.marginLeft, style.marginRight], outer: el.hasAttribute('data-menu-avoidance') }; });
  expect(response.x).toBeGreaterThanOrEqual(-7); expect(response.scale).toBeGreaterThanOrEqual(.988); expect(response.scale).toBeLessThan(1);
  expect(response.layout).toEqual(['', '', '']); expect(response.outer).toBe(false);
  await expect(panel).toHaveAttribute('data-menu-avoidance', 'clear');
  await expect(rows.last()).not.toHaveAttribute('data-feel-item-active');
  // A displaced record still answers the pointer where it is drawn.
  const details = row.getByRole('button', { name: /查看 .* 详情/ });
  const target = await box(details);
  expect(await details.evaluate((el, [x, y]) => el.contains(document.elementFromPoint(x, y)), [target.x + target.width / 2, target.y + target.height / 2])).toBe(true);
  await page.waitForTimeout(700);
  await page.screenshot({ path: 'evidence/feel-nested-models-1440.png' });
  await page.mouse.up();
  // Once the menu has settled, the records return and keep nothing of the response.
  await expect(page.locator('[data-feel-item-active]')).toHaveCount(0);
  expect(await row.evaluate(itemProperties)).toEqual(['', '', '']);
  expect(await row.evaluate(el => el.hasAttribute('data-feel-item-moving'))).toBe(false);
  await expect(panel).toHaveAttribute('data-menu-avoidance', 'clear');
  await expect(panel).not.toHaveAttribute('data-feel-moving');
  expect(await panel.evaluate(el => [(el as HTMLElement).style.translate, (el as HTMLElement).style.scale, getComputedStyle(el).willChange])).toEqual(['', '', 'auto']);
  await details.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.getByRole('dialog').locator('[data-feel-item-active]').count()).toBe(0);
  await page.keyboard.press('Escape');
});

test('nearby heatmap cells keep a bounded separate response and preserve pointer tooltips and keyboard dismissal', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await page.goto('/demo.html#models');
  await page.getByRole('button', { name: '移动导航菜单', exact: true }).press('End');
  const panel = page.locator('.matrix-panel');
  await scrollCardTo(panel, 260);
  // The centred layout leaves deliberate whitespace after the fixed-width
  // matrix. Bring the held menu beside the actual final cell to test its field.
  const lastCell = await box(panel.locator('.matrix-cell').last()), navHandle = await box(page.getByRole('button', { name: '移动导航菜单', exact: true })), nav = await box(page.locator('.feel-navigation'));
  const grabX = navHandle.x + 15, grabY = navHandle.y + navHandle.height / 2;
  await page.mouse.move(grabX, grabY); await page.mouse.down();
  await page.mouse.move(lastCell.x + lastCell.width + 24 + grabX - nav.x, grabY, { steps: 12 });
  const active = panel.locator('.matrix-cell[data-feel-item-active="true"]');
  await expect.poll(() => active.count()).toBeGreaterThan(0);
  const cells = await active.evaluateAll(elements => elements.map(el => ({ x: parseFloat((el as HTMLElement).style.getPropertyValue('--feel-item-x')), y: parseFloat((el as HTMLElement).style.getPropertyValue('--feel-item-y')), scale: parseFloat((el as HTMLElement).style.getPropertyValue('--feel-item-scale')) })));
  expect(cells.every(cell => Math.hypot(cell.x, cell.y) <= 1.801 && cell.scale >= .985 && cell.scale < 1)).toBeTruthy();
  const far = panel.locator('.matrix-cell').first();
  await expect(far).not.toHaveAttribute('data-feel-item-active');
  await page.waitForTimeout(700); await page.screenshot({ path: 'evidence/feel-nested-heatmap-1440.png' });
  const cell = await active.first().elementHandle(); await page.mouse.up();
  // Released, the menu springs to a corner and every cell returns to rest.
  await expect(panel.locator('[data-feel-item-active]')).toHaveCount(0);
  await cell!.hover(); await expect(page.locator('.metric-tooltip-card')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.locator('.metric-tooltip-card')).toHaveCount(0);
  await page.mouse.move(0, 0); await cell!.click(); await expect(page.locator('.metric-tooltip-card')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.locator('.metric-tooltip-card')).toHaveCount(0);
});

test('opening existing details recalculates inner targets, then decorative frames stop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 }); await page.goto('/demo.html');
  await page.getByRole('button', { name: '移动导航菜单', exact: true }).press('Home');
  await page.getByRole('button', { name: '移动导航菜单', exact: true }).press('ArrowRight');
  await expect.poll(async () => Math.round((await box(page.locator('.feel-navigation'))).x)).toBe(1048);
  // Records still answer a menu that is springing into its corner; let it come to rest.
  await page.waitForTimeout(1000);
  // A details element changes the existing parent's height without inserting
  // nodes. Both target positions remain fully visible and within reach of the
  // menu, so visibility does not invalidate the targets on behalf of the size
  // observer.
  await page.evaluate(() => {
    const menu = document.querySelector('.feel-navigation')!.getBoundingClientRect();
    const fixture = document.createElement('section');
    fixture.id = 'feel-size-fixture'; fixture.dataset.feelCard = '';
    fixture.style.cssText = `position:fixed;left:${menu.left - 430}px;top:${menu.bottom - 180}px;width:400px;z-index:20;background:white`;
    fixture.innerHTML = '<details><summary style="height:40px">展开既有内容</summary><div style="height:240px">已有说明</div></details><button data-feel-item="row" style="display:block;width:calc(100% - 20px);margin-left:20px;height:50px">保持可点击的记录</button>';
    document.querySelector('.app-shell')!.append(fixture);
  });
  const row = page.locator('#feel-size-fixture [data-feel-item]');
  const itemX = () => row.evaluate(el => parseFloat((el as HTMLElement).style.getPropertyValue('--feel-item-x')) || 0);
  // Beside a resting menu the record keeps its place.
  await page.waitForTimeout(300);
  expect(await row.evaluate(itemProperties)).toEqual(['', '', '']);
  await holdMenu(page);
  await expect.poll(itemX).toBeLessThan(-5);
  await page.waitForTimeout(700);
  const before = await itemX();
  // The mouse is holding the menu, so the details open from the keyboard.
  await page.locator('#feel-size-fixture summary').press('Enter');
  await expect(page.locator('#feel-size-fixture details')).toHaveAttribute('open', '');
  await expect.poll(itemX).toBeGreaterThan(before + 1);
  const quiet = () => page.evaluate(async () => {
    const fixture = document.querySelector('#feel-size-fixture')!, row = fixture.querySelector<HTMLElement>('[data-feel-item]')!;
    let writes = 0; const observer = new MutationObserver(records => { writes += records.length; });
    observer.observe(fixture, { attributes: true, attributeFilter: ['style'], subtree: true });
    const before = row.style.cssText;
    for (let i = 0; i < 60; i++) await new Promise(requestAnimationFrame);
    observer.disconnect(); return { writes, same: before === row.style.cssText };
  });
  await page.waitForTimeout(1100);
  // A settled response under a held menu writes nothing per frame.
  expect(await quiet()).toEqual({ writes: 0, same: true });
  await page.mouse.up();
  // The menu settles, the record returns to rest, and then nothing runs.
  await expect(row).not.toHaveAttribute('data-feel-item-active');
  expect(await row.evaluate(itemProperties)).toEqual(['', '', '']);
  expect(await quiet()).toEqual({ writes: 0, same: true });
  await row.click(); await expect(row).toBeFocused();
  await page.locator('#feel-size-fixture').evaluate(el => el.remove());
  await page.evaluate(() => window.scrollBy({ top: 240, behavior: 'instant' }));
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
});

test('reduced motion clears inner row and cell decoration', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await page.goto('/demo.html#models');
  await page.getByRole('button', { name: '移动导航菜单', exact: true }).press('End');
  await scrollCardTo(page.locator('.models-panel'), 240);
  await holdMenu(page);
  await expect.poll(() => page.locator('[data-feel-item-active]').count()).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('[data-feel-item-active]')).toHaveCount(0);
  await page.locator('.matrix-panel').evaluate(el => window.scrollBy({ top: el.getBoundingClientRect().top - 260, behavior: 'instant' }));
  // Even a menu that is still being dragged leaves records alone.
  const grip = await box(page.getByRole('button', { name: '移动导航菜单', exact: true }));
  await page.mouse.move(grip.x + 15 - 40, grip.y + grip.height / 2, { steps: 4 });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  expect(await page.locator('[data-feel-item-active]').count()).toBe(0);
  await page.mouse.up();
});

test('mobile navigation returns to its actual handle without scrolling the background', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/demo.html#overview');
  const peek = page.locator('[data-mobile-navigation-trigger]');
  const dialog = page.getByRole('dialog', { name: '导航', exact: true });
  await page.evaluate(() => window.scrollTo({ top: 920, behavior: 'instant' }));
  const before = await page.evaluate(() => window.scrollY); expect(before).toBeGreaterThan(500);
  for (const activation of ['click', 'Enter', 'ArrowUp', 'drag'] as const) {
    if (activation === 'click') await peek.click();
    else if (activation === 'drag') {
      const grip = await box(peek), x = grip.x + grip.width / 2, y = grip.y + grip.height / 2;
      await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x, y - 260, { steps: 10 });
      await page.waitForTimeout(110); await page.mouse.up();
    } else await peek.press(activation);
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBe(before);
    if (activation === 'Enter') await dialog.getByRole('button', { name: '关闭导航', exact: true }).click();
    else if (activation === 'drag') await dialog.getByRole('navigation', { name: '常用页面', exact: true }).getByRole('link', { name: '总览', exact: true }).click();
    else await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden(); await expect(peek).toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBe(before);
    await expect(page.locator('.feel-nav-drawer')).toHaveAttribute('data-drawer-stop', 'closed');
  }
  await peek.click(); await dialog.getByRole('navigation', { name: '常用页面', exact: true }).getByRole('link', { name: '模型分析', exact: true }).click();
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

test('navigation releases modal state and returns focus when the layout changes to desktop', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/demo.html#overview');
  await page.locator('.feel-nav-peek').click();
  await expect(page.getByRole('dialog', { name: '导航', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '移动导航菜单', exact: true })).toBeFocused();
  expect(await page.locator('.workspace-main').evaluate(el => (el as HTMLElement).inert)).toBe(false);
  expect(await page.locator('body').evaluate(el => el.style.overflow)).not.toBe('hidden');
});

for (const viewport of [{ width: 320, height: 740 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test(`magnetic surface stays continuous with three direct links and three stops at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport); await page.goto('/demo.html#overview');
    const surface = page.locator('.feel-nav-drawer'), trigger = page.locator('[data-mobile-navigation-trigger]');
    const quick = page.getByRole('navigation', { name: '常用页面', exact: true });
    await expect(page.locator('.mobile-menu')).toHaveCount(0);
    await expect(surface).toHaveAttribute('data-drawer-stop', 'closed');
    await expect(quick.getByRole('link')).toHaveCount(3);
    for (const name of ['总览', '模型分析', '配额与订阅']) {
      const link = quick.getByRole('link', { name, exact: true });
      await expect(link).toBeInViewport(); const linkBox = await box(link);
      expect(linkBox.height).toBeGreaterThanOrEqual(44); expect(linkBox.width).toBeGreaterThanOrEqual(44);
    }
    await quick.getByRole('link', { name: '模型分析', exact: true }).click(); await expect(page).toHaveURL(/#models$/);
    await expect(quick.getByRole('link', { name: '模型分析', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('dialog', { name: '导航', exact: true })).toHaveCount(0);
    await quick.getByRole('link', { name: '配额与订阅', exact: true }).click(); await expect(page).toHaveURL(/#quota$/);
    await quick.getByRole('link', { name: '总览', exact: true }).click(); await expect(page).toHaveURL(/#overview$/);
    await expect(quick.getByRole('link', { name: '总览', exact: true })).toHaveAttribute('aria-current', 'page');
    await page.waitForTimeout(500); // Let the newly selected page finish its entry motion before captures.
    // One panel of fixed size, min(100vw, 520px) wide and centred, that only
    // slides: closed it shows 84px (the grip strip and the tab bar), open the
    // whole menu, and the tab bar never leaves the bottom edge.
    const openHeight = await surface.evaluate(el => parseFloat((el as HTMLElement).style.getPropertyValue('--nav-open-height')));
    const expectAt = async (rect: { x: number; y: number; width: number; height: number }) => {
      expect(Math.abs(rect.width - Math.min(520, viewport.width))).toBeLessThan(.5);
      expect(Math.abs(rect.x + rect.width / 2 - viewport.width / 2)).toBeLessThan(.5);
      expect(Math.abs(rect.height - (openHeight + 48))).toBeLessThan(.5);
      const bar = await box(quick); expect(Math.abs(bar.y + bar.height - viewport.height)).toBeLessThan(.5);
    };
    const node = await surface.elementHandle(), closed = await box(surface);
    await expectAt(closed); expect(Math.round(viewport.height - closed.y)).toBe(84);
    await page.screenshot({ path: `evidence/magnetic-${viewport.width}-closed.png` });
    // A tap springs from rest: nothing moves in the frame of the tap itself.
    const immediate = await trigger.evaluate(button => { const surface = button.closest('.feel-nav-drawer')!; const before = surface.getBoundingClientRect().top; (button as HTMLButtonElement).click(); return { before, after: surface.getBoundingClientRect().top }; });
    expect(immediate.after).toBe(immediate.before);
    await expect(surface).toHaveAttribute('data-drawer-stop', 'half');
    const half = await box(surface); await expectAt(half);
    await page.screenshot({ path: `evidence/magnetic-${viewport.width}-half.png` });
    await trigger.click(); await expect(surface).toHaveAttribute('data-drawer-stop', 'open');
    const opened = await box(surface); await expectAt(opened);
    expect(Math.abs((closed.y - half.y) - (half.y - opened.y))).toBeLessThanOrEqual(1);
    expect(Math.round(viewport.height - opened.y)).toBe(openHeight);
    expect(opened.y).toBeGreaterThanOrEqual(23.5);
    expect(await node!.evaluate(el => el === document.querySelector('.feel-nav-drawer'))).toBe(true);
    const full = page.getByRole('navigation', { name: '页面导航', exact: true });
    for (const id of ['devices', 'history']) await expect(full.locator(`a[href="#${id}"]`)).toHaveCount(1);
    await full.getByRole('button', { name: '工作区设置', exact: true }).scrollIntoViewIfNeeded();
    await expect(full.getByRole('button', { name: '工作区设置', exact: true })).toBeInViewport();
    await page.screenshot({ path: `evidence/magnetic-${viewport.width}-open.png` });
    const closing = await page.evaluate(() => {
      const surface = document.querySelector('.feel-nav-drawer')!, menu = surface.querySelector('.feel-nav-content')!;
      const before = surface.getBoundingClientRect().top;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { before, after: surface.getBoundingClientRect().top, visibility: getComputedStyle(menu).visibility };
    });
    expect(closing.after).toBe(closing.before); expect(closing.visibility).toBe('visible');
    await expect(surface).toHaveAttribute('data-drawer-stop', 'closed');
    expect(await node!.evaluate(el => el === document.querySelector('.feel-nav-drawer'))).toBe(true);
    await expect(full).toBeHidden();
    expect(await page.locator('.workspace-main').evaluate(el => (el as HTMLElement).inert)).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
  });
}

test('the tab bar\'s 更多 button opens the whole menu, the scrim closes it and focus returns', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/demo.html#overview');
  const surface = page.locator('.feel-nav-drawer'), dialog = page.getByRole('dialog', { name: '导航', exact: true });
  const more = page.getByRole('navigation', { name: '常用页面', exact: true }).getByRole('button', { name: '更多', exact: true });
  const moreBox = await box(more);
  expect(moreBox.width).toBeGreaterThanOrEqual(44); expect(moreBox.height).toBeGreaterThanOrEqual(44);
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await page.evaluate(() => {
    const drawer = document.querySelector('.feel-nav-drawer')!;
    let drawerReads = 0;
    const orig = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      if (this === drawer) drawerReads++;
      return orig.call(this);
    };
    (window as unknown as { __drawerReads: () => number }).__drawerReads = () => {
      Element.prototype.getBoundingClientRect = orig;
      return drawerReads;
    };
  });
  await more.click();
  const movingStyle = await surface.evaluate(el => ({
    moving: el.dataset.drawerMoving,
    backdropFilter: getComputedStyle(el).backdropFilter,
  }));
  expect(movingStyle).toEqual({ moving: 'true', backdropFilter: 'none' });
  await expect(surface).toHaveAttribute('data-drawer-stop', 'open');
  expect(await page.evaluate(() => (window as unknown as { __drawerReads: () => number }).__drawerReads())).toBe(0);
  await expect(dialog).toBeVisible(); await expect(more).toHaveAttribute('aria-expanded', 'true');
  await more.click();
  await expect(surface).toHaveAttribute('data-drawer-stop', 'closed');
  await expect(dialog).toHaveCount(0); await expect(more).toBeFocused();
  await more.click(); await expect(surface).toHaveAttribute('data-drawer-stop', 'open');
  // The scrim above the page closes the menu.
  await expect(page.locator('.feel-nav-backdrop')).toHaveAttribute('data-active', 'true');
  await page.mouse.click(195, 100);
  await expect(surface).toHaveAttribute('data-drawer-stop', 'closed');
  await expect(dialog).toHaveCount(0); await expect(more).toBeFocused();
  await expect(page).toHaveURL(/#overview$/);
});

test('a closing magnetic drawer can be tapped open again and still accepts keyboard and navigation', async ({ page }) => {
  // The grip travels with the closing panel. A paused clock holds the panel
  // still between frames, so a real tap can land on the grip while it moves.
  await page.clock.install();
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/demo.html#overview');
  const surface = page.locator('.feel-nav-drawer'), trigger = page.locator('[data-mobile-navigation-trigger]');
  await trigger.press('Home'); await expect(surface).toHaveAttribute('data-drawer-stop', 'open');
  await page.keyboard.press('Escape');
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 60));
  await expect(surface).toHaveAttribute('data-drawer-moving', 'true');
  const open = await surface.evaluate(el => {
    const closed = parseFloat((el as HTMLElement).style.getPropertyValue('--nav-open-height')) - 84;
    return 1 - new DOMMatrixReadOnly(getComputedStyle(el).transform).m42 / closed;
  });
  expect(open).toBeGreaterThan(.05); expect(open).toBeLessThan(1);
  const grip = await box(trigger);
  await page.mouse.click(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.clock.resume();
  await expect(page.getByRole('dialog', { name: '导航', exact: true })).toBeVisible();
  await expect(surface).toHaveAttribute('data-drawer-stop', 'half');
  await trigger.press('Home'); await expect(surface).toHaveAttribute('data-drawer-stop', 'open');
  const full = page.getByRole('navigation', { name: '页面导航', exact: true });
  await full.locator('a[href="#devices"]').click();
  await expect(page).toHaveURL(/#devices$/); await expect(surface).toHaveAttribute('data-drawer-stop', 'closed'); await expect(trigger).toBeFocused();
});

test('the magnetic hand reverses during dragging and catches a live release without activating links', async ({ page }) => {
  // A paused clock holds the released, still-moving surface between frames so
  // the next press lands on the grip where it is drawn.
  await page.clock.install();
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/demo.html#overview');
  const trigger = page.locator('[data-mobile-navigation-trigger]'), surface = page.locator('.feel-nav-drawer');
  const start = await box(trigger), x = start.x + start.width / 2, y = start.y + start.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  for (let i = 1; i <= 8; i++) { await page.mouse.move(x, y - i * 25); await page.waitForTimeout(20); }
  const raised = (await box(surface)).y;
  for (let i = 1; i <= 6; i++) { await page.mouse.move(x, y - 200 + i * 18); await page.waitForTimeout(20); }
  const reversed = (await box(surface)).y; expect(reversed).toBeGreaterThan(raised + 15);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
  await page.mouse.up();
  await page.clock.runFor(64);
  await expect(surface).toHaveAttribute('data-drawer-moving', 'true');
  const released = (await box(surface)).y;
  await page.clock.runFor(32);
  const movingHandle = await box(trigger), beforeCatch = (await box(surface)).y;
  expect(beforeCatch).not.toBe(released);
  await page.mouse.move(movingHandle.x + movingHandle.width / 2, movingHandle.y + movingHandle.height / 2);
  await page.mouse.down();
  // Caught, the surface stays where the pointer holds it.
  await page.clock.runFor(160);
  expect(Math.abs((await box(surface)).y - beforeCatch)).toBeLessThan(1);
  await page.clock.resume();
  for (let i = 1; i <= 5; i++) { await page.mouse.move(x, movingHandle.y + movingHandle.height / 2 - i * 20); await page.waitForTimeout(20); }
  await page.mouse.up(); await expect.poll(() => surface.getAttribute('data-drawer-stop')).toMatch(/^(closed|half|open)$/);
  await expect(page).toHaveURL(/#overview$/); expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await trigger.press('Home'); await expect(surface).toHaveAttribute('data-drawer-stop', 'open');
  await page.getByRole('navigation', { name: '常用页面', exact: true }).getByRole('link', { name: '模型分析', exact: true }).click();
  await expect(page).toHaveURL(/#models$/);
});

test('resizing during a magnetic drag releases the old pointer coordinates without a jump on the next move', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/demo.html#overview');
  const trigger = page.locator('[data-mobile-navigation-trigger]'), surface = page.locator('.feel-nav-drawer');
  const start = await box(trigger), x = start.x + start.width / 2, y = start.y + start.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  for (let i = 1; i <= 8; i++) { await page.mouse.move(x, y - i * 26); await page.waitForTimeout(20); }
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(40);
  const capture = await trigger.evaluate(el => el.hasPointerCapture(1)); expect(capture).toBe(false);
  await page.mouse.move(420, 50); await page.mouse.up();
  await expect.poll(() => surface.getAttribute('data-drawer-stop')).toMatch(/^(closed|half|open)$/);
  const settled = await box(surface);
  expect(settled.x).toBeGreaterThanOrEqual(0); expect(settled.width).toBeLessThanOrEqual(844); expect(settled.y).toBeGreaterThanOrEqual(12);
  await trigger.press('Home'); await expect(surface).toHaveAttribute('data-drawer-stop', 'open');
  await page.keyboard.press('Escape'); await expect(surface).toHaveAttribute('data-drawer-stop', 'closed');
  expect(await page.locator('body').evaluate(el => el.style.overflow)).not.toBe('hidden');
});

test('quick search owns Tab and Escape when it replaces the magnetic navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/demo.html#overview');
  const trigger = page.locator('[data-mobile-navigation-trigger]');
  await trigger.press('Home'); await expect(page.getByRole('dialog', { name: '导航', exact: true })).toBeVisible();
  await page.keyboard.press('Meta+k');
  const search = page.getByRole('dialog', { name: '快速查找', exact: true });
  await expect(search).toBeVisible(); await expect(page.getByRole('dialog', { name: '导航', exact: true })).toHaveCount(0);
  await page.keyboard.press('Shift+Tab'); expect(await search.evaluate(el => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Tab'); expect(await search.evaluate(el => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape'); await expect(search).toBeHidden(); await expect(trigger).toBeFocused();
});
