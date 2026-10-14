/** USD 金额：符号在负号后面，避免 `$-0.45`。 */
export function usd(value: number | null): string {
  return formatMoney(value, "USD");
}

const numberFallback = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 2,
});

export function formatMoney(
  value: number | null | undefined,
  currency?: string | null,
): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "未提供";
  const code = (currency || "USD").trim().toUpperCase();
  if (code === "USD" || code === "CNY" || code === "CNH") {
    const symbol = code === "USD" ? "$" : "¥";
    const formatted = Math.abs(value).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return value < 0 && formatted !== "0.00"
      ? `-${symbol}${formatted}`
      : `${symbol}${formatted}`;
  }
  try {
    return new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${code} ${numberFallback.format(value)}`;
  }
}

