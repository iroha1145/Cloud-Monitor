import { cardAvoidance, mobileCardAvoidance, itemRepulsion, clamp, springStep, type AvoidanceSide, type CardAvoidance, type Rectangle } from './feel-physics';

const SELECTOR = '[data-feel-card]';
const CONTROLS = 'a,button,input,select,textarea,label,summary,[role="button"],[role="slider"],[contenteditable="true"],[data-feel-ignore]';
const LAYOUT_PROPERTIES = ['width', 'margin-left', 'margin-right'];
type Card = { el: HTMLElement; slot: Rectangle; saved: [string, string][]; ml: number; mr: number; loss: number; inset: number; vl: number; vi: number; side: AvoidanceSide; target: CardAvoidance; ay: number; av: number; mobileTarget: number; mobileLimit: number; blockers: Element[] };

type InnerItem = {
  el: HTMLElement; kind: 'row' | 'cell'; parent: HTMLElement | null;
  x: number; y: number; scale: number; vx: number; vy: number; vs: number;
  tx: number; ty: number; ts: number;
};
const ITEM_PROPERTIES = ['--feel-item-x', '--feel-item-y', '--feel-item-scale'];

/** Only intersecting items are considered; stationary menus do no per-frame
 * scans. Reading targets and painting springs are separate batch phases. */
function createFeelItems(root: HTMLElement, schedule: () => void) {
  const win = root.ownerDocument.defaultView!;
  const records = new Map<HTMLElement, InnerItem>(), visible = new Set<InnerItem>(), active = new Set<InnerItem>();
  let scan = true, targetsDirty = true, disposed = false;
  const restore = (item: InnerItem) => {
    ITEM_PROPERTIES.forEach(key => item.el.style.removeProperty(key)); delete item.el.dataset.feelItemActive;
    item.x = item.y = item.vx = item.vy = item.vs = item.tx = item.ty = 0; item.scale = item.ts = 1;
    active.delete(item);
  };
  const observer = new IntersectionObserver(entries => {
    if (disposed) return;
    for (const entry of entries) {
      const item = records.get(entry.target as HTMLElement); if (!item) continue;
      if (entry.isIntersecting) visible.add(item); else { visible.delete(item); restore(item); }
    }
    targetsDirty = true; schedule();
  }, { rootMargin: '0px', threshold: 0 });
  function refresh() { scan = true; targetsDirty = true; }
  function read(menu: Rectangle | null, mobile: boolean, safeTop: number, reduced: boolean) {
    if (scan) {
      const found = new Set([...root.querySelectorAll<HTMLElement>('[data-feel-item]')]
        .filter(el => !el.closest('[role="dialog"]') && !el.parentElement?.closest('[data-feel-item]')));
      for (const [el, item] of records) if (!found.has(el)) { observer.unobserve(el); restore(item); visible.delete(item); records.delete(el); }
      for (const el of found) if (!records.has(el)) {
        const item: InnerItem = { el, kind: el.dataset.feelItem === 'cell' ? 'cell' : 'row', parent: el.parentElement?.closest<HTMLElement>('[data-feel-card]') || null,
          x: 0, y: 0, scale: 1, vx: 0, vy: 0, vs: 0, tx: 0, ty: 0, ts: 1 };
        records.set(el, item); observer.observe(el);
      }
      scan = false;
    }
    if (!targetsDirty) return;
    targetsDirty = false;
    if (reduced || !menu) {
      for (const item of active) { item.tx = item.ty = 0; item.ts = 1; if (reduced) restore(item); }
      return;
    }
    const parentBoxes = new Map<HTMLElement, DOMRect>();
    const samples: { item: InnerItem; x: number; y: number; scale: number }[] = [];
    for (const item of visible) {
      let parent: DOMRect | undefined;
      if (item.parent) {
        parent = parentBoxes.get(item.parent);
        if (!parent) { parent = item.parent.getBoundingClientRect(); parentBoxes.set(item.parent, parent); }
        const reach = item.kind === 'cell' ? 80 : 144;
        if (parent.right < menu.left - reach || parent.left > menu.right + reach || parent.bottom < menu.top - reach || parent.top > menu.bottom + reach) {
          if (active.has(item)) samples.push({ item, x: 0, y: 0, scale: 1 });
          continue;
        }
      }
      const rect = item.el.getBoundingClientRect();
      if (!rect.width || !rect.height || rect.bottom <= safeTop || rect.top >= win.innerHeight) {
        if (active.has(item)) samples.push({ item, x: 0, y: 0, scale: 1 });
        continue;
      }
      const width = rect.width / item.scale, height = rect.height / item.scale;
      const left = rect.left - item.x - (width - rect.width) / 2, top = rect.top - item.y - (height - rect.height) / 2;
      const base = { left, top, right: left + width, bottom: top + height, width, height };
      const response = itemRepulsion(base, menu, item.kind, mobile);
      const insetX = width * (1 - response.scale) / 2, insetY = height * (1 - response.scale) / 2;
      const clip = { left: parent?.left || 0, right: parent?.right || win.innerWidth, top: Math.max(safeTop, parent?.top || 0), bottom: Math.min(win.innerHeight, parent?.bottom || win.innerHeight) };
      response.x = clamp(response.x, Math.min(0, clip.left - base.left - insetX), Math.max(0, clip.right - base.right + insetX));
      response.y = clamp(response.y, Math.min(0, clip.top - base.top - insetY), Math.max(0, clip.bottom - base.bottom + insetY));
      samples.push({ item, ...response });
    }
    for (const sample of samples) {
      const { item } = sample; item.tx = sample.x; item.ty = sample.y; item.ts = sample.scale;
      if (sample.x || sample.y || sample.scale !== 1 || active.has(item)) active.add(item);
    }
  }
  function paint(dt: number, reduced: boolean) {
    let moving = false;
    for (const item of active) {
      if (reduced || !item.el.isConnected) { restore(item); continue; }
      [item.x, item.vx] = springStep(item.x, item.vx, item.tx, dt, 330, 29, .8);
      [item.y, item.vy] = springStep(item.y, item.vy, item.ty, dt, 330, 29, .8);
      [item.scale, item.vs] = springStep(item.scale, item.vs, item.ts, dt, 330, 29, .8);
      const settled = Math.abs(item.x - item.tx) + Math.abs(item.y - item.ty) < .01 && Math.hypot(item.vx, item.vy) < .1 && Math.abs(item.scale - item.ts) < .00001 && Math.abs(item.vs) < .0001;
      if (settled) { item.x = item.tx; item.y = item.ty; item.scale = item.ts; item.vx = item.vy = item.vs = 0; }
      else moving = true;
      if (settled && item.tx === 0 && item.ty === 0 && item.ts === 1) { restore(item); continue; }
      item.el.style.setProperty('--feel-item-x', `${item.x.toFixed(3)}px`);
      item.el.style.setProperty('--feel-item-y', `${item.y.toFixed(3)}px`);
      item.el.style.setProperty('--feel-item-scale', item.scale.toFixed(6));
      item.el.dataset.feelItemActive = 'true';
    }
    return moving;
  }
  return { refresh, invalidate() { targetsDirty = true; }, read, paint, destroy() { disposed = true; observer.disconnect(); records.forEach(restore); records.clear(); visible.clear(); } };
}

