import { useEffect, useLayoutEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronUp } from 'lucide-react';
import { AnimatedNavIcon } from './AnimatedNavIcon';
import { createFeelCards } from './lib/feel-cards';
import { chooseDrawerStop, DRAWER_STOPS, nextDrawerStop, resistDrawerProgress, stepDrawerSpring, unresistDrawerProgress, type DrawerStop } from './lib/drawer-physics';
import { clamp, CORNERS, cornerPosition, navigationBounds, projectedCorner, springStep, SLOT_SPRING, type Corner } from './lib/feel-physics';
import type { PageId } from './pages';
import './floating-navigation.css';

export const MOBILE_NAV_QUERY = '(max-width: 760px), (max-width: 960px) and (max-height: 500px)';
const STORAGE_KEY = 'cloud-monitor-navigation-corner';
/** The phone tab bar: a 64px row of pages under a 20px strip for the grip. */
const BAR_HEIGHT = 84;
const GRIP_HEIGHT = 28;
type Props = { children: ReactNode; open: boolean; onOpenChange: (open: boolean) => void; pageName: string; currentPage: PageId; onNavigate: (page: PageId) => void };
type HandleController = { down(event: React.PointerEvent<HTMLElement>): void; key(event: React.KeyboardEvent<HTMLElement>): void; click(event: React.MouseEvent<HTMLElement>): void };
// Programmatic focus after a tap should not draw the keyboard ring.
const quietFocus = (node: HTMLElement | null | undefined) => node?.focus({ preventScroll: true, focusVisible: false } as FocusOptions);

/** Desktop corner navigation and the phone tab bar that grows into the menu. */
export function FloatingNavigation(props: Props) {
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_NAV_QUERY).matches);
  const latest = useRef(props); latest.current = props;
  const returnAfterResize = useRef(false);
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
    let x = 16, y = 16, vx = 0, vy = 0, tx = x, ty = y;
    let gesture: { id: number; handle: HTMLElement; startX: number; startY: number; x: number; y: number; lastX: number; lastY: number; at: number; moved: boolean; corner: Corner } | null = null;
    const bounds = () => navigationBounds(win.innerWidth, win.innerHeight, surface.current?.offsetWidth || 216, surface.current?.offsetHeight || 60);
    function paint() {
      const el = surface.current; if (!el) return;
      const b = bounds(); x = clamp(x, b.left, b.right); y = clamp(y, b.top, b.bottom);
      el.style.transform = `translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,0)`;
      el.dataset.dragging = String(Boolean(gesture?.moved));
      cards.update(el.getBoundingClientRect(), 'desktop', Boolean(gesture?.moved) || springing);
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
    const resize = () => { if (gesture) end(undefined, true); stop(); ({ x: tx, y: ty } = cornerPosition(corner, bounds())); settle(); };
    // A taller or shorter menu moves its corner target; it glides there.
    const refit = () => { ({ x: tx, y: ty } = cornerPosition(corner, bounds())); start(); };
    const cancel = (event: PointerEvent) => end(event, true), up = (event: PointerEvent) => end(event), blur = () => end(undefined, true);
    const reducedChanged = () => { if (reduced.matches) settle(); }, sizes = new ResizeObserver(refit);
    if (surface.current) sizes.observe(surface.current);
    const freshPress = () => { if (!gesture) suppressed = 0; }, suppressClick = (event: MouseEvent) => {
      if (event.detail !== 0 && performance.now() < suppressed) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    win.addEventListener('pointerdown', freshPress, true); win.addEventListener('click', suppressClick, true);
    win.addEventListener('pointermove', move, { passive: false }); win.addEventListener('pointerup', up); win.addEventListener('pointercancel', cancel); win.addEventListener('blur', blur); win.addEventListener('resize', resize);
    win.visualViewport?.addEventListener('resize', resize); reduced.addEventListener('change', reducedChanged); resize();
    return () => {
      disposed = true; if (gesture) { try { gesture.handle.releasePointerCapture(gesture.id); } catch { /* Removed handle. */ } } stop(); controller.current = null; cards.destroy(); sizes.disconnect();
      win.removeEventListener('pointerdown', freshPress, true); win.removeEventListener('click', suppressClick, true); win.removeEventListener('pointermove', move); win.removeEventListener('pointerup', up); win.removeEventListener('pointercancel', cancel); win.removeEventListener('blur', blur); win.removeEventListener('resize', resize);
      win.visualViewport?.removeEventListener('resize', resize); reduced.removeEventListener('change', reducedChanged);
    };
  }, []);
  return <aside ref={surface} className="feel-navigation" aria-label="主导航">
    <button type="button" className="feel-nav-handle" onPointerDown={event => controller.current?.down(event)} onKeyDown={event => controller.current?.key(event)} onClick={event => controller.current?.click(event)} aria-label="移动导航菜单" aria-describedby={hintId}><span aria-hidden="true" /></button>
    <span id={hintId} className="sr-only">拖动后松手，菜单会停在最近的角落。也可使用方向键移动。</span>
    <nav id={contentId} className="feel-nav-content" aria-label="页面导航">{children}</nav>
  </aside>;
}

