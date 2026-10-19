import { useEffect, useLayoutEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronUp } from 'lucide-react';
import { AnimatedNavIcon } from './AnimatedNavIcon';
import { createFeelCards } from './lib/feel-cards';
import { DRAWER_STOP_ORDER, drawerAtRest, drawerStops, moveHand, nearestStop, nextDrawerStop, predictStop, pushToStop, stepDrawer, type DrawerBody, type DrawerStop } from './lib/drawer-physics';
import { clamp, CORNERS, cornerPosition, navigationBounds, projectedCorner, springStep, SLOT_SPRING, type Corner } from './lib/feel-physics';
import type { PageId } from './pages';
import './floating-navigation.css';

export const MOBILE_NAV_QUERY = '(max-width: 760px), (max-width: 960px) and (max-height: 500px)';
const STORAGE_KEY = 'cloud-monitor-navigation-corner';
type Props = { children: ReactNode; open: boolean; onOpenChange: (open: boolean) => void; pageName: string; currentPage: PageId; onNavigate: (page: PageId) => void };
type HandleController = { down(event: React.PointerEvent<HTMLElement>): void; key(event: React.KeyboardEvent<HTMLElement>): void; click(event: React.MouseEvent<HTMLElement>): void };
// Focus handed over after a tap or drag should not draw the keyboard ring;
// after a key press it should. The latest input decides.
let keyboardInput = false;
const quietFocus = (node: HTMLElement | null | undefined) => node?.focus({ preventScroll: true, focusVisible: keyboardInput } as FocusOptions);

/** Desktop corner navigation, and on phones a tab bar with the menu in a panel that slides up behind it. */
export function FloatingNavigation(props: Props) {
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_NAV_QUERY).matches);
  const latest = useRef(props); latest.current = props;
  const returnAfterResize = useRef(false);
  useEffect(() => {
    const key = () => { keyboardInput = true; }, pointer = () => { keyboardInput = false; };
    window.addEventListener('keydown', key, true); window.addEventListener('pointerdown', pointer, true);
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('pointerdown', pointer, true); };
  }, []);
  useEffect(() => {
    const query = window.matchMedia(MOBILE_NAV_QUERY);
    const change = () => {
      returnAfterResize.current = Boolean(document.activeElement?.closest('.feel-nav-drawer, .feel-navigation'));
      setMobile(query.matches); latest.current.onOpenChange(false);
    };
    query.addEventListener('change', change); return () => query.removeEventListener('change', change);
  }, []);
  useLayoutEffect(() => {
    if (returnAfterResize.current) {
      returnAfterResize.current = false;
      quietFocus(document.querySelector<HTMLElement>(mobile ? '[data-mobile-navigation-trigger]' : '.feel-nav-handle'));
    }
  }, [mobile]);
  return mobile ? <MobileDrawer {...props} /> : <DesktopNavigation>{props.children}</DesktopNavigation>;
}

/** Thrown to the nearest corner on release (game-manage floating navigation):
 * the release keeps 70ms of its velocity and a mass-1 spring (k 260, c 28)
 * settles it 16px from the edges. Cards make room as it moves. */
