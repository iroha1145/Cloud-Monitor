/**
 * transitions.dev motion tokens for motion/react code, in seconds. They mirror
 * the CSS custom properties in motion.css so JS- and CSS-driven motion share
 * one rhythm.
 */
export const DURATION = {
  quick: 0.15,
  fast: 0.25,
  medium: 0.35,
} as const;

export const EASE_SMOOTH_OUT = [0.22, 1, 0.36, 1] as const;
