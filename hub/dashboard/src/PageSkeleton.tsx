import type { CSSProperties } from "react";

/**
 * Placeholder cards while a view's code loads (transitions.dev 14, skeleton
 * loader). The loaded sections then rise in through the page stage.
 */
export function PageSkeleton({
  label,
  summary = false,
  columns = 3,
  height = 180,
}: {
  label: string;
  summary?: boolean;
  columns?: number;
  height?: number;
}) {
  const block = (px: number) => ({ "--skeleton-height": `${px}px` }) as CSSProperties;
  return (
    <div className="skeleton-stage" role="status">
      <span className="sr-only">{label}</span>
      {summary && <span className="skeleton-block" style={block(96)} aria-hidden="true" />}
      <div
        className="skeleton-row"
        style={{ "--skeleton-columns": columns } as CSSProperties}
        aria-hidden="true"
      >
        {Array.from({ length: columns }, (_, index) => (
          <span key={index} className="skeleton-block" style={block(height)} />
        ))}
      </div>
    </div>
  );
}