function DesktopNavigation({ children }: { children: ReactNode }) {
  const surface = useRef<HTMLElement | null>(null);
  const controller = useRef<HandleController | null>(null), contentId = useId(), hintId = useId();
  useLayoutEffect(() => {
    const win = window, reduced = win.matchMedia('(prefers-reduced-motion: reduce)');
    const cards = createFeelCards(document.querySelector<HTMLElement>('.app-shell') || document.body);
    let frame = 0, last = 0, disposed = false, suppressed = 0, springing = false, corner: Corner = 'top-left';
    try { const saved = localStorage.getItem(STORAGE_KEY); if (CORNERS.includes(saved as Corner)) corner = saved as Corner; } catch { /* Optional preference. */ }
    let x = 16, y = 16, vx = 0, vy = 0, tx = x, ty = y, navW = 216, navH = 60;
    let gesture: { id: number; handle: HTMLElement; startX: number; startY: number; x: number; y: number; lastX: number; lastY: number; at: number; moved: boolean; corner: Corner } | null = null;
    const measureSize = () => { navW = surface.current?.offsetWidth || 216; navH = surface.current?.offsetHeight || 60; };
    const bounds = () => navigationBounds(win.innerWidth, win.innerHeight, navW, navH);
    function paint() {
      const el = surface.current; if (!el) return;
      const b = bounds(); x = clamp(x, b.left, b.right); y = clamp(y, b.top, b.bottom);
      el.style.transform = `translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,0)`;
      el.dataset.dragging = String(Boolean(gesture?.moved));
      cards.update({ left: x, top: y, right: x + navW, bottom: y + navH, width: navW, height: navH }, 'desktop', Boolean(gesture?.moved) || springing);
    }
    function stop() { win.cancelAnimationFrame(frame); frame = 0; last = 0; }
    function settle() { stop(); springing = false; x = tx; y = ty; vx = vy = 0; paint(); }
    function tick(now: number) {
      frame = 0; const dt = last ? (now - last) / 1000 : 1 / 60; last = now;
      [x, vx] = springStep(x, vx, tx, dt, ...SLOT_SPRING); [y, vy] = springStep(y, vy, ty, dt, ...SLOT_SPRING);
      if (Math.hypot(x - tx, y - ty) < .1 && Math.hypot(vx, vy) < 1) settle();
      else { paint(); frame = win.requestAnimationFrame(tick); }
    }
    function start() { if (disposed || gesture) return; if (reduced.matches) settle(); else if (!frame) { springing = true; frame = win.requestAnimationFrame(tick); } }
    function choose(next: Corner) {
      corner = next; ({ x: tx, y: ty } = cornerPosition(corner, bounds()));
      try { localStorage.setItem(STORAGE_KEY, corner); } catch { /* Optional preference. */ } start();
    }
    const end = (event?: PointerEvent, cancelled = false) => {
      const g = gesture; if (!g || (event && event.pointerId !== g.id)) return; gesture = null;
      try { if (g.handle.hasPointerCapture(g.id)) g.handle.releasePointerCapture(g.id); } catch { /* Removed handle. */ }
      if (performance.now() - g.at > 60) vx = vy = 0;
      if (g.moved) suppressed = performance.now() + 700;
      choose(cancelled ? g.corner : g.moved ? projectedCorner(x, y, vx, vy, bounds()) : corner); paint();
    };
    const move = (event: PointerEvent) => {
      const g = gesture; if (!g || event.pointerId !== g.id) return;
      const dx = event.clientX - g.startX, dy = event.clientY - g.startY; if (!g.moved && Math.hypot(dx, dy) < 6) return;
      g.moved = true; event.preventDefault(); const at = performance.now(), dt = Math.max(.008, (at - g.at) / 1000), b = bounds();
      x = clamp(g.x + dx, b.left, b.right); y = clamp(g.y + dy, b.top, b.bottom);
      vx = clamp((event.clientX - g.lastX) / dt, -4000, 4000); vy = clamp((event.clientY - g.lastY) / dt, -4000, 4000);
      g.lastX = event.clientX; g.lastY = event.clientY; g.at = at; paint();
    };
    controller.current = {
      down(event) {
        if (event.button !== 0 || event.isPrimary === false || gesture) return;
        // No preventDefault and no focus() call: the browser focuses the grip
        // as a pointer press, which never draws the keyboard focus ring.
        suppressed = 0; stop();
        gesture = { id: event.pointerId, handle: event.currentTarget, startX: event.clientX, startY: event.clientY, x, y, lastX: event.clientX, lastY: event.clientY, at: performance.now(), moved: false, corner };
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Global listeners retain gesture. */ }
      },
      key(event) {
        let next: Corner = corner;
        if (event.key === 'ArrowLeft') next = corner.replace('right', 'left') as Corner;
        else if (event.key === 'ArrowRight') next = corner.replace('left', 'right') as Corner;
        else if (event.key === 'ArrowUp') next = corner.replace('bottom', 'top') as Corner;
        else if (event.key === 'ArrowDown') next = corner.replace('top', 'bottom') as Corner;
        else if (event.key === 'Home') next = 'top-left';
        else if (event.key === 'End') next = 'bottom-right';
        else if (event.key === 'Enter' || event.key === ' ') next = CORNERS[(CORNERS.indexOf(corner) + 1) % CORNERS.length];
        else return;
        event.preventDefault(); choose(next);
      },
      click(event) { if (event.detail !== 0 && performance.now() < suppressed) { event.preventDefault(); event.stopPropagation(); } },
    };
    const resize = () => { measureSize(); if (gesture) end(undefined, true); stop(); ({ x: tx, y: ty } = cornerPosition(corner, bounds())); settle(); };
    // A taller or shorter menu moves its corner target; it glides there.
    const refit = () => { measureSize(); ({ x: tx, y: ty } = cornerPosition(corner, bounds())); start(); };
    const cancel = (event: PointerEvent) => end(event, true), up = (event: PointerEvent) => end(event), blur = () => end(undefined, true);
    const reducedChanged = () => { if (reduced.matches) settle(); }, sizes = new ResizeObserver(refit);
    if (surface.current) sizes.observe(surface.current);
    const freshPress = () => { if (!gesture) suppressed = 0; }, suppressClick = (event: MouseEvent) => {
      if (event.detail !== 0 && performance.now() < suppressed) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    win.addEventListener('pointerdown', freshPress, true); win.addEventListener('click', suppressClick, true);
    win.addEventListener('pointermove', move, { passive: false }); win.addEventListener('pointerup', up); win.addEventListener('pointercancel', cancel); win.addEventListener('lostpointercapture', cancel); win.addEventListener('blur', blur); win.addEventListener('resize', resize);
    win.visualViewport?.addEventListener('resize', resize); reduced.addEventListener('change', reducedChanged); resize();
    return () => {
      disposed = true; if (gesture) { try { gesture.handle.releasePointerCapture(gesture.id); } catch { /* Removed handle. */ } } stop(); controller.current = null; cards.destroy(); sizes.disconnect();
      win.removeEventListener('pointerdown', freshPress, true); win.removeEventListener('click', suppressClick, true); win.removeEventListener('pointermove', move); win.removeEventListener('pointerup', up); win.removeEventListener('pointercancel', cancel); win.removeEventListener('lostpointercapture', cancel); win.removeEventListener('blur', blur); win.removeEventListener('resize', resize);
      win.visualViewport?.removeEventListener('resize', resize); reduced.removeEventListener('change', reducedChanged);
    };
  }, []);
  return <aside ref={surface} className="feel-navigation" aria-label="主导航">
    <button type="button" className="feel-nav-handle" onPointerDown={event => controller.current?.down(event)} onKeyDown={event => controller.current?.key(event)} onClick={event => controller.current?.click(event)} aria-label="移动导航菜单" aria-describedby={hintId}><span aria-hidden="true" /></button>
    <span id={hintId} className="sr-only">拖动后松手，菜单会停在最近的角落。也可使用方向键移动。</span>
    <nav id={contentId} className="feel-nav-content" aria-label="页面导航">{children}</nav>
  </aside>;
}

