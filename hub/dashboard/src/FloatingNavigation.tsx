import { useEffect, useLayoutEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, GripHorizontal } from 'lucide-react';
import { AnimatedNavIcon } from './AnimatedNavIcon';
import { createFeelCards } from './lib/feel-cards';
import { MagneticDrawer, magneticStops } from './lib/magnetic-drawer';
import { clamp, CORNERS, cornerPosition, navigationBounds, projectedCorner, springStep, type Corner } from './lib/feel-physics';
import type { PageId } from './pages';
import './floating-navigation.css';

export const MOBILE_NAV_QUERY = '(max-width: 760px), (max-width: 960px) and (max-height: 500px)';
const STORAGE_KEY = 'cloud-monitor-navigation-corner';
type Props = { children: ReactNode; open: boolean; onOpenChange: (open: boolean) => void; pageName: string; currentPage: PageId; onNavigate: (page: PageId) => void };
type HandleController = { down(event: React.PointerEvent<HTMLElement>): void; key(event: React.KeyboardEvent<HTMLElement>): void; click(event: React.MouseEvent<HTMLElement>): void };

/** Desktop corner navigation and a persistent magnetic mobile surface. */
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
      document.querySelector<HTMLElement>(mobile ? '[data-mobile-navigation-trigger]' : '.feel-nav-handle')?.focus({ preventScroll: true });
    }
  }, [mobile]);
  return mobile ? <MobileDrawer {...props} /> : <DesktopNavigation>{props.children}</DesktopNavigation>;
}

