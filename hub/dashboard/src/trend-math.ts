/** Keep the selected calendar day when the 30-day window slides (W-N8). */
export function indexForSelectedDay(
  series: readonly { day: string }[],
  selectedDay: string | null,
): number {
  if (selectedDay) {
    const found = series.findIndex((item) => item.day === selectedDay);
    if (found >= 0) return found;
  }
  return Math.max(0, series.length - 1);
}

const oneDecimal = (value: number) => String(Math.round(value * 10) / 10);

/** Short scale labels that fit the 56px axis column: 8000万, 1.2亿, $90, -$0.25. */
export function axisLabel(value: number, metric: "tokens" | "cost"): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (metric === "cost") {
    if (abs >= 100) return `${sign}$${Math.round(abs)}`;
    return abs >= 1 ? `${sign}$${oneDecimal(abs)}` : `${sign}$${abs.toFixed(2)}`;
  }
  if (abs >= 99_950_000) return `${sign}${oneDecimal(abs / 1e8)}亿`;
  if (abs >= 1e4) return `${sign}${oneDecimal(abs / 1e4)}万`;
  return String(Math.round(value));
}
