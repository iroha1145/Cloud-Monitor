import type { Quota } from "./data";
import { formatMoney as money } from "./money";

const number = (value: number) => {
  const rounded = Math.round(value * 100) / 100;
  const clean = Math.abs(rounded) < 0.0005 ? 0 : rounded;
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(clean);
};

export function quotaAmount(value: number, quota: Pick<Quota, "metric" | "currency" | "provider" | "kind" | "limitId">): string {
  const currency = quota.currency?.toUpperCase();
  if (currency === "CREDITS") return number(value);
  if (currency) return money(value, currency);
  if (quota.metric === "spend") return `${number(value)}（单位未提供）`;
  if (quota.metric === "credits") return `${number(value)}（单位未提供）`;
  // Older collectors leave the unit blank for counts and token pools.
  if (quota.provider === "zai" || quota.provider === "zaiteam") {
    if (quota.kind === "daily" || (quota.kind === "billing" && quota.limitId))
      return `${number(value)} 词元`;
  }
  return number(value);
}

export function quotaBalance(value: number, quota: Pick<Quota, "balanceCurrency" | "currency">): string {
  const currency = quota.balanceCurrency || quota.currency;
  if (!currency) return `${number(value)}（单位未提供）`;
  return currency.toUpperCase() === "CREDITS" ? number(value) : money(value, currency);
}

export function quotaPercent(quota: Pick<Quota, "usedPercent" | "limit" | "used">): number | null {
  if (quota.usedPercent !== null) return Math.max(0, Math.min(100, quota.usedPercent));
  if (quota.limit !== null && quota.limit > 0 && quota.used !== null)
    return Math.max(0, Math.min(100, (quota.used / quota.limit) * 100));
  return null;
}

export function quotaHeadline(quota: Quota): { value: string; label: string } {
  const percent = quotaPercent(quota);
  if (quota.metric === "balance") {
    return {
      value: quota.balanceUsd !== null ? money(quota.balanceUsd, "USD")
        : quota.balance !== null && quota.balance !== undefined ? quotaBalance(quota.balance, quota)
          : "未提供",
      label: "",
    };
  }
  // A prepaid balance is an amount, even when a display meter also has a percent.
  if (quota.metric === "credits" && quota.remaining !== null)
    return { value: quotaAmount(quota.remaining, quota), label: quota.currency?.toUpperCase() === "CREDITS" ? "剩余点数" : "剩余" };
  if (quota.metric === "spend" && quota.used !== null)
    return { value: quotaAmount(quota.used, quota), label: "已用" };
  if (percent !== null)
    return { value: `${number(percent)}%`, label: "已用" };
  if (quota.remaining !== null)
    return { value: quotaAmount(quota.remaining, quota), label: "剩余" };
  if (quota.used !== null)
    return { value: quotaAmount(quota.used, quota), label: "已用" };
  if (quota.balanceUsd !== null)
    return { value: money(quota.balanceUsd, "USD"), label: "余额" };
  return { value: "未提供", label: "" };
}

export function quotaBoundaryLabel(boundaryKind: Quota["boundaryKind"]): string {
  return boundaryKind === "expiry" ? "到期"
    : boundaryKind === "mixed" ? "变化"
      : "重置";
}
