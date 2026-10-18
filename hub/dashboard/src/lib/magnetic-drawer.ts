/*
 * Magnetic drawer physics, adapted from Feel runtime/feel.js and
 * components/magnetic-drawer.js: https://github.com/diip3sh/feel
 *
 * MIT License
 * Copyright (c) 2026 diip3sh
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

const TAU = 2 * Math.PI;
export const MAGNETIC_DRAWER = { mass: 1, damping: 2 * .8 * TAU * 2.2, reachHz: 1.1, clickHz: 7, clickRadius: 22, handHz: 6, wallHz: 8 } as const;
const smooth = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };

/** A free body in a nearest-magnet field. There is deliberately no target
 * spring: hand motion, free releases and button impulses share this model. */
export class MagneticDrawer {
  x: number;
  v = 0;
  hand: { x: number; v: number; t: number } | null = null;
  stops: number[];
  constructor(stops: readonly number[], start = stops[stops.length - 1]) { this.stops = [...stops]; this.x = start; }
  rest(x = this.x) { return this.stops.reduce((a, b) => Math.abs(a - x) <= Math.abs(b - x) ? a : b); }
  get index() { return this.stops.indexOf(this.rest()); }
  force(x: number, v: number) {
    const p = MAGNETIC_DRAWER, u = x - this.rest(x);
    let f = -p.damping * v - (TAU * p.reachHz) ** 2 * u - (TAU * p.clickHz) ** 2 * u * smooth(1 - Math.abs(u) / p.clickRadius);
    const min = this.stops[0], max = this.stops[this.stops.length - 1], kw = (TAU * p.wallHz) ** 2, cw = 2 * .9 * Math.sqrt(kw);
    if (x < min) f += -kw * (x - min) - (v < 0 ? cw * v : 0);
    if (x > max) f += -kw * (x - max) - (v > 0 ? cw * v : 0);
    if (this.hand) {
      const kh = (TAU * p.handHz) ** 2, ch = 2 * Math.sqrt(kh);
      f += kh * (this.hand.x - x) + ch * (this.hand.v - v);
    }
    return f;
  }
  step(dt: number) {
    const n = Math.max(1, Math.ceil(dt * 240)), h = dt / n;
    for (let i = 0; i < n; i++) {
      const x = this.x, v = this.v;
      const a = this.force(x, v), b = this.force(x + h * v / 2, v + h * a / 2);
      const c = this.force(x + h * (v + h * a / 2) / 2, v + h * b / 2);
      const d = this.force(x + h * (v + h * b / 2), v + h * c);
      this.x += h / 6 * (v + 2 * (v + h * a / 2) + 2 * (v + h * b / 2) + v + h * c);
      this.v += h / 6 * (a + 2 * b + 2 * c + d);
    }
  }
  settled() { return !this.hand && Math.abs(this.v) < 4 && Math.abs(this.x - this.rest()) < .25; }
  snap(stop = this.rest()) { this.x = stop; this.v = 0; this.hand = null; }
  grab(x: number, time: number) { this.hand = { x, v: 0, t: time }; }
  move(x: number, time: number) {
    if (!this.hand) return;
    const dt = (time - this.hand.t) / 1000;
    if (dt > 0) this.hand.v = this.hand.v * .35 + (x - this.hand.x) / dt * .65;
    this.hand.x = x; this.hand.t = time;
  }
  release() { this.hand = null; }
  predict(velocity = this.v) {
    const ghost = new MagneticDrawer(this.stops, this.x); ghost.v = velocity;
    for (let t = 0; t < 6; t += 1 / 60) { ghost.step(1 / 60); if (ghost.settled()) break; }
    return ghost.rest();
  }
  /** Find one impulse that coasts into the requested magnet. Existing velocity
   * remains part of the prediction, including when a moving sheet is caught. */
  kickTo(stop: number) {
    this.hand = null;
    if (Math.abs(this.x - stop) < .25 && Math.abs(this.v) < 4) { this.snap(stop); return; }
    const dir = Math.sign(stop - this.x) || 1;
    let impulse = (stop - this.x) * MAGNETIC_DRAWER.damping - this.v;
    const lands = (push: number) => this.predict(this.v + push) === stop;
    for (let s = 40; s < 40000; s *= 1.18) if (lands(dir * s)) {
      impulse = dir * (lands(dir * s * 1.15) ? s * 1.15 : s); break;
    }
    this.v += impulse;
  }
  resize(stops: readonly number[]) {
    const before = this.stops[this.stops.length - 1], after = stops[stops.length - 1], ratio = before ? after / before : 1;
    this.x *= ratio; this.v *= ratio;
    if (this.hand) { this.hand.x *= ratio; this.hand.v *= ratio; }
    this.stops = [...stops];
  }
}

export function magneticStops(height: number, collapsedHeight: number) { const travel = Math.max(1, height - collapsedHeight); return [0, travel / 2, travel] as const; }
