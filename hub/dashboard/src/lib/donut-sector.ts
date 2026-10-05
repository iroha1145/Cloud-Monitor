/**
 * Ring sectors with rounded corners and a gap of fixed pixel width, adapted
 * from Arc UI's donut chart (registry/components/donut-chart/donut-chart.tsx,
 * https://uiarc.dev/components/donut-chart).
 *
 * MIT License, Copyright (c) 2026 Elia Kuratli
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

const TAU = Math.PI * 2;
const n2 = (value: number) => (Math.round(value * 100) / 100).toString();

/**
 * An annular sector between two turns of the ring (0 at the top, clockwise).
 * Its sides run parallel to the radius at a fixed distance, so the gap between
 * neighbours is the same number of pixels from the inner edge to the outer
 * one; a sector too thin for its corners narrows to a wedge instead.
 */
export function sector(
  c: number,
  R: number,
  r: number,
  t0: number,
  t1: number,
  gap: number,
  corner: number,
) {
  const turns = t1 - t0;
  if (turns <= 1e-6) return "";
  const at = (radius: number, angle: number) =>
    `${n2(c + radius * Math.cos(angle))} ${n2(c + radius * Math.sin(angle))}`;
  if (turns >= 1 - 1e-6)
    return `M${at(R, -Math.PI / 2)}A${n2(R)} ${n2(R)} 0 1 1 ${at(R, Math.PI / 2)}A${n2(R)} ${n2(R)} 0 1 1 ${at(R, -Math.PI / 2)}ZM${at(r, -Math.PI / 2)}A${n2(r)} ${n2(r)} 0 1 0 ${at(r, Math.PI / 2)}A${n2(r)} ${n2(r)} 0 1 0 ${at(r, -Math.PI / 2)}Z`;
  const p = Math.min(gap / 2, ((1 - turns) * TAU * R) / 2);
  const a0 = t0 * TAU - Math.PI / 2;
  const a1 = t1 * TAU - Math.PI / 2;
  const half = (a1 - a0) / 2;
  const s = Math.sin(Math.min(half, Math.PI / 2));
  if (s * R <= p + 1e-6) return "";
  const side = (t: number, angle: number, sign: number) =>
    `${n2(c + t * Math.cos(angle) - sign * p * Math.sin(angle))} ${n2(c + t * Math.sin(angle) + sign * p * Math.cos(angle))}`;
  const band = (R - r) / 2;
  const ro = Math.max(0, Math.min(corner, band, s >= 0.9999 ? Infinity : (s * R - p) / (1 + s)));
  const dO = Math.asin(Math.min(1, (p + ro) / (R - ro)));
  const tO = Math.sqrt(Math.max(0, (R - ro) ** 2 - (p + ro) ** 2));
  const bigO = a1 - a0 - 2 * dO > Math.PI ? 1 : 0;
  let d = `M${side(tO, a0, 1)}`;
  if (ro > 0.01) d += `A${n2(ro)} ${n2(ro)} 0 0 1 ${at(R, a0 + dO)}`;
  d += `A${n2(R)} ${n2(R)} 0 ${bigO} 1 ${at(R, a1 - dO)}`;
  if (ro > 0.01) d += `A${n2(ro)} ${n2(ro)} 0 0 1 ${side(tO, a1, -1)}`;
  if (s * r > p + 1e-6 || s >= 0.9999) {
    const ri = Math.max(0, Math.min(corner, band, s >= 0.9999 ? Infinity : (s * r - p) / (1 - s)));
    const dI = Math.asin(Math.min(1, (p + ri) / (r + ri)));
    const tI = Math.sqrt(Math.max(0, (r + ri) ** 2 - (p + ri) ** 2));
    const bigI = a1 - a0 - 2 * dI > Math.PI ? 1 : 0;
    d += `L${side(tI, a1, -1)}`;
    if (ri > 0.01) d += `A${n2(ri)} ${n2(ri)} 0 0 1 ${at(r, a1 - dI)}`;
    d += `A${n2(r)} ${n2(r)} 0 ${bigI} 0 ${at(r, a0 + dI)}`;
    if (ri > 0.01) d += `A${n2(ri)} ${n2(ri)} 0 0 1 ${side(tI, a0, 1)}`;
  } else d += `L${at(p / s, (a0 + a1) / 2)}`;
  return `${d}Z`;
}