type MobileController = HandleController & { sync(open: boolean): void; close(): void; toggle(opener: HTMLElement): void };
const QUICK_PAGES = [{ id: 'overview', label: '总览' }, { id: 'models', label: '模型分析' }, { id: 'quota', label: '配额与订阅' }] as const;
/** The grip strip a closed panel shows above the 64px tab bar. */
const PEEK = 20;
const GRIP_HEIGHT = 28;
/** The panel reaches this far below the screen (--nav-overhang), so a pull
 * past the open stop never shows the page beneath it. */
const OVERHANG = 48;
/** Feel's magnetic drawer (lib/drawer-physics.ts) moving one panel of fixed
 * height, docked to the bottom edge. Per frame only its translateY changes,
 * with the tab bar inside it moved back by as much so the bar stays put, and
 * the scrim's opacity: nothing the rows inherit, so no frame restyles them.
 * A tap on the grip pushes the panel exactly as far as the next stop
 * (closed, half, open); a drag holds it through a spring, with the stops felt
 * as detents, and a release coasts on until the nearest magnet catches it. */
function MobileDrawer({ children, open, onOpenChange, currentPage, onNavigate }: Props) {
  const surface = useRef<HTMLElement | null>(null), content = useRef<HTMLElement | null>(null), inner = useRef<HTMLDivElement | null>(null), spacer = useRef<HTMLDivElement | null>(null);
  const quick = useRef<HTMLElement | null>(null), handle = useRef<HTMLButtonElement | null>(null), backdrop = useRef<HTMLDivElement | null>(null);
  const controller = useRef<MobileController | null>(null), latest = useRef({ open, onOpenChange }); latest.current = { open, onOpenChange };
  const opener = useRef<HTMLElement | null>(null), wasOpen = useRef(false), menuId = useId(), titleId = useId(), hintId = useId();
  useLayoutEffect(() => {
    const win = window, el = surface.current!, menu = content.current!, list = inner.current!, pad = spacer.current!, bar = quick.current!;
    const reduced = win.matchMedia('(prefers-reduced-motion: reduce)');
    const cards = createFeelCards(document.querySelector<HTMLElement>('.app-shell') || document.body);
    // Geometry, read only when the screen or the menu changes size: inside a
    // frame any read, on phones even innerHeight, forces a style pass.
    let viewport = 0, height = 0, barHeight = 64, natural = 0, box = 0, left = 0, width = 0, stops = drawerStops(0, 0);
    function measure() {
      const style = win.getComputedStyle(menu);
      viewport = win.innerHeight;
      barHeight = bar.offsetHeight || 64;
      const border = parseFloat(win.getComputedStyle(el).borderTopWidth) || 0;
      natural = list.offsetHeight + (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
      // The open stop fits the whole menu when the screen allows.
      height = Math.max(PEEK + barHeight, Math.min(viewport - 24, natural + GRIP_HEIGHT + barHeight + border));
      box = height - border - GRIP_HEIGHT - barHeight;
      stops = drawerStops(height, PEEK + barHeight);
      el.style.setProperty('--nav-open-height', `${height}px`);
      width = el.offsetWidth; left = el.offsetLeft;
    }
    measure();
    const body: DrawerBody = { x: stops.closed, v: 0, hand: null };
    let frame = 0, last = 0, disposed = false, logicalOpen = latest.current.open, suppressed = 0;
    let stop: DrawerStop = 'closed', heading: DrawerStop = 'closed', moving = false, caught = false, tapFrom: DrawerStop | null = null;
    let gesture: { id: number; startY: number; x: number; time: number; heading: DrawerStop; moved: boolean } | null = null;
    // How much of the menu's scroll box the half stop hides, and its scroll
    // position as last seen (read on scroll, never inside a frame).
    let hidden = 0, scrolled = 0;
    function announce(value: boolean) { if (logicalOpen !== value) { logicalOpen = value; latest.current.onOpenChange(value); } }
    function paint() {
      const y = body.x, travel = stops.closed;
      // A menu scrolled at the half stop keeps its last row at the visible
      // bottom while the panel rises, so no scroll position ever has to be
      // clamped (and jump) when the panel comes to rest.
      if (hidden && moving) {
        const limit = Math.max(0, natural - box + Math.max(0, y));
        if (scrolled > limit + .5) { menu.scrollTop = limit; scrolled = limit; }
      }
      el.style.transform = `translate3d(0,${y.toFixed(2)}px,0)`;
      bar.style.transform = `translate3d(0,${(-Math.min(y, travel)).toFixed(2)}px,0)`;
      const shown = travel ? clamp(1 - y / travel, 0, 1) : 0;
      if (backdrop.current) backdrop.current.style.opacity = shown.toFixed(4);
      const top = Math.max(0, viewport - height + y);
      cards.update(shown > .001 ? { left, right: left + width, top, bottom: viewport, width, height: viewport - top } : null, 'mobile', moving && !caught);
    }
    // At rest the menu's scroll box is exactly what the panel shows, so focus
    // and scrollIntoView reach every row from the half stop. While the panel
    // moves the box takes its full height and a spacer keeps the scroll range
    // the same, so rows never jump and a scrolled menu keeps its place.
    function restScroll() {
      hidden = stop === 'half' ? stops.half : 0;
      pad.style.height = '';
      menu.style.bottom = hidden ? `${OVERHANG + barHeight + hidden}px` : '';
      if (stop === 'closed') menu.scrollTop = 0;
    }
    function startMotion() {
      if (moving) return;
      moving = true; el.dataset.drawerMoving = 'true'; el.dataset.drawerStop = 'moving';
      if (hidden) { scrolled = menu.scrollTop; menu.style.bottom = ''; pad.style.height = `${hidden}px`; }
    }
    function settle(next: DrawerStop) {
      win.cancelAnimationFrame(frame); frame = 0; last = 0;
      body.x = stops[next]; body.v = 0; body.hand = null;
      moving = caught = false; tapFrom = null; stop = heading = next;
      el.dataset.drawerStop = next; delete el.dataset.drawerMoving;
      restScroll(); paint(); announce(next !== 'closed');
    }
    function tick(now: number) {
      frame = 0;
      const dt = last ? Math.min(1 / 30, (now - last) / 1000) : 1 / 60; last = now;
      stepDrawer(body, stops, dt);
      if (drawerAtRest(body, stops)) { settle(nearestStop(body.x, stops)); return; }
      // Lifting the panel off the closed stop by hand opens the menu.
      if (gesture?.moved && body.x < stops.closed * .97) announce(true);
      paint();
      frame = win.requestAnimationFrame(tick);
    }
    function run() { if (!frame && !disposed && !caught) { last = 0; frame = win.requestAnimationFrame(tick); } }
    function go(next: DrawerStop) {
      if (disposed) return;
      // A route change or Escape can close the drawer under a held pointer.
      if (gesture) {
        const g = gesture; gesture = null;
        try { if (handle.current?.hasPointerCapture(g.id)) handle.current.releasePointerCapture(g.id); } catch { /* Removed handle. */ }
        if (g.moved) suppressed = performance.now() + 700;
      }
      body.hand = null; caught = false; heading = next; announce(next !== 'closed');
      if (reduced.matches || (!moving && body.x === stops[next])) { settle(next); return; }
      body.v += pushToStop(body.x, body.v, next, stops);
      startMotion(); run();
    }
    const remember = () => { if (!logicalOpen) opener.current = handle.current; };
    const move = (event: PointerEvent) => {
      const g = gesture; if (!g || event.pointerId !== g.id) return;
      const dy = event.clientY - g.startY; if (!g.moved && Math.abs(dy) < 4) return;
      event.preventDefault();
      const now = performance.now();
      if (!g.moved || !body.hand) { g.moved = true; caught = false; startMotion(); body.hand = { x: g.x + dy, v: 0, t: now }; }
      else body.hand = moveHand(body.hand, g.x + dy, now);
      g.time = now;
      run();
    };
    const end = (event?: PointerEvent, cancelled = false) => {
      const g = gesture; if (!g || (event && event.pointerId !== g.id)) return; gesture = null;
      try { if (handle.current?.hasPointerCapture(g.id)) handle.current.releasePointerCapture(g.id); } catch { /* Removed handle. */ }
      if (!g.moved) {
        // A press. A caught panel is let go where it was held; the click that
        // follows a tap steps on from where the panel was heading.
        tapFrom = g.heading;
        if (caught) { caught = false; run(); }
        return;
      }
      suppressed = performance.now() + 700;
      if (cancelled) { go(g.heading); return; }
      // A finger that rested before letting go releases without momentum.
      if (performance.now() - g.time > 60) body.v = 0;
      body.hand = null;
      heading = predictStop(body.x, body.v, stops); announce(heading !== 'closed');
      run();
    };
    controller.current = {
      down(event) {
        if (event.button !== 0 || event.isPrimary === false || gesture) return;
        remember(); suppressed = 0; tapFrom = null;
        // Catch a moving panel where it is drawn.
        if (frame) { win.cancelAnimationFrame(frame); frame = 0; last = 0; caught = true; body.v = 0; body.hand = null; paint(); }
        gesture = { id: event.pointerId, startY: event.clientY, x: body.x, time: performance.now(), heading, moved: false };
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Global listeners retain gesture. */ }
      },
      key(event) {
        const index = DRAWER_STOP_ORDER.indexOf(heading);
        let next: DrawerStop | null = null;
        if (event.key === 'ArrowUp' || event.key === 'ArrowRight') next = DRAWER_STOP_ORDER[Math.min(2, index + 1)];
        else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') next = DRAWER_STOP_ORDER[Math.max(0, index - 1)];
        else if (event.key === 'Home') next = 'open';
        else if (event.key === 'End') next = 'closed';
        if (!next) return;
        event.preventDefault(); remember(); go(next);
      },
      click(event) {
        if (event.detail !== 0 && performance.now() < suppressed) { event.preventDefault(); event.stopPropagation(); return; }
        const from = tapFrom ?? heading; tapFrom = null;
        remember(); go(nextDrawerStop(from));
      },
      sync(value) { if (value === logicalOpen) return; logicalOpen = value; if (value) { opener.current ||= handle.current; go('half'); } else go('closed'); },
      close() { go('closed'); },
      toggle(button) { if (!logicalOpen) opener.current = button; go(heading === 'open' ? 'closed' : 'open'); },
    };
    // The menu's own size (a wrapped label) only refits the stops; a drag or
    // a glide in progress carries on towards the new ones.
    const refit = () => { measure(); if (!moving && !gesture) { body.x = stops[stop]; restScroll(); } paint(); };
    const resize = () => {
      // A new viewport invalidates the pointer's starting coordinate.
      if (gesture) end(undefined, true);
      refit();
      if (!frame) settle(stop);
    };
    const sizes = new ResizeObserver(refit); sizes.observe(list);
    const scroll = () => { scrolled = menu.scrollTop; };
    const freshPress = () => { if (!gesture) suppressed = 0; }, suppressClick = (event: MouseEvent) => {
      if (event.detail !== 0 && performance.now() < suppressed) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    const reducedChanged = () => { if (reduced.matches && !gesture) settle(heading); };
    const up = (event: PointerEvent) => end(event), cancel = (event: PointerEvent) => end(event, true), blur = () => end(undefined, true);
    menu.addEventListener('scroll', scroll, { passive: true });
    win.addEventListener('pointermove', move, { passive: false }); win.addEventListener('pointerup', up); win.addEventListener('pointercancel', cancel); win.addEventListener('lostpointercapture', cancel); win.addEventListener('blur', blur);
    win.addEventListener('pointerdown', freshPress, true); win.addEventListener('click', suppressClick, true);
    win.addEventListener('resize', resize); win.visualViewport?.addEventListener('resize', resize); reduced.addEventListener('change', reducedChanged);
    settle('closed');
    return () => {
      disposed = true; win.cancelAnimationFrame(frame); controller.current = null; sizes.disconnect(); cards.destroy();
      if (gesture) { try { handle.current?.releasePointerCapture(gesture.id); } catch { /* Removed handle. */ } }
      menu.removeEventListener('scroll', scroll);
      win.removeEventListener('pointermove', move); win.removeEventListener('pointerup', up); win.removeEventListener('pointercancel', cancel); win.removeEventListener('lostpointercapture', cancel); win.removeEventListener('blur', blur);
      win.removeEventListener('pointerdown', freshPress, true); win.removeEventListener('click', suppressClick, true); win.removeEventListener('resize', resize);
      win.visualViewport?.removeEventListener('resize', resize); reduced.removeEventListener('change', reducedChanged);
    };
  }, []);
  useLayoutEffect(() => { controller.current?.sync(open); }, [open]);
  useLayoutEffect(() => {
    const el = surface.current!;
    if (!open) {
      if (!wasOpen.current) return;
      wasOpen.current = false;
      const timer = window.setTimeout(() => {
        if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
        const target = opener.current?.isConnected ? opener.current : handle.current; opener.current = null;
        quietFocus(target);
      }, 0);
      return () => window.clearTimeout(timer);
    }
    wasOpen.current = true;
    const body = document.body, saved = { overflow: body.style.overflow, paddingRight: body.style.paddingRight };
    const background = [...document.querySelectorAll<HTMLElement>('.workspace-main, .skip-link')].map(node => ({ node, inert: node.inert }));
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = 'hidden'; if (scrollbar) body.style.paddingRight = `${parseFloat(getComputedStyle(body).paddingRight) + scrollbar}px`;
    background.forEach(({ node }) => { node.inert = true; }); quietFocus(handle.current);
    const focusable = () => [...el.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]')].filter(node => node.getClientRects().length && !node.closest('[inert]'));
    const keydown = (event: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"][data-state="open"]:not(.feel-nav-drawer)')) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); controller.current?.close(); }
      if (event.key === 'Tab') {
        const items = focusable(), first = items[0], last = items[items.length - 1];
        if (event.shiftKey && (document.activeElement === first || !el.contains(document.activeElement))) { event.preventDefault(); last?.focus({ preventScroll: true }); }
        else if (!event.shiftKey && (document.activeElement === last || !el.contains(document.activeElement))) { event.preventDefault(); first?.focus({ preventScroll: true }); }
      }
    };
    const focusin = (event: FocusEvent) => { if (!el.contains(event.target as Node) && !document.querySelector('[role="dialog"][data-state="open"]:not(.feel-nav-drawer)')) quietFocus(handle.current); };
    document.addEventListener('keydown', keydown, true); document.addEventListener('focusin', focusin);
    return () => {
      body.style.overflow = saved.overflow; body.style.paddingRight = saved.paddingRight;
      background.forEach(({ node, inert }) => { node.inert = inert; });
      document.removeEventListener('keydown', keydown, true); document.removeEventListener('focusin', focusin);
    };
  }, [open]);
  return <>
    <div ref={backdrop} className="feel-nav-backdrop" data-active={open} aria-hidden="true" onPointerDown={() => controller.current?.close()} />
    <section ref={surface} className="feel-nav-drawer" role={open ? 'dialog' : undefined} aria-modal={open || undefined} aria-labelledby={open ? titleId : undefined} data-state={open ? 'open' : 'closed'}>
      <h2 id={titleId} className="sr-only">导航</h2>
      <button ref={handle} type="button" className="feel-sheet-handle feel-nav-peek" data-mobile-navigation-trigger aria-label={open ? '调整导航高度' : '打开导航'} aria-expanded={open} aria-controls={menuId} aria-describedby={hintId} onPointerDown={event => controller.current?.down(event)} onKeyDown={event => controller.current?.key(event)} onClick={event => controller.current?.click(event)}><span aria-hidden="true" /></button>
      <button type="button" className="feel-sheet-close" aria-label="关闭导航" aria-hidden={!open} tabIndex={open ? undefined : -1} inert={!open} onClick={() => controller.current?.close()}><AnimatedNavIcon name="close" size={19} /></button>
      <nav id={menuId} ref={content} className="feel-nav-content" aria-label="页面导航" inert={!open} aria-hidden={!open} onClick={event => { if ((event.target as Element).closest('a[href^="#"]')) latest.current.onOpenChange(false); }}><div ref={inner} className="feel-nav-inner">{children}</div><div ref={spacer} className="feel-nav-spacer" aria-hidden="true" /></nav>
      <nav ref={quick} className="feel-quick-navigation" aria-label="常用页面">
        {QUICK_PAGES.map(page => <a key={page.id} href={`#${page.id}`} aria-current={currentPage === page.id ? 'page' : undefined} onClick={event => { event.preventDefault(); onNavigate(page.id); }}><AnimatedNavIcon name={page.id} size={20} active={currentPage === page.id} /><span>{page.label}</span></a>)}
        <button type="button" className="feel-more" aria-expanded={open} aria-controls={menuId} onClick={event => controller.current?.toggle(event.currentTarget)}><ChevronUp size={20} aria-hidden="true" /><span>更多</span></button>
      </nav>
      <span id={hintId} className="sr-only">点击抓手依次半开、展开和收起，也可上下拖动或使用方向键。</span>
    </section>
  </>;
}
