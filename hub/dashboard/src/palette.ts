/**
 * The five usage parts, in the order every bar, chart and legend draws them.
 * These are the dashboard's original colours, the same in both themes. The
 * lighter ones sit below 3:1 on white, so every chart that uses them also
 * prints each part's value and share beside it.
 */
export const COMPOSITION = [
  { key: "cacheRead", label: "缓存读取", color: "#25a878" },
  { key: "input", label: "非缓存输入", color: "#3d9aff" },
  { key: "output", label: "输出", color: "#f09a2f" },
  { key: "cacheWrite", label: "缓存写入", color: "#b393c5" },
  { key: "unclassified", label: "未分类", color: "#b4becf" },
] as const;

export type CompositionKey = (typeof COMPOSITION)[number]["key"];

export const PART_COLOR = Object.fromEntries(
  COMPOSITION.map((part) => [part.key, part.color]),
) as Record<CompositionKey, string>;

/** The trend line's original colours: tokens blue, cost orange; the cache
 * dot in its header uses the cache-read green. */
export const TREND_COLOR = {
  tokens: "#3d9aff",
  cost: "#f09a2f",
  cache: "#25a878",
} as const;