/** Decorative only. These listeners never cancel scrolling, selection or clicks. */
export function createFeelCards(root: HTMLElement) {
  const win = root.ownerDocument.defaultView!, doc = root.ownerDocument;
  const reduced = win.matchMedia('(prefers-reduced-motion: reduce)');
  let cards: Card[] = [], dirty = true, mode: 'desktop' | 'mobile' = 'desktop', menu: Rectangle | null = null, frame = 0, time = 0, destroyed = false;
  const items = createFeelItems(root, schedule);
  const heights = new WeakMap<Element, number>();
  const sizes = new ResizeObserver(entries => {
    let changed = false;
    for (const { target } of entries) {
      const height = target.getBoundingClientRect().height, previous = heights.get(target); heights.set(target, height);
      if (previous !== height) changed = true;
    }
    if (changed) { items.invalidate(); schedule(); }
  });
  let returnFrame = 0, returning: HTMLElement | null = null;
  let press: { el: HTMLElement; id: number; x: number; y: number; touch: boolean } | null = null;
  const restore = (el: HTMLElement) => {
    ['--feel-avoid-x', '--feel-avoid-y', '--feel-press-x', '--feel-press-y', '--feel-press-scale'].forEach(key => el.style.removeProperty(key));
    delete el.dataset.feelMoving;
  };
  function resetPress() {
    win.cancelAnimationFrame(returnFrame); returnFrame = 0;
    if (returning) {
      returning.style.removeProperty('--feel-press-x'); returning.style.removeProperty('--feel-press-y'); returning.style.removeProperty('--feel-press-scale'); returning = null;
    }
    if (!press) return;
    const el = press.el;
    el.style.removeProperty('--feel-press-x'); el.style.removeProperty('--feel-press-y'); el.style.removeProperty('--feel-press-scale');
    press = null;
  }
  function restoreLayout(card: Card) {
    LAYOUT_PROPERTIES.forEach((key, index) => {
      const [value, priority] = card.saved[index];
      if (value) card.el.style.setProperty(key, value, priority); else card.el.style.removeProperty(key);
    });
    delete card.el.dataset.menuAvoidance; delete card.el.dataset.feelMoving;
  }
  function precedingBlocks(el: HTMLElement) {
    const result: Element[] = [];
    for (let node: Element | null = el; node && node !== root; node = node.parentElement) {
      for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (!sibling.matches('.feel-navigation, .feel-nav-peek, .skip-link, script, style')) result.push(sibling);
      }
    }
    return result;
  }
  function measure() {
    const previous = new Map(cards.map(card => [card.el, card]));
    cards.forEach(restoreLayout); sizes.disconnect();
    cards = [...root.querySelectorAll<HTMLElement>(SELECTOR)]
      .filter(el => !el.parentElement?.closest(SELECTOR) && !el.closest('[role="dialog"], [hidden]'))
      .flatMap(el => {
        const rect = el.getBoundingClientRect(); if (!rect.width || !rect.height) return [];
        const old = previous.get(el), style = win.getComputedStyle(el);
        return [{ el, slot: { left: rect.left, right: rect.right, width: rect.width, top: rect.top - (old?.ay || 0), bottom: rect.bottom - (old?.ay || 0), height: rect.height },
          saved: LAYOUT_PROPERTIES.map(key => [el.style.getPropertyValue(key), el.style.getPropertyPriority(key)] as [string, string]),
          ml: parseFloat(style.marginLeft) || 0, mr: parseFloat(style.marginRight) || 0,
          loss: old?.loss || 0, inset: old?.inset || 0, vl: old?.vl || 0, vi: old?.vi || 0,
          side: old?.side || null, ay: old?.ay || 0, av: old?.av || 0, mobileTarget: 0, mobileLimit: 0, blockers: precedingBlocks(el), target: cardAvoidance(rect, null, { left: 0, right: win.innerWidth }) }];
      });
    for (const [el] of previous) if (!cards.some(card => card.el === el)) restore(el);
    cards.forEach(card => sizes.observe(card.el)); dirty = false;
  }
  function tick(now: number) {
    frame = 0;
    const dt = time ? (now - time) / 1000 : 1 / 60; time = now;
    if (dirty) measure();
    const viewport = { left: 0, right: doc.documentElement.clientWidth || win.innerWidth };
    const topbar = root.querySelector('.app-topbar')?.getBoundingClientRect();
    const safeTop = Math.max(12, topbar && topbar.top < win.innerHeight && topbar.bottom > 0 ? topbar.bottom + 4 : 0);
    // Read all live vertical positions before any width writes. Only horizontal
    // geometry is pinned to each card's original slot; wrapped content may grow.
    for (const card of cards) {
      const actual = card.el.getBoundingClientRect();
      const base = { ...card.slot, top: actual.top - card.ay, bottom: actual.bottom - card.ay, height: actual.height };
      card.target = cardAvoidance(base, mode === 'desktop' ? menu : null, viewport, card.side);
      card.side = card.target.side;
      let precedingBottom: number | null = null;
      if (mode === 'mobile') {
        for (const blocker of card.blockers) {
          const rect = blocker.getBoundingClientRect();
          const ownShift = blocker instanceof HTMLElement ? parseFloat(blocker.style.getPropertyValue('--feel-avoid-y')) || 0 : 0;
          const bottom = rect.bottom - ownShift;
          if (rect.width && rect.height && rect.right > base.left && rect.left < base.right && bottom > safeTop && bottom <= base.top + .5) precedingBottom = Math.max(precedingBottom ?? 0, bottom);
        }
      }
      const mobileResponse = mode === 'mobile' ? mobileCardAvoidance(base, menu, safeTop, precedingBottom) : { y: 0, available: 0 };
      card.mobileTarget = mobileResponse.y; card.mobileLimit = mobileResponse.available;
    }
    items.read(menu, mode === 'mobile', safeTop, reduced.matches);
    let moving = false, outerChanged = false;
    for (const card of cards) {
      const beforeLoss = card.loss, beforeInset = card.inset, beforeY = card.ay;
      for (const [key, velocity] of [['loss', 'vl'], ['inset', 'vi']] as const) {
        if (reduced.matches) { card[key] = card.target[key]; card[velocity] = 0; }
        else [card[key], card[velocity]] = springStep(card[key], card[velocity], card.target[key], dt, 260, 28, 1);
        if (Math.abs(card[key] - card.target[key]) < .03 && Math.abs(card[velocity]) < .1) { card[key] = card.target[key]; card[velocity] = 0; }
        else moving = true;
      }
      card.loss = clamp(card.loss, 0, card.target.limit); card.inset = clamp(card.inset, 0, card.loss);
      if (card.loss < .03 && card.target.loss === 0) restoreLayout(card);
      else {
        card.el.style.width = `${(card.slot.width - card.loss).toFixed(2)}px`;
        card.el.style.marginLeft = `${(card.ml + card.inset).toFixed(2)}px`;
        card.el.style.marginRight = `${(card.mr + card.loss - card.inset).toFixed(2)}px`;
        card.el.dataset.menuAvoidance = card.target.covered ? 'overlap' : 'clear';
        if (!reduced.matches) card.el.dataset.feelMoving = 'true'; else delete card.el.dataset.feelMoving;
      }
      if (reduced.matches) { card.ay = card.mobileTarget; card.av = 0; }
      else [card.ay, card.av] = springStep(card.ay, card.av, card.mobileTarget, dt, 260, 28, 1);
      if (Math.abs(card.ay - card.mobileTarget) < .02 && Math.abs(card.av) < .1) { card.ay = card.mobileTarget; card.av = 0; }
      else moving = true;
      // The spring cannot overshoot a safety boundary or cover preceding content.
      card.ay = clamp(card.ay, -card.mobileLimit, 0);
      card.el.style.setProperty('--feel-avoid-x', '0.00px'); card.el.style.setProperty('--feel-avoid-y', `${card.ay.toFixed(3)}px`);
      if (Math.abs(card.ay) > .01) {
        card.el.dataset.menuAvoidance = 'mobile';
        if (!reduced.matches) card.el.dataset.feelMoving = 'true';
      }
      if (Math.abs(card.loss - beforeLoss) + Math.abs(card.inset - beforeInset) + Math.abs(card.ay - beforeY) > .001) outerChanged = true;
    }
    const innerMoving = items.paint(dt, reduced.matches);
    if (outerChanged) items.invalidate();
    if (moving || innerMoving || outerChanged) frame = win.requestAnimationFrame(tick); else time = 0;
  }
  function schedule() { if (!destroyed && !frame) frame = win.requestAnimationFrame(tick); }
  const selection = () => doc.getSelection()?.isCollapsed === false;
  const beginPress = (target: Element | null, id: number, x: number, y: number, touch: boolean) => {
    if (reduced.matches || selection()) return;
    const el = target?.closest<HTMLElement>(SELECTOR);
    if (!el || target?.closest(CONTROLS) || el.parentElement?.closest(SELECTOR)) return;
    for (let node = target; node && node !== el; node = node.parentElement) {
      const style = win.getComputedStyle(node);
      if (/(auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`)) return;
    }
    resetPress(); press = { el, id, x, y, touch };
    el.style.setProperty('--feel-press-scale', '.997');
  };
  const down = (event: PointerEvent) => {
    if (event.pointerType === 'touch') return;
    if (press && press.id !== event.pointerId) { resetPress(); return; }
    if (event.isPrimary === false || event.button !== 0) return;
    beginPress(event.target instanceof Element ? event.target : null, event.pointerId, event.clientX, event.clientY, false);
  };
  const movePress = (x: number, y: number) => {
    if (!press) return;
    const dx = x - press.x, dy = y - press.y;
    if (selection() || (press.touch && Math.abs(dy) > 5)) { resetPress(); return; }
    press.el.style.setProperty('--feel-press-x', `${clamp(dx * .035, -5, 5)}px`);
    press.el.style.setProperty('--feel-press-y', `${press.touch ? 0 : clamp(dy * .035, -5, 5)}px`);
  };
  const move = (event: PointerEvent) => { if (press && !press.touch && press.id === event.pointerId) movePress(event.clientX, event.clientY); };
  const releasePress = () => {
    if (!press) return;
    const el = press.el;
    let x = parseFloat(el.style.getPropertyValue('--feel-press-x')) || 0, y = parseFloat(el.style.getPropertyValue('--feel-press-y')) || 0;
    let vx = 0, vy = 0, at = 0;
    press = null; returning = el;
    el.style.removeProperty('--feel-press-scale');
    const rebound = (now: number) => {
      returnFrame = 0;
      if (reduced.matches || !el.isConnected) { resetPress(); return; }
      const dt = at ? (now - at) / 1000 : 1 / 60; at = now;
      [x, vx] = springStep(x, vx, 0, dt, 330, 29, .8); [y, vy] = springStep(y, vy, 0, dt, 330, 29, .8);
      if (Math.abs(x) + Math.abs(y) < .02 && Math.hypot(vx, vy) < .2) { resetPress(); return; }
      el.style.setProperty('--feel-press-x', `${x.toFixed(3)}px`); el.style.setProperty('--feel-press-y', `${y.toFixed(3)}px`);
      returnFrame = win.requestAnimationFrame(rebound);
    };
    returnFrame = win.requestAnimationFrame(rebound);
  };
  const up = (event: PointerEvent) => { if (press && !press.touch && press.id === event.pointerId) releasePress(); };
  // Passive touch events keep decorative tracking alive even after the browser
  // hands a gesture to native scrolling. No touch-action restriction is applied
  // to cards, so nested tables and rails retain their own horizontal gestures.
  const touchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) { resetPress(); return; }
    const touch = event.changedTouches[0]; if (!touch) return;
    beginPress(event.target instanceof Element ? event.target : null, touch.identifier, touch.clientX, touch.clientY, true);
  };
  const touchMove = (event: TouchEvent) => {
    if (!press?.touch) return;
    const touch = [...event.touches].find(value => value.identifier === press!.id);
    if (touch) movePress(touch.clientX, touch.clientY);
  };
  const touchEnd = (event: TouchEvent) => { if (press?.touch && [...event.changedTouches].some(value => value.identifier === press!.id)) releasePress(); };
  const onSelection = () => { if (selection()) resetPress(); };
  const scroll = () => { resetPress(); items.invalidate(); if (menu) schedule(); };
  const changed = () => {
    dirty = true; items.refresh();
    // Count-up text and freshly loaded panels may change during a gesture.
    // Only abandon feedback when its own card disappears or motion is disabled.
    if (reduced.matches || (press && !root.contains(press.el)) || (returning && !root.contains(returning))) resetPress();
    schedule();
  };
  const observer = new MutationObserver(changes => {
    if (changes.some(change => [...change.addedNodes, ...change.removedNodes].some(node => node.nodeType === 1))) changed();
  });
  observer.observe(root, { childList: true, subtree: true });
  root.addEventListener('pointerdown', down, { passive: true });
  root.addEventListener('touchstart', touchStart, { passive: true }); root.addEventListener('touchmove', touchMove, { passive: true }); root.addEventListener('touchend', touchEnd, { passive: true }); root.addEventListener('touchcancel', resetPress, { passive: true });
  win.addEventListener('pointermove', move, { passive: true });
  win.addEventListener('pointerup', up, { passive: true });
  win.addEventListener('pointercancel', up, { passive: true });
  win.addEventListener('blur', resetPress);
  doc.addEventListener('selectionchange', onSelection);
  doc.addEventListener('scroll', scroll, { passive: true, capture: true });
  reduced.addEventListener('change', changed); win.addEventListener('resize', changed);
  return {
    update(rect: Rectangle | null, nextMode: 'desktop' | 'mobile' = 'desktop') {
      if (!rect || !menu || nextMode !== mode || Math.abs(rect.left - menu.left) + Math.abs(rect.top - menu.top) + Math.abs(rect.width - menu.width) + Math.abs(rect.height - menu.height) > .01) items.invalidate();
      menu = rect; mode = nextMode; schedule();
    },
    destroy() {
      destroyed = true; win.cancelAnimationFrame(frame); observer.disconnect(); sizes.disconnect(); items.destroy(); resetPress(); cards.forEach(card => { restoreLayout(card); restore(card.el); });
      root.removeEventListener('touchstart', touchStart); root.removeEventListener('touchmove', touchMove); root.removeEventListener('touchend', touchEnd); root.removeEventListener('touchcancel', resetPress);
      root.removeEventListener('pointerdown', down); win.removeEventListener('pointermove', move); win.removeEventListener('pointerup', up); win.removeEventListener('pointercancel', up); win.removeEventListener('blur', resetPress);
      doc.removeEventListener('selectionchange', onSelection); doc.removeEventListener('scroll', scroll, true); reduced.removeEventListener('change', changed); win.removeEventListener('resize', changed);
    },
  };
}
