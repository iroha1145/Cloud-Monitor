/*
 * The phone menu's motion, after game-manage (frontend/src/floating-navigation.js).
 * One number, progress, runs from 0 (the tab bar) to 1 (the open menu), with
 * a half-open stop between. A tap springs from rest towards the next stop; a
 * release keeps its velocity, and the stop is chosen from where it would coast.
 */
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Closed tab bar, half-open menu, open menu. */
export const DRAWER_STOPS = { closed: 0, half: 0.5, open: 1 } as const;
export type DrawerStop = keyof typeof DRAWER_STOPS;

/** Finger travel becomes progressively less effective past either end: at
 * most `upperLimit` px above the open stop and 8 px below the closed one. */
export function resistDrawerProgress(value: number, travel: number, upperLimit = 40) {
  const edge = clamp(value, 0, 1);
  const distance = (value - edge) * Math.max(1, travel);
  const limit = distance < 0 ? 8 : upperLimit;
  return edge + Math.sign(distance) * limit * (1 - Math.exp(-Math.abs(distance) * 0.55 / limit)) / Math.max(1, travel);
}

/** The progress a resisted position came from, so a new drag continues from
 * the surface where it is (the inverse of resistDrawerProgress). */
export function unresistDrawerProgress(progress: number, travel: number, upperLimit = 40) {
  const edge = clamp(progress, 0, 1);
  const limit = progress < 0 ? 8 : upperLimit;
  const excess = Math.min(0.999, Math.abs(progress - edge) * Math.max(1, travel) / limit);
  return edge + Math.sign(progress - edge) * (-limit * Math.log(1 - excess) / 0.55) / Math.max(1, travel);
}

const H = 1 / 240;
const MAGNET_RADIUS = 0.22;
/** A magnetic drawer spring after Feel (runtime/feel.js magnets + wall):
 * a smoothstep magnetic well around the target stop pulls the sheet in and
 * increases local damping so it locks in after a crisp overshoot without
 * tail ringing, while a directional boundary wall cushions overshoots outside
 * [0, 1]. 240Hz RK4 sub-steps keep integration accurate at any frame rate. */
export function stepDrawerSpring(position: number, velocity: number, target: number, dt: number): [number, number] {
  const steps = Math.max(1, Math.min(24, Math.round(dt / H)));
  const h = dt / steps;
  let x = position, v = velocity;
  const accel = (px: number, pv: number) => {
    const dist = target - px;
    const t = clamp(1 - Math.abs(dist) / MAGNET_RADIUS, 0, 1);
    const magnet = t * t * (3 - 2 * t);
    const wall = px - clamp(px, 0, 1);
    const wallDamp = (px < 0 && pv < 0) || (px > 1 && pv > 0) ? pv * 14 : 0;
    return dist * (228 + 36 * magnet) - pv * (18.2 + 6.8 * magnet) - wall * 180 - wallDamp;
  };
  for (let i = 0; i < steps; i++) {
    const a1 = accel(x, v);
    const v2 = v + 0.5 * h * a1, a2 = accel(x + 0.5 * h * v, v2);
    const v3 = v + 0.5 * h * a2, a3 = accel(x + 0.5 * h * v2, v3);
    const v4 = v + h * a3, a4 = accel(x + h * v3, v4);
    x += (h / 6) * (v + 2 * v2 + 2 * v3 + v4);
    v += (h / 6) * (a1 + 2 * a2 + 2 * a3 + a4);
  }
  return [x, v];
}

/** A release keeps 160ms of its velocity and lands on the nearest stop, so a
 * slow drag rests on the half stop and a flick carries past it. */
export function chooseDrawerStop(progress: number, velocity: number): DrawerStop {
  const projected = progress + clamp(velocity, -6, 6) * 0.16;
  let best: DrawerStop = 'closed';
  for (const stop of Object.keys(DRAWER_STOPS) as DrawerStop[]) {
    if (Math.abs(DRAWER_STOPS[stop] - projected) < Math.abs(DRAWER_STOPS[best] - projected)) best = stop;
  }
  return best;
}

/** The stop a tap on the grip moves to: closed, half, open, then closed. */
export function nextDrawerStop(stop: DrawerStop): DrawerStop {
  return stop === 'closed' ? 'half' : stop === 'half' ? 'open' : 'closed';
}
