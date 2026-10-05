/**
 * The five usage parts, in the order every bar, chart and legend draws them.
 * Each colour keeps at least 3:1 against both themes' surfaces except the
 * deliberately quiet "unclassified" grey.
 */
export const COMPOSITION = [
  { key: "cacheRead", label: "缓存读取", color: "#1f9e70" },
  { key: "input", label: "非缓存输入", color: "#2f86ec" },
  { key: "output", label: "输出", color: "#d97b17" },
  { key: "cacheWrite", label: "缓存写入", color: "#9d7bb8" },
  { key: "unclassified", label: "未分类", color: "#a7b1c2" },
] as const;

export type CompositionKey = (typeof COMPOSITION)[number]["key"];

export const PART_COLOR = Object.fromEntries(
  COMPOSITION.map((part) => [part.key, part.color]),
) as Record<CompositionKey, string>;
