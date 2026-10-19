import { cardAvoidance, mobileCardAvoidance, itemRepulsion, clamp, springStep, SLOT_SPRING, type AvoidanceSide, type CardAvoidance, type Rectangle } from './feel-physics';

// A group (a grid of cards) makes room as one block, so a narrow card at the
// start of a row is not left under the menu; the cards in it keep their own
// press feedback and records.
const SELECTOR = '[data-feel-card], [data-feel-group]';
const LAYOUT_PROPERTIES = ['width', 'margin-left', 'margin-right', 'grid-template-columns'];
type Card = { el: HTMLElement; slot: Rectangle; base: Rectangle; precedingBottom: number | null; saved: [string, string][]; ml: number; mr: number; cols: number; loss: number; inset: number; vl: number; vi: number; side: AvoidanceSide; target: CardAvoidance; ay: number; av: number; mobileTarget: number; mobileLimit: number; blockers: Element[] };

type InnerItem = {
  el: HTMLElement; kind: 'row' | 'cell'; parent: HTMLElement | null;
  base: Rectangle | null; epoch: number;
  x: number; y: number; scale: number; vx: number; vy: number; vs: number;
  tx: number; ty: number; ts: number;
};
const ITEM_PROPERTIES = ['--feel-item-x', '--feel-item-y', '--feel-item-scale'];

/** Only intersecting items are considered; stationary menus do no per-frame
 * scans. Base rectangles are cached per layout epoch so active menu/drawer
 * springs compute repulsion targets without per-frame DOM reflows. */
