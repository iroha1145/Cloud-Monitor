/** 数字展示格式化：紧凑（万/亿）、精确计数、百分比。空值文案统一「未提供」。 */

/** 紧凑计数：≥1 亿两位小数、≥1 万一位小数、其余千分位原样。 */
export function compact(value: number): string {
  if (value >= 1e8) return `${(value / 1e8).toFixed(2)} 亿`;
  if (value >= 1e4) {
    const wan = (value / 1e4).toFixed(1);
    // 9995 万 round 成 10000 万时应滚到 1 亿，而不是显示「10000.0 万」
    if (Number(wan) >= 10000) return compact(1e8);
    return `${wan} 万`;
  }
  return value.toLocaleString("en-US");
}

/** 精确计数（千分位）。 */
export function count(value: number): string {
  return value.toLocaleString("en-US");
}

/** 完整计数；空值「未提供」。 */
export function full(value: number | null): string {
  return value === null ? "未提供" : value.toLocaleString("zh-CN");
}

/** 0–1 → 百分比一位小数；空值「未提供」。 */
export function pct(value: number | null): string {
  return value === null ? "未提供" : `${(value * 100).toFixed(1)}%`;
}
