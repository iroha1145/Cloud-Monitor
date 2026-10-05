import { useId } from "react";

/** The original Cloud Monitor logo: a cloud on a teal tile with a mint dot,
 * the same drawing as public/favicon.svg. */
export function BrandMark({ size = 33 }: { size?: number }) {
  const gradient = useId();
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 33 33"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradient} x1="4.72%" y1="-3.96%" x2="95.28%" y2="103.96%">
          <stop stopColor="#4495a3" />
          <stop offset="1" stopColor="#18596e" />
        </linearGradient>
      </defs>
      <rect width="33" height="33" rx="10" fill={`url(#${gradient})`} />
      <g
        transform="translate(5 5) scale(.9583333333)"
        fill="none"
        stroke="#fff"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
      </g>
      <circle cx="24.5" cy="24.5" r="2.5" fill="#a8e4de" />
    </svg>
  );
}