function createFeelItems(root: HTMLElement, schedule: () => void, cardByEl: Map<HTMLElement, Card>) {
  const win = root.ownerDocument.defaultView!;
  const records = new Map<HTMLElement, InnerItem>(), visible = new Set<InnerItem>(), active = new Set<InnerItem>();
  let scan = true, targetsDirty = true, boxEpoch = 1, disposed = false;
  const restore = (item: InnerItem) => {
    ITEM_PROPERTIES.forEach(key => item.el.style.removeProperty(key));
    delete item.el.dataset.feelItemActive; delete item.el.dataset.feelItemMoving;
    item.x = item.y = item.vx = item.vy = item.vs = item.tx = item.ty = 0; item.scale = item.ts = 1;
    active.delete(item);
  };
  const observer = new IntersectionObserver(entries => {
    if (disposed) return;
    for (const entry of entries) {
      const item = records.get(entry.target as HTMLElement); if (!item) continue;
      item.epoch = 0;
      if (entry.isIntersecting) visible.add(item); else { visible.delete(item); restore(item); }
    }
    targetsDirty = true; schedule();
  }, { rootMargin: '0px', threshold: 0 });
  function refresh() { scan = true; boxEpoch++; targetsDirty = true; }
  function invalidateBoxes() { boxEpoch++; targetsDirty = true; }
  function read(menu: Rectangle | null, mobile: boolean, safeTop: number, reduced: boolean, menuMoving: boolean) {
    if (scan) {
      const found = new Set([...root.querySelectorAll<HTMLElement>('[data-feel-item]')]
        .filter(el => !el.closest('[role="dialog"]') && !el.parentElement?.closest('[data-feel-item]')));
      for (const [el, item] of records) if (!found.has(el)) { observer.unobserve(el); restore(item); visible.delete(item); records.delete(el); }
      for (const el of found) if (!records.has(el)) {
        const item: InnerItem = { el, kind: el.dataset.feelItem === 'cell' ? 'cell' : 'row', parent: el.parentElement?.closest<HTMLElement>('[data-feel-card]') || null,
          base: null, epoch: 0, x: 0, y: 0, scale: 1, vx: 0, vy: 0, vs: 0, tx: 0, ty: 0, ts: 1 };
        records.set(el, item); observer.observe(el);
      }
      scan = false;
    }
    if (!targetsDirty) return;
    targetsDirty = false;
    // Records answer the menu only while it moves; once it rests they return
    // to their places, so nothing stays scaled under a still menu or drawer.
    if (reduced || !menu || !menuMoving) {
      for (const item of active) { item.tx = item.ty = 0; item.ts = 1; if (reduced) restore(item); }
      return;
    }
    const fallbackParents = new Map<HTMLElement, Rectangle>();
    const samples: { item: InnerItem; x: number; y: number; scale: number }[] = [];
    for (const item of visible) {
      let parent: Rectangle | undefined;
      let parentShiftY = 0;
      if (item.parent) {
        const parentCard = cardByEl.get(item.parent);
        if (parentCard) {
          parentShiftY = parentCard.ay;
          const b = parentCard.base;
          parent = { left: b.left + parentCard.inset, right: b.right - (parentCard.loss - parentCard.inset), top: b.top + parentShiftY, bottom: b.bottom + parentShiftY, width: b.width - parentCard.loss, height: b.height };
        } else {
          parent = fallbackParents.get(item.parent);
          if (!parent) {
            const r = item.parent.getBoundingClientRect();
            parent = { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
            fallbackParents.set(item.parent, parent);
          }
        }
        const reach = item.kind === 'cell' ? 80 : 144;
        if (parent.right < menu.left - reach || parent.left > menu.right + reach || parent.bottom < menu.top - reach || parent.top > menu.bottom + reach) {
          if (active.has(item)) samples.push({ item, x: 0, y: 0, scale: 1 });
          continue;
        }
      }
      if (item.epoch !== boxEpoch || !item.base) {
        const rect = item.el.getBoundingClientRect();
        if (!rect.width || !rect.height) {
          item.base = null; item.epoch = boxEpoch;
          if (active.has(item)) samples.push({ item, x: 0, y: 0, scale: 1 });
          continue;
        }
        const width = rect.width / item.scale, height = rect.height / item.scale;
        const left = rect.left - item.x - (width - rect.width) / 2, top = rect.top - item.y - parentShiftY - (height - rect.height) / 2;
        item.base = { left, top, right: left + width, bottom: top + height, width, height };
        item.epoch = boxEpoch;
      }
      const unshifted = item.base;
      const base = parentShiftY
        ? { left: unshifted.left, right: unshifted.right, top: unshifted.top + parentShiftY, bottom: unshifted.bottom + parentShiftY, width: unshifted.width, height: unshifted.height }
        : unshifted;
      if (base.bottom <= safeTop || base.top >= win.innerHeight) {
        if (active.has(item)) samples.push({ item, x: 0, y: 0, scale: 1 });
        continue;
      }
      const response = itemRepulsion(base, menu, item.kind, mobile);
      const insetX = base.width * (1 - response.scale) / 2, insetY = base.height * (1 - response.scale) / 2;
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
      if (settled) delete item.el.dataset.feelItemMoving; else item.el.dataset.feelItemMoving = 'true';
    }
    return moving;
  }
  return { refresh, invalidate() { targetsDirty = true; }, invalidateBoxes, read, paint, destroy() { disposed = true; observer.disconnect(); records.forEach(restore); records.clear(); visible.clear(); } };
}

/** The column count of a grid whose columns are all the same width, or 0. */
function equalColumns(el: HTMLElement, style: CSSStyleDeclaration) {
  if (!style.display.includes('grid') || el.classList.contains('sv-history-layout')) return 0;
  const tracks = style.gridTemplateColumns.split(' ').filter(track => track.endsWith('px')).map(parseFloat);
  return tracks.length > 1 && tracks.every(track => Math.abs(track - tracks[0]) < 1) ? tracks.length : 0;
}

/** Cards make room for the floating menu. On a desktop each top-level card
 * keeps its own layout slot and gives up width beside the menu (game-manage
 * card-avoidance); on a phone cards just above the tab-bar drawer rise into
 * free space. Inner records add their own small translation. Nothing here
 * cancels scrolling, selection or clicks, and nothing stays transformed or
 * promoted to its own layer once the motion has settled. */
export function createFeelCards(root: HTMLElement) {
  const win = root.ownerDocument.defaultView!, doc = root.ownerDocument;
  const reduced = win.matchMedia('(prefers-reduced-motion: reduce)');
  let cards: Card[] = [], dirty = true, layoutDirty = true, safeTop = 12, mode: 'desktop' | 'mobile' = 'desktop', menu: Rectangle | null = null, menuMoving = false, frame = 0, time = 0, destroyed = false;
  const cardByEl = new Map<HTMLElement, Card>();
  const items = createFeelItems(root, schedule, cardByEl);
  const heights = new WeakMap<Element, number>();
  const sizes = new ResizeObserver(entries => {
    let changed = false;
    for (const { target } of entries) {
      const height = target.getBoundingClientRect().height, previous = heights.get(target); heights.set(target, height);
      if (previous !== height) changed = true;
    }
    if (changed) { layoutDirty = true; items.invalidateBoxes(); schedule(); }
  });
  function restoreLayout(card: Card) {
    LAYOUT_PROPERTIES.forEach((key, index) => {
      const [value, priority] = card.saved[index];
      if (value) card.el.style.setProperty(key, value, priority); else card.el.style.removeProperty(key);
    });
    card.el.style.removeProperty('--feel-avoid-y');
    delete card.el.dataset.menuAvoidance; delete card.el.dataset.feelMoving;
  }
  function precedingBlocks(el: HTMLElement) {
    const result: Element[] = [];
    for (let node: Element | null = el; node && node !== root; node = node.parentElement) {
      for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (!sibling.matches('.feel-navigation, .feel-nav-drawer, .feel-nav-backdrop, .skip-link, script, style')) result.push(sibling);
      }
    }
    return result;
  }
  function measure() {
    const previous = new Map(cards.map(card => [card.el, card]));
    cards.forEach(restoreLayout); sizes.disconnect(); cardByEl.clear();
    cards = [...root.querySelectorAll<HTMLElement>(SELECTOR)]
      .filter(el => !el.parentElement?.closest(SELECTOR) && !el.closest('[role="dialog"], [hidden]'))
      .flatMap(el => {
        const rect = el.getBoundingClientRect(); if (!rect.width || !rect.height) return [];
        const old = previous.get(el), style = win.getComputedStyle(el);
        const slot = { left: rect.left, right: rect.right, width: rect.width, top: rect.top - (old?.ay || 0), bottom: rect.bottom - (old?.ay || 0), height: rect.height };
        const card: Card = { el, slot, base: slot, precedingBottom: null,
          saved: LAYOUT_PROPERTIES.map(key => [el.style.getPropertyValue(key), el.style.getPropertyPriority(key)] as [string, string]),
          ml: parseFloat(style.marginLeft) || 0, mr: parseFloat(style.marginRight) || 0, cols: equalColumns(el, style),
          loss: old?.loss || 0, inset: old?.inset || 0, vl: old?.vl || 0, vi: old?.vi || 0,
          side: old?.side || null, ay: old?.ay || 0, av: old?.av || 0, mobileTarget: 0, mobileLimit: 0, blockers: precedingBlocks(el), target: cardAvoidance(rect, null, { left: 0, right: win.innerWidth }) };
        cardByEl.set(el, card);
        return [card];
      });
    cards.forEach(card => sizes.observe(card.el)); dirty = false; layoutDirty = true;
  }
  function refreshLayout() {
    const topbar = root.querySelector('.app-topbar')?.getBoundingClientRect();
    safeTop = Math.max(12, topbar && topbar.top < win.innerHeight && topbar.bottom > 0 ? topbar.bottom + 4 : 0);
    const blockerRects = new Map<Element, { left: number; right: number; bottom: number; valid: boolean }>();
    for (const card of cards) {
      const actual = card.el.getBoundingClientRect();
      card.base = { ...card.slot, top: actual.top - card.ay, bottom: actual.bottom - card.ay, height: actual.height };
      blockerRects.set(card.el, { left: card.base.left, right: card.base.right, bottom: card.base.bottom, valid: Boolean(actual.width && actual.height) });
    }
    for (const card of cards) {
      let precedingBottom: number | null = null;
      for (const blocker of card.blockers) {
        let info = blockerRects.get(blocker);
        if (!info) {
          const rect = blocker.getBoundingClientRect();
          const ownShift = blocker instanceof HTMLElement ? parseFloat(blocker.style.getPropertyValue('--feel-avoid-y')) || 0 : 0;
          info = { left: rect.left, right: rect.right, bottom: rect.bottom - ownShift, valid: Boolean(rect.width && rect.height) };
          blockerRects.set(blocker, info);
        }
        if (info.valid && info.right > card.base.left && info.left < card.base.right && info.bottom > safeTop && info.bottom <= card.base.top + .5) {
          precedingBottom = Math.max(precedingBottom ?? 0, info.bottom);
        }
      }
      card.precedingBottom = precedingBottom;
    }
    layoutDirty = false;
  }
  function tick(now: number) {
    frame = 0;
    const dt = time ? (now - time) / 1000 : 1 / 60; time = now;
    if (dirty) measure();
    if (layoutDirty) refreshLayout();
    const viewport = { left: 0, right: doc.documentElement.clientWidth || win.innerWidth };
    for (const card of cards) {
      card.target = cardAvoidance(card.base, mode === 'desktop' ? menu : null, viewport, card.side);
      card.side = card.target.side;
      const mobileResponse = mode === 'mobile' ? mobileCardAvoidance(card.base, menu, safeTop, card.precedingBottom) : { y: 0, available: 0 };
      card.mobileTarget = mobileResponse.y; card.mobileLimit = mobileResponse.available;
    }
    items.read(menu, mode === 'mobile', safeTop, reduced.matches, menuMoving);
    let moving = false, outerChanged = false, widthChanged = false;
    for (const card of cards) {
      const beforeLoss = card.loss, beforeInset = card.inset, beforeY = card.ay;
      let cardMoving = false;
      for (const [key, velocity] of [['loss', 'vl'], ['inset', 'vi']] as const) {
        if (reduced.matches) { card[key] = card.target[key]; card[velocity] = 0; }
        else [card[key], card[velocity]] = springStep(card[key], card[velocity], card.target[key], dt, ...SLOT_SPRING);
        if (Math.abs(card[key] - card.target[key]) < .03 && Math.abs(card[velocity]) < .1) { card[key] = card.target[key]; card[velocity] = 0; }
        else cardMoving = true;
      }
      card.loss = clamp(card.loss, 0, card.target.limit); card.inset = clamp(card.inset, 0, card.loss);
      if (reduced.matches) { card.ay = card.mobileTarget; card.av = 0; }
      else [card.ay, card.av] = springStep(card.ay, card.av, card.mobileTarget, dt, ...SLOT_SPRING);
      if (Math.abs(card.ay - card.mobileTarget) < .02 && Math.abs(card.av) < .1) { card.ay = card.mobileTarget; card.av = 0; }
      else cardMoving = true;
      // The spring cannot overshoot a safety boundary or cover preceding content.
      card.ay = clamp(card.ay, -card.mobileLimit, 0);
      if (card.loss < .03 && card.target.loss === 0 && Math.abs(card.ay) <= .01) restoreLayout(card);
      else {
        if (card.loss >= .03 || card.target.loss > 0) {
          // A grid of equal columns keeps its column count while it narrows,
          // so cards shrink in place instead of jumping to another row.
          if (card.cols) card.el.style.gridTemplateColumns = `repeat(${card.cols}, minmax(0, 1fr))`;
          card.el.style.width = `${(card.slot.width - card.loss).toFixed(2)}px`;
          card.el.style.marginLeft = `${(card.ml + card.inset).toFixed(2)}px`;
          card.el.style.marginRight = `${(card.mr + card.loss - card.inset).toFixed(2)}px`;
          card.el.dataset.menuAvoidance = card.target.covered ? 'overlap' : 'clear';
        }
        if (Math.abs(card.ay) > .01) {
          card.el.style.setProperty('--feel-avoid-y', `${(cardMoving ? card.ay : Math.round(card.ay)).toFixed(cardMoving ? 3 : 0)}px`);
          card.el.dataset.menuAvoidance = 'mobile';
        } else card.el.style.removeProperty('--feel-avoid-y');
        if (cardMoving && !reduced.matches) card.el.dataset.feelMoving = 'true'; else delete card.el.dataset.feelMoving;
      }
      if (cardMoving) moving = true;
      const dWidth = Math.abs(card.loss - beforeLoss) + Math.abs(card.inset - beforeInset);
      if (dWidth > .001) widthChanged = true;
      if (dWidth + Math.abs(card.ay - beforeY) > .001) outerChanged = true;
    }
    const innerMoving = items.paint(dt, reduced.matches);
    if (widthChanged) { layoutDirty = true; items.invalidateBoxes(); }
    else if (outerChanged) items.invalidate();
    if (moving || innerMoving || outerChanged) frame = win.requestAnimationFrame(tick); else time = 0;
  }
  function schedule() { if (!destroyed && !frame) frame = win.requestAnimationFrame(tick); }
  const scroll = () => { layoutDirty = true; items.invalidateBoxes(); if (menu) schedule(); };
  const changed = () => { dirty = true; layoutDirty = true; items.refresh(); schedule(); };
  // Re-measure when cards come or go, and when a scroll-revealed card drops
  // its entrance transform: a slot measured mid-rise would be off by its scale.
  const observer = new MutationObserver(changes => {
    if (changes.some(change => change.type === 'attributes' || [...change.addedNodes, ...change.removedNodes].some(node => node.nodeType === 1))) changed();
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-reveal', 'open'] });
  doc.addEventListener('scroll', scroll, { passive: true, capture: true });
  reduced.addEventListener('change', changed); win.addEventListener('resize', changed);
  return {
    /** `moving` says whether the menu is being dragged or is still settling. */
    update(rect: Rectangle | null, nextMode: 'desktop' | 'mobile' = 'desktop', moving = false) {
      if (!rect || !menu || nextMode !== mode || moving !== menuMoving || Math.abs(rect.left - menu.left) + Math.abs(rect.top - menu.top) + Math.abs(rect.width - menu.width) + Math.abs(rect.height - menu.height) > .01) items.invalidate();
      menu = rect; mode = nextMode; menuMoving = moving; schedule();
    },
    destroy() {
      destroyed = true; win.cancelAnimationFrame(frame); observer.disconnect(); sizes.disconnect(); items.destroy(); cards.forEach(restoreLayout);
      doc.removeEventListener('scroll', scroll, true); reduced.removeEventListener('change', changed); win.removeEventListener('resize', changed);
    },
  };
}
