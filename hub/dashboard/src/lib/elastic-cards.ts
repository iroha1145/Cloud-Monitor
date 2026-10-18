/*
 * Rubber-band feedback for cards, ported from game-manage
 * (frontend/src/elastic-cards.js). Dragging a card's empty space pulls it at
 * most 8px with a slight tilt and lets a spring bring it back.
 */
const CARD = '[data-feel-card]';
const GLOBAL_EXCLUDED = '[data-elastic-ignore], [role="dialog"]';
// Metric bars measure a touch against their own box, so pressing them must not
// scale the card first; charts take their own pointer gestures.
const INNER_EXCLUDED = 'a, button, input, select, textarea, option, label, summary, dialog, [role="button"], [role="slider"], [role="tab"], [contenteditable]:not([contenteditable="false"]), [draggable="true"], canvas, [data-metric-trigger], [data-metric-tooltip], .insight-chart-stage';
const PROPERTIES = ['translate', 'rotate', 'scale'] as const;
const PASSIVE = { passive: true } as const;
const H = 1 / 240;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

type Gesture = {
  card: HTMLElement; id: number; touch: boolean; startX: number; startY: number;
  x: number; y: number; scale: number; vx: number; vy: number; vs: number;
  time: number; released: boolean; previous: [string, string, string][];
};
type Axis = ['x', 'vx', number] | ['y', 'vy', number] | ['scale', 'vs', number];

function stepSpring(state: Gesture, position: 'x' | 'y' | 'scale', velocity: 'vx' | 'vy' | 'vs', target: number, k: number, c: number, dt: number) {
  const steps = Math.max(1, Math.min(24, Math.round(dt / H)));
  const h = dt / steps;
  let x = state[position], v = state[velocity];
  const accel = (px: number, pv: number) => (target - px) * k - pv * c;
  for (let i = 0; i < steps; i++) {
    const a1 = accel(x, v);
    const v2 = v + 0.5 * h * a1, a2 = accel(x + 0.5 * h * v, v2);
    const v3 = v + 0.5 * h * a2, a3 = accel(x + 0.5 * h * v2, v3);
    const v4 = v + h * a3, a4 = accel(x + h * v3, v4);
    x += (h / 6) * (v + 2 * v2 + 2 * v3 + v4);
    v += (h / 6) * (a1 + 2 * a2 + 2 * a3 + a4);
  }
  state[position] = x;
  state[velocity] = v;
}

