/** Small deterministic helpers shared by the pointer controller and its tests. */
export const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export type Bounds = { left: number; right: number; top: number; bottom: number };
export const CORNERS: readonly Corner[] = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
export function navigationBounds(width: number, height: number, cardWidth: number, cardHeight: number): Bounds {
  return { left: 12, top: 12, right: Math.max(12, width - cardWidth - 12), bottom: Math.max(12, height - cardHeight - 12) };
}
export function projectedCorner(x: number, y: number, vx: number, vy: number, bounds: Bounds): Corner {
  const px = clamp(x + vx * .0658, bounds.left, bounds.right);
  const py = clamp(y + vy * .0658, bounds.top, bounds.bottom);
  return `${py > (bounds.top + bounds.bottom) / 2 ? 'bottom' : 'top'}-${px > (bounds.left + bounds.right) / 2 ? 'right' : 'left'}`;
}
export function cornerPosition(corner: Corner, bounds: Bounds) {
  return { x: corner.endsWith('right') ? bounds.right : bounds.left, y: corner.startsWith('bottom') ? bounds.bottom : bounds.top };
}
/** Stable semi-implicit spring, substepped so slow frames cannot explode. */
export function springStep(position: number, velocity: number, target: number, dt: number, stiffness = 345, damping = 16.5, mass = .35): [number, number] {
  const elapsed = clamp(dt, 0, .04), steps = Math.max(1, Math.ceil(elapsed / (1 / 240))), h = elapsed / steps;
  for (let i = 0; i < steps; i++) {
    velocity += ((target - position) * stiffness - damping * velocity) / mass * h;
    position += velocity * h;
  }
  return [position, velocity];
}
/** Three positions: fully open, half height and a closed handle. */
export function drawerStops(height: number, peek = 64) {
  return [0, Math.max(0, (height - peek) * .5), Math.max(0, height - peek)];
}
export function nearestDrawerStop(position: number, velocity: number, height: number) {
  const projected = position + clamp(velocity, -2600, 2600) * .12;
  return drawerStops(height).reduce((nearest, value) => Math.abs(value - projected) < Math.abs(nearest - projected) ? value : nearest, 0);
}
export type Rectangle = { left: number; right: number; top: number; bottom: number; width: number; height: number };
export type AvoidanceSide = 'left' | 'right' | null;
export type CardAvoidance = { inset: number; loss: number; limit: number; side: AvoidanceSide; covered: boolean };
/** Keep the original horizontal slot while making reading room beside a docked menu. */
export function cardAvoidance(card: Rectangle, menu: Rectangle | null, viewport: { left: number; right: number }, previousSide: AvoidanceSide = null): CardAvoidance {
  const readableWidth = Math.min(card.width, 272);
  const limit = Math.max(0, Math.min(card.width / 3, card.width - readableWidth));
  const clear: CardAvoidance = { inset: 0, loss: 0, limit, side: null, covered: false };
  if (!menu) return clear;
  const gap = 16, ramp = Math.max(1, Math.min(96, card.height / 2, menu.height / 4)), lead = Math.min(64, ramp);
  const overlap = Math.min(card.bottom, menu.bottom + lead) - Math.max(card.top, menu.top - lead);
  if (card.left >= menu.right || card.right <= menu.left || overlap <= 0) return clear;
  const distances = { left: menu.right + gap - card.left, right: card.right - menu.left + gap };
  const nearLeft = menu.left <= viewport.left + menu.width * .5;
  const nearRight = menu.right >= viewport.right - menu.width * .5;
  let side: Exclude<AvoidanceSide, null> = previousSide || (distances.left < distances.right ? 'left' : 'right');
  if (nearLeft) side = 'left';
  else if (nearRight) side = 'right';
  else if (distances.left <= menu.width / 3) side = 'left';
  else if (distances.right <= menu.width / 3) side = 'right';
  const dockInset = side === 'left'
    ? Math.max(0, viewport.left + menu.width + gap * 2 - card.left)
    : Math.max(0, card.right - (viewport.right - menu.width - gap * 2));
  const required = distances[side];
  const canClear = required <= limit && (nearLeft || nearRight || required <= menu.width / 3);
  const response = dockInset + Math.min(Math.max(0, required - dockInset) / 3, menu.width / 3);
  const t = Math.min(1, overlap / ramp), pressure = t * t * (3 - 2 * t);
  const loss = Math.min(limit, required, canClear ? required : response) * pressure;
  return { inset: side === 'left' ? loss : 0, loss, limit, side, covered: loss + .05 < required };
}

export type MobileCardAvoidance = { y: number; available: number; clear: boolean };
/** Mobile sheets repel visible nearby cards vertically, using only free space.
 * The preceding block may be a filter bar, notice, heading, or another card. */
export function mobileCardAvoidance(card: Rectangle, sheet: Rectangle | null, safeTop: number, precedingBottom: number | null): MobileCardAvoidance {
  const topRoom = card.top >= safeTop ? card.top - safeTop : Math.max(0, card.bottom - safeTop - 64);
  const precedingRoom = precedingBottom === null ? Infinity : Math.max(0, card.top - precedingBottom - 8);
  const available = Math.max(0, Math.min(32, topRoom, precedingRoom));
  const none: MobileCardAvoidance = { y: 0, available, clear: true };
  if (!sheet || card.right <= sheet.left || card.left >= sheet.right || card.bottom <= safeTop || card.top >= sheet.top) return none;
  const distance = sheet.top - card.bottom;
  if (distance >= 64) return none;
  const t = clamp((64 - Math.max(0, distance)) / 64, 0, 1), pressure = t * t * (3 - 2 * t);
  const required = Math.max(0, card.bottom - sheet.top + 16);
  const displacement = Math.min(available, Math.max(required, pressure * 12));
  return { y: -displacement, available, clear: card.bottom - displacement <= sheet.top - 16 + .05 };
}

export type ItemMotion = { x: number; y: number; scale: number };
/** Inner records react before contact, including after an outer card clears
 * the menu. The response never changes a record's layout width or spacing. */
export function itemRepulsion(item: Rectangle, menu: Rectangle | null, kind: 'row' | 'cell', mobile = false): ItemMotion {
  const still: ItemMotion = { x: 0, y: 0, scale: 1 };
  if (!menu || (mobile && item.top >= menu.top)) return still;
  const radius = kind === 'cell' ? 80 : 144, maximum = kind === 'cell' ? 1.8 : 7;
  let nx = item.right < menu.left ? item.right - menu.left : item.left > menu.right ? item.left - menu.right : 0;
  let ny = item.bottom < menu.top ? item.bottom - menu.top : item.top > menu.bottom ? item.top - menu.bottom : 0;
  const distance = Math.hypot(nx, ny);
  if (distance >= radius) return still;
  if (mobile) { nx = 0; ny = -1; }
  else if (distance > 0) { nx /= distance; ny /= distance; }
  else {
    const horizontal = Math.min(Math.abs(item.right - menu.left), Math.abs(item.left - menu.right));
    const vertical = Math.min(Math.abs(item.bottom - menu.top), Math.abs(item.top - menu.bottom));
    if (horizontal <= vertical) nx = item.left + item.width / 2 < menu.left + menu.width / 2 ? -1 : 1;
    else ny = item.top + item.height / 2 < menu.top + menu.height / 2 ? -1 : 1;
  }
  const t = 1 - distance / radius, pressure = t * t * (3 - 2 * t);
  return { x: nx * maximum * pressure, y: ny * maximum * pressure, scale: 1 - (kind === 'cell' ? .015 : .012) * pressure };
}
