/*
 * The phone menu's motion: Feel's magnetic drawer (diip3sh/feel,
 * runtime/feel.js and components/magnetic-drawer.js, MIT). The panel is a
 * body with no target. Its position is its translateY in px, 0 at the open
 * stop. Every stop is a magnet with a long weak reach and a strong pull within
 * 22px (the click); between stops the panel coasts on its own momentum against
 * damping, and whichever magnet it ends up near catches it. Past either end a
 * stiff wall pushes back, damped only while the panel presses into it, which
 * is the rubber band. A finger holds the panel through a spring, so it lags a
 * little and the magnets are felt as detents under the finger.
 */
const TAU = Math.PI * 2;
const H = 1 / 240;

/** Feel's "magnetic" drawer: the neutral body (mass 1, 2.2Hz, damping ratio
 * 0.8) with magnets of strength 1 (reach 0.6 + 0.5 Hz, click 3 + 4 Hz), walls
 * at 8Hz damped 0.9, a 6Hz hand, at rest under 4px/s within 0.25px. */
export const DRAWER_FEEL = {
  mass: 1,
  damping: 2 * 0.8 * TAU * 2.2,
  reach: (TAU * 1.1) ** 2,
  click: (TAU * 7) ** 2,
  clickRadius: 22,
  wall: (TAU * 8) ** 2,
  wallDamping: 2 * 0.9 * TAU * 8,
  hand: (TAU * 6) ** 2,
  handDamping: 2 * TAU * 6,
  restSpeed: 4,
  restDistance: 0.25,
} as const;

export type DrawerStop = 'closed' | 'half' | 'open';
/** Stop offsets in px: open 0, closed the largest. */
export type DrawerStops = Record<DrawerStop, number>;
export type DrawerHand = { x: number; v: number; t: number };
export type DrawerBody = { x: number; v: number; hand: DrawerHand | null };
/** From the tab bar up to the open menu. */
export const DRAWER_STOP_ORDER: readonly DrawerStop[] = ['closed', 'half', 'open'];

/** A panel `height` px tall that shows `peek` px when closed travels
 * height − peek; the half stop is the middle of that. */
export function drawerStops(height: number, peek: number): DrawerStops {
  const closed = Math.max(0, Math.round(height - peek));
  return { open: 0, half: Math.round(closed / 2), closed };
}

/** The stop nearest x: where the panel rests from there when nothing moves it. */
export function nearestStop(x: number, stops: DrawerStops): DrawerStop {
  let best: DrawerStop = 'open';
  for (const stop of DRAWER_STOP_ORDER) if (Math.abs(stops[stop] - x) < Math.abs(stops[best] - x)) best = stop;
  return best;
}

const smooth = (e: number) => (e <= 0 ? 0 : e >= 1 ? 1 : e * e * (3 - 2 * e));

/** Every force on the panel at (x, v), the finger's included. */
export function drawerForce(x: number, v: number, stops: DrawerStops, hand: DrawerHand | null = null) {
  const f = DRAWER_FEEL;
  const u = x - stops[nearestStop(x, stops)];
  let force = -f.damping * v - f.reach * u - f.click * u * smooth(1 - Math.abs(u) / f.clickRadius);
  if (x < stops.open) force += -f.wall * (x - stops.open) - (v < 0 ? f.wallDamping * v : 0);
  if (x > stops.closed) force += -f.wall * (x - stops.closed) - (v > 0 ? f.wallDamping * v : 0);
  if (hand) force += f.hand * (hand.x - x) + f.handDamping * (hand.v - v);
  return force;
}

/** Advances the panel by dt seconds in 240Hz RK4 sub-steps. */
export function stepDrawer(body: DrawerBody, stops: DrawerStops, dt: number) {
  const steps = Math.max(1, Math.ceil(dt / H - 1e-9)), h = dt / steps, m = DRAWER_FEEL.mass;
  const a = (x: number, v: number) => drawerForce(x, v, stops, body.hand) / m;
  for (let i = 0; i < steps; i++) {
    const { x, v } = body;
    const k1x = v, k1v = a(x, v);
    const k2x = v + h / 2 * k1v, k2v = a(x + h / 2 * k1x, v + h / 2 * k1v);
    const k3x = v + h / 2 * k2v, k3v = a(x + h / 2 * k2x, v + h / 2 * k2v);
    const k4x = v + h * k3v, k4v = a(x + h * k3x, v + h * k3v);
    body.x = x + h / 6 * (k1x + 2 * k2x + 2 * k3x + k4x);
    body.v = v + h / 6 * (k1v + 2 * k2v + 2 * k3v + k4v);
  }
}

/** Free, slow and on a stop: the panel can snap there and stop simulating. */
export function drawerAtRest(body: DrawerBody, stops: DrawerStops) {
  return !body.hand && Math.abs(body.v) < DRAWER_FEEL.restSpeed && Math.abs(body.x - stops[nearestStop(body.x, stops)]) < DRAWER_FEEL.restDistance;
}

/** Where a free panel at (x, v) comes to rest. */
export function predictStop(x: number, v: number, stops: DrawerStops): DrawerStop {
  const ghost: DrawerBody = { x, v, hand: null };
  for (let t = 0; t < 6 && !drawerAtRest(ghost, stops); t += 1 / 60) stepDrawer(ghost, stops, 1 / 60);
  return nearestStop(ghost.x, stops);
}

/** The velocity change that lands the panel on `target`: a push, never a
 * timed slide. First exactly the push that coasts it there on damping alone
 * (Δx·c/m), which every stop pair at phone heights accepts; failing that,
 * Feel's search for the smallest push the magnets let through, plus 15%. */
export function pushToStop(x: number, v: number, target: DrawerStop, stops: DrawerStops) {
  const goal = stops[target];
  const coast = (goal - x) * DRAWER_FEEL.damping / DRAWER_FEEL.mass - v;
  if (predictStop(x, v + coast, stops) === target) return coast;
  const direction = Math.sign(goal - x) || 1;
  for (let push = 40; push < 40000; push *= 1.18) {
    if (predictStop(x, v + direction * push, stops) !== target) continue;
    return direction * (predictStop(x, v + direction * push * 1.15, stops) === target ? push * 1.15 : push);
  }
  return coast;
}

/** A finger sample: the hand keeps 35% of its old velocity and takes 65% of
 * the new one, so touch jitter just before lift-off does not kill a flick. */
export function moveHand(hand: DrawerHand, x: number, t: number): DrawerHand {
  const dt = (t - hand.t) / 1000;
  return { x, t, v: dt > 0 ? hand.v * 0.35 + (x - hand.x) / dt * 0.65 : hand.v };
}

/** The stop a tap on the grip moves to: closed, half, open, then closed. */
export function nextDrawerStop(stop: DrawerStop): DrawerStop {
  return stop === 'closed' ? 'half' : stop === 'half' ? 'open' : 'closed';
}