function DesktopNavigation({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(true), surface = useRef<HTMLElement | null>(null);
  const controller = useRef<HandleController | null>(null), contentId = useId(), hintId = useId();
  useLayoutEffect(() => {
    const win = window, reduced = win.matchMedia('(prefers-reduced-motion: reduce)');
    const cards = createFeelCards(document.querySelector<HTMLElement>('.app-shell') || document.body);
    let frame = 0, last = 0, disposed = false, suppressed = 0, corner: Corner = 'top-left';
    try { const saved = localStorage.getItem(STORAGE_KEY); if (CORNERS.includes(saved as Corner)) corner = saved as Corner; } catch { /* Optional preference. */ }
    let x = 12, y = 12, vx = 0, vy = 0, tx = x, ty = y;
    let gesture: { id: number; handle: HTMLElement; startX: number; startY: number; x: number; y: number; lastX: number; lastY: number; at: number; moved: boolean; corner: Corner } | null = null;
    const bounds = () => navigationBounds(win.innerWidth, win.innerHeight, surface.current?.offsetWidth || 224, surface.current?.offsetHeight || 60);
    function paint() {
      if (!surface.current) return;
      const b = bounds(); x = clamp(x, b.left, b.right); y = clamp(y, b.top, b.bottom);
      surface.current.style.transform = `translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,0)`;
      surface.current.dataset.dragging = String(Boolean(gesture?.moved)); cards.update(surface.current.getBoundingClientRect());
    }
    function stop() { win.cancelAnimationFrame(frame); frame = 0; last = 0; }
    function settle() { stop(); x = tx; y = ty; vx = vy = 0; paint(); }
    function tick(now: number) {
      frame = 0; const dt = last ? (now - last) / 1000 : 1 / 60; last = now;
      [x, vx] = springStep(x, vx, tx, dt); [y, vy] = springStep(y, vy, ty, dt);
      if (Math.hypot(x - tx, y - ty) < .1 && Math.hypot(vx, vy) < 1) settle();
      else { frame = win.requestAnimationFrame(tick); paint(); }
    }
    function start() { if (disposed || gesture) return; if (reduced.matches) settle(); else if (!frame) frame = win.requestAnimationFrame(tick); }
    function choose(next: Corner) {
      corner = next; ({ x: tx, y: ty } = cornerPosition(corner, bounds()));
      try { localStorage.setItem(STORAGE_KEY, corner); } catch { /* Optional preference. */ } start();
    }
    const end = (event?: PointerEvent, cancelled = false) => {
      const g = gesture; if (!g || (event && event.pointerId !== g.id)) return; gesture = null;
      try { if (g.handle.hasPointerCapture(g.id)) g.handle.releasePointerCapture(g.id); } catch { /* Removed handle. */ }
      if (performance.now() - g.at > 80) vx = vy = 0;
      if (g.moved) suppressed = performance.now() + 450;
      choose(cancelled ? g.corner : g.moved ? projectedCorner(x, y, vx, vy, bounds()) : corner); paint();
    };
    const move = (event: PointerEvent) => {
      const g = gesture; if (!g || event.pointerId !== g.id) return;
      const dx = event.clientX - g.startX, dy = event.clientY - g.startY; if (!g.moved && Math.hypot(dx, dy) < 5) return;
      g.moved = true; event.preventDefault(); const at = performance.now(), dt = Math.max(.008, (at - g.at) / 1000), b = bounds();
      x = clamp(g.x + dx, b.left, b.right); y = clamp(g.y + dy, b.top, b.bottom);
      vx = clamp((event.clientX - g.lastX) / dt, -4000, 4000); vy = clamp((event.clientY - g.lastY) / dt, -4000, 4000);
      g.lastX = event.clientX; g.lastY = event.clientY; g.at = at; paint();
    };
    controller.current = {
      down(event) {
        if (event.button !== 0 || event.isPrimary === false || gesture) return;
        event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); suppressed = 0; stop();
        gesture = { id: event.pointerId, handle: event.currentTarget, startX: event.clientX, startY: event.clientY, x, y, lastX: event.clientX, lastY: event.clientY, at: performance.now(), moved: false, corner };
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Global listeners retain gesture. */ }
      },
      key(event) {
        if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault();
        let vertical = corner.startsWith('top') ? 'top' : 'bottom', horizontal = corner.endsWith('left') ? 'left' : 'right';
        if (event.key === 'ArrowUp') vertical = 'top'; if (event.key === 'ArrowDown') vertical = 'bottom';
        if (event.key === 'ArrowLeft') horizontal = 'left'; if (event.key === 'ArrowRight') horizontal = 'right';
        choose(event.key === 'Home' ? 'top-left' : event.key === 'End' ? 'bottom-right' : `${vertical}-${horizontal}` as Corner);
      },
      click(event) { if (event.detail !== 0 && performance.now() < suppressed) { event.preventDefault(); event.stopPropagation(); } },
    };
    const resize = () => { if (gesture) end(undefined, true); stop(); ({ x: tx, y: ty } = cornerPosition(corner, bounds())); settle(); };
    const cancel = (event: PointerEvent) => end(event, true), up = (event: PointerEvent) => end(event), blur = () => end(undefined, true);
    const reducedChanged = () => { if (reduced.matches) settle(); }, sizes = new ResizeObserver(resize);
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
  }, [expanded]);
  return <aside ref={surface} className="feel-navigation" aria-label="主导航" data-expanded={expanded}>
    <div className="feel-nav-header">
      <button className="feel-nav-handle" onPointerDown={event => controller.current?.down(event)} onKeyDown={event => controller.current?.key(event)} onClick={event => controller.current?.click(event)} aria-label="移动导航菜单" aria-describedby={hintId}><GripHorizontal size={18} /><span>导航</span></button>
      <button className="feel-nav-toggle" aria-label={expanded ? '收起导航' : '展开导航'} aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(value => !value)}><ChevronDown size={16} /></button>
    </div>
    <span id={hintId} className="sr-only">拖动后松手，菜单会停在最近的角落。也可使用方向键移动。</span>
    <nav id={contentId} className="feel-nav-content" aria-label="页面导航" hidden={!expanded}>{children}</nav>
  </aside>;
}

