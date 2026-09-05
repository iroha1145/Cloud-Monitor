export type TrendSample = { time: number; value: number };

/** Smooth the stroke, never invent a peak or erase a reported negative fee. */
export function smoothTrendPoints(points: TrendSample[]): TrendSample[] {
  if (points.length < 3) return points;
  const result: TrendSample[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)].value;
    const p1 = points[i].value;
    const p2 = points[i + 1].value;
    const p3 = points[Math.min(points.length - 1, i + 2)].value;
    for (let sample = 0; sample < 9; sample += 1) {
      const t = sample / 9;
      const value = 0.5 * (2 * p1 + (-p0 + p2) * t +
        (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
        (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
      result.push({
        time: points[i].time + (points[i + 1].time - points[i].time) * t,
        // The source range is the bound, not zero: costs may include credits.
        value: Math.max(Math.min(p1, p2), Math.min(Math.max(p1, p2), value)),
      });
    }
  }
  result.push(points[points.length - 1]);
  return result;
}
