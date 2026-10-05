import { useId } from "react";
import { COMPOSITION } from "./palette";

// Fixed proportions: the mark quotes the usage spectrum, it does not chart data.
const SEGMENTS = [7.5, 3.5, 2.5, 1.5, 1];

export function BrandMark({ size = 28 }: { size?: number }) {
  const clip = useId();
  let x = 6;
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 28 28"
      aria-hidden="true"
    >
      <rect className="brand-mark-tile" width="28" height="28" rx="8" />
      <clipPath id={clip}>
        <rect x="6" y="11.5" width="16" height="5" rx="2.5" />
      </clipPath>
      <g clipPath={`url(#${clip})`}>
        {COMPOSITION.map((part, index) => {
          const width = SEGMENTS[index];
          const segment = (
            <rect
              key={part.key}
              x={x}
              y="11.5"
              width={Math.max(0.5, width - 0.6)}
              height="5"
              fill={part.color}
            />
          );
          x += width;
          return segment;
        })}
      </g>
    </svg>
  );
}
