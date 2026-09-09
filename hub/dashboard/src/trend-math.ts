export type TrendSample = { time: number; value: number };

/** Samples per day-to-day span. Dense enough that Liveline's second spline stays round. */
export const TREND_SAMPLES_PER_SEGMENT = 16;

function clampToSegment(value: number, left: number, right: number): number {
  const lo = Math.min(left, right);
  const hi = Math.max(left, right);
  return Math.max(lo, Math.min(hi, value));
}

/**
 * Fritsch–Carlson slopes. Local extrema get a flat tangent so the stroke
 * rounds instead of folding, and the curve never overshoots a segment.
 */
function monotoneSlopes(points: TrendSample[]): number[] {
  const n = points.length;
  const delta = new Array<number>(n - 1);
  for (let i = 0; i < n - 1; i += 1) {
    const dt = points[i + 1].time - points[i].time;
    delta[i] = dt === 0 ? 0 : (points[i + 1].value - points[i].value) / dt;
  }
  const m = new Array<number>(n);
  m[0] = delta[0] ?? 0;
  m[n - 1] = delta[n - 2] ?? 0;
  for (let i = 1; i < n - 1; i += 1) {
    m[i] = delta[i - 1] * delta[i] <= 0 ? 0 : (delta[i - 1] + delta[i]) / 2;
  }
  for (let i = 0; i < n - 1; i += 1) {
    if (delta[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const alpha = m[i] / delta[i];
    const beta = m[i + 1] / delta[i];
    const steep = alpha * alpha + beta * beta;
    if (steep > 9) {
      const scale = 3 / Math.sqrt(steep);
      m[i] = scale * alpha * delta[i];
      m[i + 1] = scale * beta * delta[i];
    }
  }
  return m;
}

function hermite(
  left: number,
  right: number,
  leftSlope: number,
  rightSlope: number,
  dt: number,
  t: number,
): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * left +
    (t3 - 2 * t2 + t) * (leftSlope * dt) +
    (-2 * t3 + 3 * t2) * right +
    (t3 - t2) * (rightSlope * dt)
  );
}

/** Smooth the stroke, never invent a peak or erase a reported negative fee. */
export function smoothTrendPoints(points: TrendSample[]): TrendSample[] {
  if (points.length < 3) return points;
  const slopes = monotoneSlopes(points);
  const result: TrendSample[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const from = points[i];
    const to = points[i + 1];
    const dt = to.time - from.time;
    for (let sample = 0; sample < TREND_SAMPLES_PER_SEGMENT; sample += 1) {
      const t = sample / TREND_SAMPLES_PER_SEGMENT;
      result.push({
        time: from.time + dt * t,
        value: clampToSegment(
          hermite(from.value, to.value, slopes[i], slopes[i + 1], dt, t),
          from.value,
          to.value,
        ),
      });
    }
  }
  result.push(points[points.length - 1]);
  return result;
}