type MobileController = HandleController & { sync(open: boolean): void; close(): void };
const QUICK_PAGES = [{ id: 'overview', label: '总览' }, { id: 'models', label: '模型分析' }, { id: 'quota', label: '配额与订阅' }] as const;
function MobileDrawer({ children, open, onOpenChange, pageName, currentPage, onNavigate }: Props) {
  const surface = useRef<HTMLElement | null>(null), header = useRef<HTMLDivElement | null>(null), handle = useRef<HTMLButtonElement | null>(null), backdrop = useRef<HTMLDivElement | null>(null);
  const controller = useRef<MobileController | null>(null), latest = useRef({ open, onOpenChange }); latest.current = { open, onOpenChange };
  const opener = useRef<HTMLElement | null>(null), wasOpen = useRef(false), menuId = useId(), titleId = useId(), hintId = useId();
  useLayoutEffect(() => {
    const win = window, el = surface.current!, head = header.current!, reduced = win.matchMedia('(prefers-reduced-motion: reduce)');
    const cards = createFeelCards(document.querySelector<HTMLElement>('.app-shell') || document.body);
    const body = new MagneticDrawer(magneticStops(el.offsetHeight, head.offsetHeight));
    let frame = 0, last = 0, disposed = false, logicalOpen = latest.current.open, suppressed = 0;
    let gesture: { id: number; x: number; y: number; start: number; moved: boolean } | null = null;
    function announce(value: boolean) { if (logicalOpen !== value) { logicalOpen = value; latest.current.onOpenChange(value); } }
    function paint() {
      const travel = body.stops[2], amount = clamp(1 - body.x / travel, 0, 1);
      el.style.setProperty('--feel-sheet-shift', `${body.x.toFixed(3)}px`);
      el.style.setProperty('--feel-drawer-open', amount.toFixed(4));
      el.style.setProperty('--feel-collapsed-height', `${head.offsetHeight}px`);
      backdrop.current?.style.setProperty('--feel-drawer-open', amount.toFixed(4));
      const rect = el.getBoundingClientRect();
      cards.update(amount > .001 ? { left: rect.left, right: rect.right, top: Math.max(0, rect.top), bottom: Math.min(win.innerHeight, rect.bottom), width: rect.width, height: Math.min(win.innerHeight, rect.bottom) - Math.max(0, rect.top) } : null, 'mobile');
    }
    function finish() {
      win.cancelAnimationFrame(frame); frame = 0;
      body.snap(); el.dataset.drawerStop = body.index === 0 ? 'open' : body.index === 1 ? 'half' : 'closed';
      delete el.dataset.drawerMoving; last = 0; paint(); announce(body.index !== 2);
    }
    function tick(now: number) {
      frame = 0; const dt = last ? Math.min(.04, (now - last) / 1000) : 1 / 60; last = now;
      body.step(dt); paint();
      if (body.settled()) finish(); else frame = win.requestAnimationFrame(tick);
    }
    function wake() {
      if (disposed) return;
      el.dataset.drawerMoving = 'true'; el.dataset.drawerStop = 'moving';
      if (reduced.matches && !body.hand) { body.snap(body.predict()); finish(); }
      else if (!frame) frame = win.requestAnimationFrame(tick);
    }
    function go(index: number) {
      const destination = body.stops[clamp(index, 0, 2)]; announce(index < 2);
      if (reduced.matches) { body.snap(destination); finish(); }
      else { body.kickTo(destination); wake(); }
    }
    const next = () => go(!logicalOpen ? 1 : body.index === 0 ? 2 : body.index - 1);
    const remember = () => { if (!logicalOpen) opener.current = handle.current; };
    const move = (event: PointerEvent) => {
      const g = gesture; if (!g || event.pointerId !== g.id) return;
      const dy = event.clientY - g.y; if (!g.moved && Math.abs(dy) < 4) return;
      event.preventDefault();
      if (!g.moved) { g.moved = true; body.grab(g.start, event.timeStamp); announce(true); }
      body.move(g.start + dy, event.timeStamp); wake();
    };
    const end = (event?: PointerEvent) => {
      const g = gesture; if (!g || (event && event.pointerId !== g.id)) return; gesture = null;
      try { if (handle.current?.hasPointerCapture(g.id)) handle.current.releasePointerCapture(g.id); } catch { /* Removed handle. */ }
      if (g.moved) { suppressed = performance.now() + 450; body.release(); announce(body.predict() !== body.stops[2]); wake(); }
    };
    controller.current = {
      down(event) {
        if (event.button !== 0 || event.isPrimary === false || gesture) return;
        event.preventDefault(); remember(); event.currentTarget.focus({ preventScroll: true }); suppressed = 0;
        gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, start: body.x, moved: false };
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Global listeners retain gesture. */ }
      },
      key(event) {
        if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); remember();
        go(event.key === 'Home' ? 0 : event.key === 'End' ? 2 : clamp(body.index + (event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1), 0, 2));
      },
      click(event) { if (event.detail !== 0 && performance.now() < suppressed) { event.preventDefault(); event.stopPropagation(); return; } remember(); next(); },
      sync(value) { if (value === logicalOpen) return; logicalOpen = value; if (value) { opener.current ||= handle.current; go(1); } else go(2); },
      close() { go(2); },
    };
    const resize = () => {
      // A new viewport invalidates the pointer's starting coordinate. Release
      // it before resizing the body so the next move cannot restore old pixels.
      if (gesture) {
        try { if (handle.current?.hasPointerCapture(gesture.id)) handle.current.releasePointerCapture(gesture.id); } catch { /* Removed handle. */ }
        gesture = null; body.release(); suppressed = performance.now() + 450;
      }
      body.resize(magneticStops(el.offsetHeight, head.offsetHeight)); paint(); if (body.settled()) finish(); else wake();
    };
    const sizes = new ResizeObserver(resize); sizes.observe(el); sizes.observe(head);
    const freshPress = () => { if (!gesture) suppressed = 0; }, suppressClick = (event: MouseEvent) => {
      if (event.detail !== 0 && performance.now() < suppressed) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    const reducedChanged = () => { if (reduced.matches) { body.release(); body.snap(body.predict()); finish(); } };
    const blur = () => end();
    win.addEventListener('pointermove', move, { passive: false }); win.addEventListener('pointerup', end); win.addEventListener('pointercancel', end); win.addEventListener('blur', blur);
    win.addEventListener('pointerdown', freshPress, true); win.addEventListener('click', suppressClick, true);
    win.addEventListener('resize', resize); win.visualViewport?.addEventListener('resize', resize); reduced.addEventListener('change', reducedChanged);
    finish();
    return () => {
      disposed = true; win.cancelAnimationFrame(frame); controller.current = null; sizes.disconnect(); cards.destroy();
      if (gesture) { try { handle.current?.releasePointerCapture(gesture.id); } catch { /* Removed handle. */ } }
      win.removeEventListener('pointermove', move); win.removeEventListener('pointerup', end); win.removeEventListener('pointercancel', end); win.removeEventListener('blur', blur);
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
        target?.focus({ preventScroll: true });
      }, 0);
      return () => window.clearTimeout(timer);
    }
    wasOpen.current = true;
    const body = document.body, saved = { overflow: body.style.overflow, paddingRight: body.style.paddingRight };
    const background = [...document.querySelectorAll<HTMLElement>('.workspace-main, .skip-link')].map(node => ({ node, inert: node.inert }));
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = 'hidden'; if (scrollbar) body.style.paddingRight = `${parseFloat(getComputedStyle(body).paddingRight) + scrollbar}px`;
    background.forEach(({ node }) => { node.inert = true; }); handle.current?.focus({ preventScroll: true });
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
    const focusin = (event: FocusEvent) => { if (!el.contains(event.target as Node) && !document.querySelector('[role="dialog"][data-state="open"]:not(.feel-nav-drawer)')) handle.current?.focus({ preventScroll: true }); };
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
      <div ref={header} className="feel-mobile-bar">
        <div className="feel-sheet-header">
          <button ref={handle} className="feel-sheet-handle feel-nav-peek" data-mobile-navigation-trigger aria-label={open ? '调整导航高度' : '打开导航'} aria-expanded={open} aria-controls={menuId} aria-describedby={hintId} onPointerDown={event => controller.current?.down(event)} onKeyDown={event => controller.current?.key(event)} onClick={event => controller.current?.click(event)}><span /><span className="sr-only">{pageName}</span></button>
          <button className="feel-sheet-close" aria-label="关闭导航" aria-hidden={!open} inert={!open} onClick={() => controller.current?.close()}><AnimatedNavIcon name="close" size={19} /></button>
        </div>
        <nav className="feel-quick-navigation" aria-label="常用页面">{QUICK_PAGES.map(page => <a key={page.id} href={`#${page.id}`} aria-current={currentPage === page.id ? 'page' : undefined} onClick={event => { event.preventDefault(); onNavigate(page.id); }}><AnimatedNavIcon name={page.id} size={20} active={currentPage === page.id} /><span>{page.label}</span></a>)}</nav>
      </div>
      <span id={hintId} className="sr-only">点击抓手依次半开、展开和收起，也可上下拖动或使用方向键。</span>
      <nav id={menuId} className="feel-nav-content" aria-label="页面导航" inert={!open} aria-hidden={!open} onClick={event => { if ((event.target as Element).closest('a[href^="#"]')) latest.current.onOpenChange(false); }}>{children}</nav>
    </section>
  </>;
}
