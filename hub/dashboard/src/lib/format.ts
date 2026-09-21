/** 数字展示格式化：紧凑（万/亿）、精确计数、百分比。空值文案统一「未提供」。 */

/** 紧凑计数：≥1 亿两位小数、≥1 万一位小数、其余千分位原样。 */
export function compact(value: number): string {
  return value >= 1e8
    ? `${(value / 1e8).toFixed(2)} 亿`
    : value >= 1e4
      ? `${(value / 1e4).toFixed(1)} 万`
      : value.toLocaleString("en-US");
}

/** NumberTicker 的万/亿缩放对：显示值 = 原值 / divisor，后缀 suffix。 */
export function compactScale(value: number): { divisor: number; suffix: string } {
  return value >= 1e8
    ? { divisor: 1e8, suffix: " 亿" }
    : value >= 1e4
      ? { divisor: 1e4, suffix: " 万" }
      : { divisor: 1, suffix: "" };
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
