import { useEffect, useLayoutEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ChevronDown, GripHorizontal, Menu, X } from 'lucide-react';
import { createFeelCards } from './lib/feel-cards';
import { clamp, CORNERS, cornerPosition, drawerStops, navigationBounds, nearestDrawerStop, projectedCorner, springStep, type Corner } from './lib/feel-physics';
import './floating-navigation.css';

export const MOBILE_NAV_QUERY = '(max-width: 760px), (max-width: 960px) and (max-height: 500px)';
const STORAGE_KEY = 'cloud-monitor-navigation-corner';
type Props = {
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef?: RefObject<HTMLElement | null>;
  pageName: string;
};
type Controller = {
  down(event: React.PointerEvent<HTMLElement>): void;
  key(event: React.KeyboardEvent<HTMLElement>): void;
  syncOpen(open: boolean): void;
  click(event: React.MouseEvent<HTMLElement>): void;
};

/** The same navigation contents live in a floating desktop panel or a modal mobile sheet. */
export function FloatingNavigation({ children, open, onOpenChange, triggerRef, pageName }: Props) {
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_NAV_QUERY).matches);
  const [expanded, setExpanded] = useState(true);
  const surface = useRef<HTMLElement | null>(null), drawer = useRef<HTMLDivElement | null>(null), peek = useRef<HTMLButtonElement | null>(null);
  const controller = useRef<Controller | null>(null);
  const latest = useRef({ open, onOpenChange }); latest.current = { open, onOpenChange };
  const contentId = useId(), hintId = useId();
  useEffect(() => {
    const query = window.matchMedia(MOBILE_NAV_QUERY);
    const change = () => { setMobile(query.matches); latest.current.onOpenChange(false); };
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  useLayoutEffect(() => { controller.current?.syncOpen(open); }, [open]);
  useLayoutEffect(() => {
    const win = window, reduced = win.matchMedia('(prefers-reduced-motion: reduce)');
    const cards = createFeelCards(document.querySelector<HTMLElement>('.app-shell') || document.body);
    let frame = 0, last = 0, disposed = false, suppressed = 0;
    let corner: Corner = 'top-left';
    try { const saved = localStorage.getItem(STORAGE_KEY); if (CORNERS.includes(saved as Corner)) corner = saved as Corner; } catch { /* Saving a preference is optional. */ }
    let x = 12, y = 12, vx = 0, vy = 0, tx = x, ty = y;
    let shift = 0, sv = 0, targetShift = 0;
    let gesture: { id: number; handle: HTMLElement; startX: number; startY: number; x: number; y: number; shift: number; lastX: number; lastY: number; at: number; moved: boolean; corner: Corner; wasOpen: boolean } | null = null;
    const bounds = () => navigationBounds(win.innerWidth, win.innerHeight, surface.current?.offsetWidth || 224, surface.current?.offsetHeight || 60);
    const height = () => drawer.current?.offsetHeight || Math.min(620, win.innerHeight - 16);
    function paint() {
      if (mobile) {
        if (drawer.current) drawer.current.style.setProperty('--feel-sheet-shift', `${clamp(shift, 0, height() - 56).toFixed(2)}px`);
        const sheet = latest.current.open ? drawer.current?.getBoundingClientRect() : null;
        cards.update(sheet && sheet.top < win.innerHeight ? {
          left: sheet.left, right: sheet.right, top: Math.max(0, sheet.top), bottom: Math.min(win.innerHeight, sheet.bottom), width: sheet.width, height: Math.min(win.innerHeight, sheet.bottom) - Math.max(0, sheet.top),
        } : null, 'mobile');
      } else if (surface.current) {
        const b = bounds(); x = clamp(x, b.left, b.right); y = clamp(y, b.top, b.bottom);
        surface.current.style.transform = `translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,0)`;
        surface.current.dataset.dragging = String(Boolean(gesture?.moved));
        const menu = surface.current.getBoundingClientRect();
        cards.update(menu);
      }
    }
    function stop() { win.cancelAnimationFrame(frame); frame = 0; last = 0; }
    function settle() { stop(); x = tx; y = ty; shift = targetShift; vx = vy = sv = 0; paint(); }
    function tick(now: number) {
      frame = 0;
      const dt = last ? (now - last) / 1000 : 1 / 60; last = now;
      if (mobile) [shift, sv] = springStep(shift, sv, targetShift, dt, 345, 23, .6);
      else { [x, vx] = springStep(x, vx, tx, dt); [y, vy] = springStep(y, vy, ty, dt); }
      const done = mobile ? Math.abs(shift - targetShift) < .1 && Math.abs(sv) < 1 : Math.hypot(x - tx, y - ty) < .1 && Math.hypot(vx, vy) < 1;
      if (done) settle();
      else { frame = win.requestAnimationFrame(tick); paint(); }
    }
    function start() { if (disposed || gesture) return; if (reduced.matches) settle(); else if (!frame) frame = win.requestAnimationFrame(tick); }
    function choose(next: Corner) {
      corner = next; ({ x: tx, y: ty } = cornerPosition(corner, bounds()));
      try { localStorage.setItem(STORAGE_KEY, corner); } catch { /* Optional preference. */ }
      start();
    }
    function setStop(next: number) {
      targetShift = next;
      if (next >= height() - 65) { latest.current.onOpenChange(false); targetShift = 0; }
      else { latest.current.onOpenChange(true); start(); }
    }
    const end = (event?: PointerEvent, cancelled = false) => {
      const g = gesture;
      if (!g || (event && event.pointerId !== g.id)) return;
      gesture = null;
      try { if (g.handle.hasPointerCapture(g.id)) g.handle.releasePointerCapture(g.id); } catch { /* Removed handles can lose capture on breakpoint changes. */ }
      if (performance.now() - g.at > 80) vx = vy = sv = 0;
      if (g.moved) suppressed = performance.now() + 450;
      if (mobile) {
        if (cancelled) { sv = 0; setStop(g.wasOpen ? 0 : height() - 64); }
        else if (g.moved) setStop(nearestDrawerStop(shift, sv, height()));
        else if (g.wasOpen) { targetShift = 0; start(); }
        else { shift = targetShift = 0; sv = 0; }
      } else choose(cancelled ? g.corner : g.moved ? projectedCorner(x, y, vx, vy, bounds()) : corner);
      paint();
    };
    const move = (event: PointerEvent) => {
      const g = gesture; if (!g || event.pointerId !== g.id) return;
      const dx = event.clientX - g.startX, dy = event.clientY - g.startY;
      if (!g.moved && Math.hypot(dx, dy) < 5) return;
      g.moved = true; event.preventDefault();
      const at = performance.now(), dt = Math.max(.008, (at - g.at) / 1000);
      if (mobile) {
        if (!latest.current.open) latest.current.onOpenChange(true);
        const next = clamp(g.shift + dy, 0, height() - 56);
        sv = clamp((next - shift) / dt, -2600, 2600); shift = next;
      } else {
        const b = bounds(); x = clamp(g.x + dx, b.left, b.right); y = clamp(g.y + dy, b.top, b.bottom);
        vx = clamp((event.clientX - g.lastX) / dt, -4000, 4000); vy = clamp((event.clientY - g.lastY) / dt, -4000, 4000);
      }
      g.lastX = event.clientX; g.lastY = event.clientY; g.at = at; paint();
    };
    controller.current = {
      down(event) {
        if (event.button !== 0 || event.isPrimary === false || gesture) return;
        event.preventDefault();
        if (!mobile || latest.current.open) event.currentTarget.focus({ preventScroll: true });
        suppressed = 0; stop();
        if (mobile && !latest.current.open) { shift = height() - 64; targetShift = shift; }
        gesture = { id: event.pointerId, handle: event.currentTarget, startX: event.clientX, startY: event.clientY, x, y, shift, lastX: event.clientX, lastY: event.clientY, at: performance.now(), moved: false, corner, wasOpen: latest.current.open };
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Global listeners also retain the gesture. */ }
        win.requestAnimationFrame(() => { if (!disposed) paint(); });
      },
      key(event) {
        const keys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];
        if (!keys.includes(event.key)) return;
        event.preventDefault();
        if (mobile) {
          const stops = drawerStops(height());
          const nearest = nearestDrawerStop(targetShift, 0, height()), index = stops.indexOf(nearest);
          setStop(event.key === 'Home' ? stops[0] : event.key === 'End' ? stops[2] : stops[clamp(index + (event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1), 0, 2)]);
        } else {
          let vertical = corner.startsWith('top') ? 'top' : 'bottom', horizontal = corner.endsWith('left') ? 'left' : 'right';
          if (event.key === 'ArrowUp') vertical = 'top'; if (event.key === 'ArrowDown') vertical = 'bottom';
          if (event.key === 'ArrowLeft') horizontal = 'left'; if (event.key === 'ArrowRight') horizontal = 'right';
          choose(event.key === 'Home' ? 'top-left' : event.key === 'End' ? 'bottom-right' : `${vertical}-${horizontal}` as Corner);
        }
      },
      syncOpen(value) { if (!mobile) return; if (gesture) { paint(); return; } targetShift = 0; if (value) { shift = height() - 64; sv = 0; paint(); start(); } else { stop(); shift = 0; paint(); } },
      click(event) { if (event.detail !== 0 && performance.now() < suppressed) { event.preventDefault(); event.stopPropagation(); return; } if (mobile) { targetShift = 0; latest.current.onOpenChange(true); start(); } },
    };
    const resize = () => { if (gesture) end(undefined, true); stop(); if (mobile) { shift = targetShift = 0; paint(); } else { ({ x: tx, y: ty } = cornerPosition(corner, bounds())); settle(); } };
    const cancel = (event: PointerEvent) => end(event, true), up = (event: PointerEvent) => end(event), blur = () => end(undefined, true);
    const reducedChanged = () => { if (reduced.matches) settle(); };
    const sizes = new ResizeObserver(resize);
    if (surface.current) sizes.observe(surface.current);
    const freshPress = () => { if (!gesture) suppressed = 0; };
    const suppressDragClick = (event: MouseEvent) => {
      if (event.detail !== 0 && performance.now() < suppressed) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    win.addEventListener('pointerdown', freshPress, true); win.addEventListener('click', suppressDragClick, true);
    win.addEventListener('pointermove', move, { passive: false }); win.addEventListener('pointerup', up); win.addEventListener('pointercancel', cancel); win.addEventListener('blur', blur); win.addEventListener('resize', resize);
    win.visualViewport?.addEventListener('resize', resize); reduced.addEventListener('change', reducedChanged);
    resize();
    return () => {
      disposed = true; if (gesture) { try { gesture.handle.releasePointerCapture(gesture.id); } catch { /* Already released. */ } } stop(); controller.current = null; cards.destroy(); sizes.disconnect();
      win.removeEventListener('pointerdown', freshPress, true); win.removeEventListener('click', suppressDragClick, true);
      win.removeEventListener('pointermove', move); win.removeEventListener('pointerup', up); win.removeEventListener('pointercancel', cancel); win.removeEventListener('blur', blur); win.removeEventListener('resize', resize); win.visualViewport?.removeEventListener('resize', resize); reduced.removeEventListener('change', reducedChanged);
    };
  }, [mobile, expanded]);
  const handle = {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => controller.current?.down(event),
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => controller.current?.key(event),
    onClick: (event: React.MouseEvent<HTMLElement>) => controller.current?.click(event),
  };
  if (!mobile) return (
    <aside ref={surface} className="feel-navigation" aria-label="主导航" data-expanded={expanded}>
      <div className="feel-nav-header">
        <button className="feel-nav-handle" {...handle} aria-label="移动导航菜单" aria-describedby={hintId} title="拖动移动；方向键移到四角"><GripHorizontal size={18} /><span>导航</span></button>
        <button className="feel-nav-toggle" aria-label={expanded ? '收起导航' : '展开导航'} aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(value => !value)}><ChevronDown size={16} /></button>
      </div>
      <span id={hintId} className="sr-only">拖动后松手，菜单会停在最近的角落。也可使用方向键移动。</span>
      <nav id={contentId} className="feel-nav-content" aria-label="页面导航" hidden={!expanded}>{children}</nav>
    </aside>
  );
  return (
    <>
      <button ref={peek} className="feel-nav-peek" {...handle} aria-label="打开导航，可向上拖动" aria-haspopup="dialog" aria-expanded={open} style={open ? { visibility: 'hidden' } : undefined}>
        <Menu size={18} /><span>{pageName}</span><GripHorizontal size={18} />
      </button>
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay className="feel-nav-backdrop" />
          <Dialog.Content ref={drawer} className="feel-nav-drawer" onCloseAutoFocus={event => {
            event.preventDefault();
            if (document.querySelector('[role="dialog"][data-state="open"]')) return;
            const target = triggerRef?.current || peek.current;
            if (target?.isConnected && target.getClientRects().length) target.focus({ preventScroll: true });
          }} onOpenAutoFocus={event => { if (open) { event.preventDefault(); drawer.current?.querySelector<HTMLButtonElement>('.feel-sheet-handle')?.focus({ preventScroll: true }); } }}>
            <Dialog.Title className="sr-only">导航</Dialog.Title>
            <Dialog.Description className="sr-only">切换页面和工作区设置。拖动顶部手柄，或用方向键调整抽屉高度。</Dialog.Description>
            <div className="feel-sheet-header">
              <button className="feel-sheet-handle" {...handle} aria-label="调整导航高度" title="向上展开，向下收起；方向键也可调整"><span /><GripHorizontal size={18} /></button>
              <Dialog.Close className="feel-sheet-close" aria-label="关闭导航"><X size={20} /></Dialog.Close>
            </div>
            <nav className="feel-nav-content" aria-label="页面导航" onClick={event => { if ((event.target as Element).closest('a[href^="#"]')) onOpenChange(false); }}>{children}</nav>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
