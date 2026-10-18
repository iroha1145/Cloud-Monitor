import type { ProjectUsage } from "./data";
import { clientName } from "./vendors";

export type ProjectBreakdown = "model" | "client";

export interface ProjectShare {
  key: string;
  label: string;
  tokens: number;
  /** Of the project's tokens. */
  share: number;
  kind: "named" | "other" | "unattributed";
  /** A CSS background: bar segments and tooltip swatches use the same one. */
  color: string;
}

/** The quota bars' three colours in turn, then grey; usage without a model or
 * client is striped, like every other unknown part on the dashboard. */
const NAMED_COLORS = ["var(--share-1)", "var(--share-2)", "var(--share-3)"];
const OTHER_COLOR = "var(--share-rest)";
export const UNATTRIBUTED_COLOR =
  "repeating-linear-gradient(120deg, var(--line-strong) 0 3px, var(--surface) 3px 6px)";

export const BREAKDOWN_LABELS: Record<ProjectBreakdown, string> = {
  model: "模型",
  client: "客户端",
};

/** Every named part, largest first, then the part no source attributed. The
 * first three named parts get their own colour; the rest share the grey of
 * the bar's 其他 segment. */
export function projectShares(project: ProjectUsage, by: ProjectBreakdown): ProjectShare[] {
  const source = by === "model" ? project.models : project.clients;
  const named = Object.entries(source)
    .filter(([, tokens]) => tokens > 0)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
  const attributed = named.reduce((sum, [, tokens]) => sum + tokens, 0);
  // Parts are reported per source; never let them claim more than the project.
  const total = Math.max(project.totalTokens, attributed);
  const rows: ProjectShare[] = named.map(([key, tokens], index) => ({
    key,
    label: by === "model" ? key : clientName(key),
    tokens,
    share: total ? tokens / total : 0,
    kind: "named",
    color: NAMED_COLORS[index] ?? OTHER_COLOR,
  }));
  const rest = total - attributed;
  if (rest > 0) {
    rows.push({
      key: "__unattributed",
      label: `未区分${BREAKDOWN_LABELS[by]}`,
      tokens: rest,
      share: rest / total,
      kind: "unattributed",
      color: UNATTRIBUTED_COLOR,
    });
  }
  return rows;
}

/** The first `limit` named parts, the others as one, then the unattributed
 * part. The bar and its legend keep the three coloured parts. */
export function groupedShares(shares: ProjectShare[], by: ProjectBreakdown, limit = NAMED_COLORS.length): ProjectShare[] {
  const named = shares.filter((share) => share.kind === "named");
  const others = named.slice(limit);
  const grouped = named.slice(0, limit);
  if (others.length) {
    grouped.push({
      key: "__other",
      label: `其他 ${others.length} 个${BREAKDOWN_LABELS[by]}`,
      tokens: others.reduce((sum, share) => sum + share.tokens, 0),
      share: others.reduce((sum, share) => sum + share.share, 0),
      kind: "other",
      color: OTHER_COLOR,
    });
  }
  return [...grouped, ...shares.filter((share) => share.kind === "unattributed")];
}