/** Decorative feedback only: never moves, reorders, captures or cancels input. */
export function createElasticCards(root: HTMLElement, { selector = CARD } = {}) {
  const view = root.ownerDocument.defaultView;
  if (!view) return { reset() {}, destroy() {} };
  const doc = root.ownerDocument;
  const media = view.matchMedia('(prefers-reduced-motion: reduce)');
  const clock = () => view.performance.now();
  let gesture: Gesture | null = null, frame = 0, disposed = false;
  const listeners: (() => void)[] = [];
  const listen = <K extends string>(target: EventTarget, type: K, handler: (event: never) => void) => {
    target.addEventListener(type, handler as EventListener, PASSIVE);
    listeners.push(() => target.removeEventListener(type, handler as EventListener));
  };
  const reset = () => {
    if (frame) view.cancelAnimationFrame(frame);
    frame = 0;
    if (!gesture) return;
    const { card, previous } = gesture;
    for (const [name, value, priority] of previous) {
      if (value) card.style.setProperty(name, value, priority);
      else card.style.removeProperty(name);
    }
    gesture = null;
  };
  const available = () => !disposed && !media.matches;
  const paint = () => {
    if (!gesture) return;
    if (!available() || !gesture.card.isConnected || !root.contains(gesture.card)) { reset(); return; }
    const { card, x, y, scale } = gesture;
    const avoidY = parseFloat(card.style.getPropertyValue('--feel-avoid-y')) || 0;
    card.style.setProperty('translate', `${x.toFixed(3)}px ${(y + avoidY).toFixed(3)}px`);
    card.style.setProperty('rotate', `${(x * 0.05).toFixed(3)}deg`);
    card.style.setProperty('scale', scale.toFixed(5));
  };
  const release = (event?: PointerEvent) => {
    if (!gesture || (event?.pointerId != null && event.pointerId !== gesture.id)) return;
    if (!available()) { reset(); return; }
    gesture.released = true;
    if (clock() - gesture.time > 60) gesture.vx = gesture.vy = 0;
    if (frame) view.cancelAnimationFrame(frame);
    let previousTime: number | null = null;
    const spring = (time: number) => {
      frame = 0;
      if (!gesture) return;
      const dt = previousTime == null ? 1 / 60 : Math.min(0.032, Math.max(0.001, (time - previousTime) / 1000));
      previousTime = time;
      const axes: Axis[] = [['x', 'vx', 0], ['y', 'vy', 0], ['scale', 'vs', 1]];
      for (const [position, velocity, target] of axes) stepSpring(gesture, position, velocity, target, 330, 29, dt);
      if (Math.abs(gesture.x) + Math.abs(gesture.y) < 0.025 && Math.abs(1 - gesture.scale) < 0.0001 && Math.hypot(gesture.vx, gesture.vy) < 0.5) { reset(); return; }
      paint();
      if (gesture) frame = view.requestAnimationFrame(spring);
    };
    frame = view.requestAnimationFrame(spring);
  };
  const down = (event: PointerEvent) => {
    // A second finger always hands control back to native pinch/scroll handling.
    if (gesture && !gesture.released && event.pointerId !== gesture.id) { reset(); return; }
    if (!available() || event.isPrimary === false || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const target = event.target instanceof Element ? event.target : (event.target as Node | null)?.parentElement;
    const card = target?.closest<HTMLElement>(selector);
    if (!target || !card || !root.contains(card) || target.closest(GLOBAL_EXCLUDED)) return;
    const inner = target.closest(INNER_EXCLUDED);
    if (inner && inner !== card && card.contains(inner)) return;
    const outerCard = card.parentElement?.closest(selector);
    if (outerCard && root.contains(outerCard)) return;
    // Leave nested scrolling surfaces alone: tables, the matrix, the calendar.
    for (let el: Element | null = target; el && el !== card; el = el.parentElement) {
      const style = view.getComputedStyle(el);
      if (/(auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`)) return;
    }
    if (doc.getSelection()?.isCollapsed === false) return;
    reset();
    gesture = {
      card, id: event.pointerId, touch: event.pointerType !== 'mouse', startX: event.clientX, startY: event.clientY,
      x: 0, y: 0, scale: 0.994, vx: 0, vy: 0, vs: 0, time: clock(), released: false,
      previous: PROPERTIES.map(name => [name, card.style.getPropertyValue(name), card.style.getPropertyPriority(name)]),
    };
    // The press shows from the next frame, so handlers further up that measure
    // this pointerdown (tooltips, charts) still see the card unscaled.
    frame = view.requestAnimationFrame(() => { frame = 0; paint(); });
  };
  const move = (event: PointerEvent) => {
    if (!gesture || gesture.released || event.pointerId !== gesture.id) return;
    if (doc.getSelection()?.isCollapsed === false) { reset(); return; }
    const dx = event.clientX - gesture.startX, dy = event.clientY - gesture.startY;
    if (gesture.touch && Math.abs(dy) > 5 && Math.abs(dy) >= Math.abs(dx) * 0.8) { reset(); return; }
    if (gesture.touch && Math.max(Math.abs(dx), Math.abs(dy)) < 5) return;
    const nx = 8 * Math.tanh(dx / 100);
    const ny = gesture.touch ? 0 : 8 * Math.tanh(dy / 100);
    const now = clock(), elapsed = now - gesture.time;
    if (elapsed > 0) {
      const dt = Math.max(0.008, elapsed / 1000);
      gesture.vx = clamp((nx - gesture.x) / dt, -240, 240);
      gesture.vy = clamp((ny - gesture.y) / dt, -240, 240);
      gesture.time = now;
    }
    gesture.x = nx;
    gesture.y = ny;
    paint();
  };
  listen(root, 'pointerdown', down);
  listen(view, 'pointermove', move);
  listen(view, 'pointerup', release);
  listen(view, 'pointercancel', release);
  listen(view, 'blur', reset);
  // Capture scroll notifications from nested scroll surfaces as well as the page.
  doc.addEventListener('scroll', reset, { passive: true, capture: true });
  // Chromium emits selectstart even when dragging blank card space. Only an
  // actual range selection hands the gesture back to text selection.
  listen(doc, 'selectionchange', () => { if (doc.getSelection()?.isCollapsed === false) reset(); });
  listen(doc, 'dragstart', reset);
  listen(doc, 'visibilitychange', () => { if (doc.hidden) reset(); });
  media.addEventListener('change', reset);
  const observer = new view.MutationObserver(() => {
    if (gesture && (!gesture.card.isConnected || !root.contains(gesture.card) || !available())) reset();
  });
  observer.observe(root, { childList: true, subtree: true });
  return {
    reset,
    destroy() {
      disposed = true;
      reset();
      listeners.forEach(remove => remove());
      doc.removeEventListener('scroll', reset, true);
      media.removeEventListener('change', reset);
      observer.disconnect();
    },
  };
}
