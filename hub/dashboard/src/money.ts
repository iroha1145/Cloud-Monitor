/** USD 金额：符号在负号后面，避免 `$-0.45`。 */
export function usd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "未提供";
  const formatted = Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return value < 0 && formatted !== "0.00" ? `-$${formatted}` : `$${formatted}`;
}