type MobileController = HandleController & { sync(open: boolean): void; close(): void; toggle(): void };
const QUICK_PAGES = [{ id: 'overview', label: '总览' }, { id: 'models', label: '模型分析' }, { id: 'quota', label: '配额与订阅' }] as const;
/** The tab bar grows into the menu as one surface (game-manage). A tap
 * springs from rest to the next stop (closed, half, open); a drag follows the
 * finger with resistance past either end, and a release keeps its velocity to
 * pick the stop it would coast to, so a slow drag rests half-open and a flick
 * passes on (Feel's magnetic drawer). */
function MobileDrawer({ children, open, onOpenChange, currentPage, onNavigate }: Props) {
  const surface = useRef<HTMLElement | null>(null), content = useRef<HTMLElement | null>(null), inner = useRef<HTMLDivElement | null>(null), handle = useRef<HTMLButtonElement | null>(null), backdrop = useRef<HTMLDivElement | null>(null);
  const controller = useRef<MobileController | null>(null), latest = useRef({ open, onOpenChange }); latest.current = { open, onOpenChange };
  const opener = useRef<HTMLElement | null>(null), wasOpen = useRef(false), menuId = useId(), titleId = useId(), hintId = useId();
  useLayoutEffect(() => {
    const win = window, el = surface.current!, menu = content.current!, list = inner.current!, reduced = win.matchMedia('(prefers-reduced-motion: reduce)');
    const cards = createFeelCards(document.querySelector<HTMLElement>('.app-shell') || document.body);
    // The open stop fits the whole menu when the screen allows; the scroll box
    // between the grip and the bar shows what a lower stop leaves room for.
    const openHeight = () => {
      const style = win.getComputedStyle(menu);
      const natural = list.offsetHeight + (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
      return Math.max(BAR_HEIGHT, Math.min(win.innerHeight - 24, natural + GRIP_HEIGHT + BAR_HEIGHT));
    };
    let height = openHeight();
    const travel = () => Math.max(1, height - BAR_HEIGHT);
    const stretchLimit = () => Math.max(8, Math.min(40, win.innerHeight - height - 24));
    let frame = 0, last = 0, disposed = false, logicalOpen = latest.current.open, suppressed = 0;
    let progress = 0, velocity = 0, stop: DrawerStop = 'closed';
    let gesture: { id: number; startY: number; lastY: number; time: number; raw: number; moved: boolean; stop: DrawerStop } | null = null;
    function announce(value: boolean) { if (logicalOpen !== value) { logicalOpen = value; latest.current.onOpenChange(value); } }
    function paint() {
      const shown = clamp(progress, 0, 1);
      for (const node of [el, backdrop.current]) node?.style.setProperty('--drawer-progress', shown.toFixed(4));
      el.style.setProperty('--nav-open-height', `${height}px`);
      // Past the open stop the surface stretches a little (at most 40px, less
      // when the screen has no room); past the closed one it sinks at most 8px.
      el.style.setProperty('--drawer-stretch', `${clamp((progress - 1) * travel(), 0, stretchLimit()).toFixed(2)}px`);
      el.style.setProperty('--drawer-shift', `${clamp(-progress * travel(), 0, 8).toFixed(2)}px`);
      const rect = el.getBoundingClientRect();
      cards.update(shown > .001 ? { left: rect.left, right: rect.right, top: Math.max(0, rect.top), bottom: Math.min(win.innerHeight, rect.bottom), width: rect.width, height: Math.min(win.innerHeight, rect.bottom) - Math.max(0, rect.top) } : null, 'mobile');
    }
    function settle() {
      win.cancelAnimationFrame(frame); frame = 0; last = 0;
      progress = DRAWER_STOPS[stop]; velocity = 0;
      el.dataset.drawerStop = stop; delete el.dataset.drawerMoving;
      paint(); announce(stop !== 'closed');
    }
    function tick(now: number) {
      frame = 0; const dt = last ? Math.min(.032, (now - last) / 1000) : 1 / 60; last = now;
      [progress, velocity] = stepDrawerSpring(progress, velocity, DRAWER_STOPS[stop], dt);
      paint();
      if (Math.abs(DRAWER_STOPS[stop] - progress) < .001 && Math.abs(velocity) < .01) settle();
      else frame = win.requestAnimationFrame(tick);
    }
    function go(next: DrawerStop) {
      if (disposed) return;
      // A route change or Escape can close the drawer under a held pointer.
      if (gesture) {
        const g = gesture; gesture = null;
        try { if (handle.current?.hasPointerCapture(g.id)) handle.current.releasePointerCapture(g.id); } catch { /* Removed handle. */ }
        if (g.moved) suppressed = performance.now() + 700;
      }
      stop = next; announce(next !== 'closed');
      if (reduced.matches) { settle(); return; }
      el.dataset.drawerMoving = 'true'; el.dataset.drawerStop = 'moving';
      if (!frame) frame = win.requestAnimationFrame(tick);
    }
    const remember = () => { if (!logicalOpen) opener.current = handle.current; };
    const move = (event: PointerEvent) => {
      const g = gesture; if (!g || event.pointerId !== g.id) return;
      const dy = event.clientY - g.startY; if (!g.moved && Math.abs(dy) < 4) return;
      event.preventDefault();
      if (!g.moved) { g.moved = true; el.dataset.drawerMoving = 'true'; el.dataset.drawerStop = 'moving'; }
      const now = performance.now(), dt = Math.max(.008, (now - g.time) / 1000), previous = progress;
      progress = resistDrawerProgress(g.raw - dy / travel(), travel(), stretchLimit());
      // The resisted surface velocity, not the finger's: a long over-pull must
      // not launch the drawer past its usable room.
      velocity = clamp((progress - previous) / dt, -6, 6);
      g.lastY = event.clientY; g.time = now;
      if (progress > .03) announce(true);
      paint();
    };
    const end = (event?: PointerEvent, cancelled = false) => {
      const g = gesture; if (!g || (event && event.pointerId !== g.id)) return; gesture = null;
      try { if (handle.current?.hasPointerCapture(g.id)) handle.current.releasePointerCapture(g.id); } catch { /* Removed handle. */ }
      if (!g.moved) return;
      suppressed = performance.now() + 700;
      // A finger that rested before letting go releases without momentum.
      if (performance.now() - g.time > 60) velocity = 0;
      go(cancelled ? g.stop : chooseDrawerStop(progress, velocity));
    };
    controller.current = {
      down(event) {
        if (event.button !== 0 || event.isPrimary === false || gesture) return;
        remember(); suppressed = 0;
        win.cancelAnimationFrame(frame); frame = 0; last = 0;
        // Catch a moving surface where it is, keeping its resisted position.
        gesture = { id: event.pointerId, startY: event.clientY, lastY: event.clientY, time: performance.now(), raw: unresistDrawerProgress(progress, travel(), stretchLimit()), moved: false, stop };
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Global listeners retain gesture. */ }
      },
      key(event) {
        const order: DrawerStop[] = ['closed', 'half', 'open'];
        const index = order.indexOf(stop);
        let next: DrawerStop | null = null;
        if (event.key === 'ArrowUp' || event.key === 'ArrowRight') next = order[Math.min(2, index + 1)];
        else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') next = order[Math.max(0, index - 1)];
        else if (event.key === 'Home') next = 'open';
        else if (event.key === 'End') next = 'closed';
        if (!next) return;
        event.preventDefault(); remember(); go(next);
      },
      click(event) {
        if (event.detail !== 0 && performance.now() < suppressed) { event.preventDefault(); event.stopPropagation(); return; }
        // A tap while the surface is still moving continues from its target.
        remember(); go(nextDrawerStop(stop));
      },
      sync(value) { if (value === logicalOpen) return; logicalOpen = value; if (value) { opener.current ||= handle.current; go('half'); } else go('closed'); },
      close() { go('closed'); },
      toggle() { if (!logicalOpen) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : handle.current; go(stop === 'open' ? 'closed' : 'open'); },
    };
    // The menu's own size (a scrollbar appearing while it opens, a wrapped
    // label) only refits the open stop; a drag in progress keeps going.
    const refit = () => { height = openHeight(); paint(); };
    const resize = () => {
      // A new viewport invalidates the pointer's starting coordinate.
      if (gesture) end(undefined, true);
      refit();
      if (!frame) settle();
    };
    const sizes = new ResizeObserver(refit); sizes.observe(list);
    const freshPress = () => { if (!gesture) suppressed = 0; }, suppressClick = (event: MouseEvent) => {
      if (event.detail !== 0 && performance.now() < suppressed) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    const reducedChanged = () => { if (reduced.matches && !gesture) settle(); };
    const up = (event: PointerEvent) => end(event), cancel = (event: PointerEvent) => end(event, true), blur = () => end(undefined, true);
    win.addEventListener('pointermove', move, { passive: false }); win.addEventListener('pointerup', up); win.addEventListener('pointercancel', cancel); win.addEventListener('blur', blur);
    win.addEventListener('pointerdown', freshPress, true); win.addEventListener('click', suppressClick, true);
    win.addEventListener('resize', resize); win.visualViewport?.addEventListener('resize', resize); reduced.addEventListener('change', reducedChanged);
    settle();
    return () => {
      disposed = true; win.cancelAnimationFrame(frame); controller.current = null; sizes.disconnect(); cards.destroy();
      if (gesture) { try { handle.current?.releasePointerCapture(gesture.id); } catch { /* Removed handle. */ } }
      win.removeEventListener('pointermove', move); win.removeEventListener('pointerup', up); win.removeEventListener('pointercancel', cancel); win.removeEventListener('blur', blur);
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
      <nav id={menuId} ref={content} className="feel-nav-content" aria-label="页面导航" inert={!open} aria-hidden={!open} onClick={event => { if ((event.target as Element).closest('a[href^="#"]')) latest.current.onOpenChange(false); }}><div ref={inner} className="feel-nav-inner">{children}</div></nav>
      <nav className="feel-quick-navigation" aria-label="常用页面">
        {QUICK_PAGES.map(page => <a key={page.id} href={`#${page.id}`} aria-current={currentPage === page.id ? 'page' : undefined} onClick={event => { event.preventDefault(); onNavigate(page.id); }}><AnimatedNavIcon name={page.id} size={20} active={currentPage === page.id} /><span>{page.label}</span></a>)}
        <button type="button" className="feel-more" aria-expanded={open} aria-controls={menuId} onClick={() => controller.current?.toggle()}><ChevronUp size={20} aria-hidden="true" /><span>更多</span></button>
      </nav>
      <span id={hintId} className="sr-only">点击抓手依次半开、展开和收起，也可上下拖动或使用方向键。</span>
    </section>
  </>;
}
