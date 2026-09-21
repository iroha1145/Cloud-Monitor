/** 带时区的时间格式化。Intl.DateTimeFormat 遇非法时区抛 RangeError，统一在此兜底。 */

/** 带时区格式化；非法时区回退 null，兜本文案由调用方决定。 */
export function formatZoned(
  date: Date,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
  locale = "zh-CN",
): string | null {
  try {
    return new Intl.DateTimeFormat(locale, { timeZone, ...options }).format(date);
  } catch {
    return null;
  }
}

/** en-CA 的 YYYY-MM-DD 日键；非法时区回退 null。 */
export function dayKeyZoned(date: Date, timeZone: string): string | null {
  return formatZoned(
    date,
    timeZone,
    { year: "numeric", month: "2-digit", day: "2-digit" },
    "en-CA",
  );
}

/** 时区标识是否可用（非法标识会让 Intl.DateTimeFormat 抛 RangeError）。 */
export function isValidTimeZone(timeZone: string): boolean {
  return formatZoned(new Date(), timeZone, {}, "en-US") !== null;
}
