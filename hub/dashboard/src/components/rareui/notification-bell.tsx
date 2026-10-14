"use client";

import { useEffect, useRef } from "react";
import type { ComponentProps } from "react";
import {
  animate,
  AnimatePresence,
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
  useVelocity,
  type AnimationPlaybackControls,
  type MotionValue,
} from "motion/react";
import { cn } from "@/lib/utils";

// Matches the top bar's icon buttons: no fill until hovered, secondary ink.
const SURFACE = "bg-transparent hover:bg-(--hover)";
const GLYPH = "text-(--ink-2) hover:text-(--ink)";

const COLORS = {
  red: "bg-[#FF3B30] dark:bg-[#FF453A]",
  orange: "bg-[#FF9500] dark:bg-[#FF9F0A]",
  green: "bg-[#34C759] dark:bg-[#30D158]",
  blue: "bg-[#007AFF] dark:bg-[#0A84FF]",
  violet: "bg-[#AF52DE] dark:bg-[#BF5AF2]",
} as const;

// all sizes are a fraction of the size prop
const ICON = 0.56;
const DOT = 0.22;
// how far out the badge sits, 1 puts it right on the edge
const ORBIT = 0.9;

// low damping so it keeps swinging for a bit
const SWING_SPRING = {
  type: "spring",
  stiffness: 220,
  damping: 10,
  mass: 1,
  restDelta: 0.01,
} as const;
const CLAPPER_SPRING = { stiffness: 300, damping: 14, mass: 1 };
const ENTER_SPRING = { type: "spring", stiffness: 600, damping: 20 } as const;
const FADE = { duration: 0.15 } as const;

// degrees per second
const IMPULSE = 500;
const MAX_VELOCITY = 900;
const BURST = 5;
const CLAPPER_SWEEP = 13;
const CLAPPER_VELOCITY = 450;

const clamp = (value: number, limit: number) =>
  Math.max(-limit, Math.min(limit, value));

function badgeMetrics(size: number) {
  const side = size * DOT;
  return {
    side,
    // puts the badge on the circle so it lines up at any size
    inset: size / 2 - (ORBIT * size * Math.SQRT1_2) / 2 - side / 2,
  };
}

function useBellRing(total: number, reduced: boolean) {
  const swing = useMotionValue(0);
  const swingVelocity = useVelocity(swing);
  // clapper follows the bell's speed, so it lags behind on its own
  const clapperLag = useTransform(
    swingVelocity,
    [-CLAPPER_VELOCITY, 0, CLAPPER_VELOCITY],
    [CLAPPER_SWEEP, 0, -CLAPPER_SWEEP],
    { clamp: true },
  );
  const clapper = useSpring(clapperLag, CLAPPER_SPRING);
  const previous = useRef(total);
  const ringing = useRef<AnimationPlaybackControls | null>(null);

  useEffect(() => {
    const delta = total - previous.current;
    previous.current = total;
    if (delta <= 0 || reduced) return;

    const weight = 0.7 + (0.6 * Math.min(delta, BURST)) / BURST;
    const moving = swing.getVelocity();
    // push it the way it is already moving so it swings harder
    const along = moving > 1 ? 1 : -1;

    ringing.current = animate(swing, 0, {
      ...SWING_SPRING,
      velocity: clamp(moving + along * IMPULSE * weight, MAX_VELOCITY),
    });
  }, [total, reduced, swing]);

  useEffect(() => () => ringing.current?.stop(), []);

  return { swing, clapper };
}

function BellIcon({
  side,
  swing,
  clapper,
}: {
  side: number;
  swing: MotionValue<number>;
  clapper: MotionValue<number>;
}) {
  return (
    <motion.svg
      viewBox="0 0 18 18"
      fill="currentColor"
      aria-hidden
      width={side}
      height={side}
      // the bell hangs from the top, spinning from the middle looks wrong
      style={{ rotate: swing, transformOrigin: "50% 12%" }}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        fillOpacity={0.55}
        d="M3.5 6.5C3.5 3.46279 5.96279 1 9 1C12.0372 1 14.5 3.46279 14.5 6.5V10.75C14.5 11.4408 15.0592 12 15.75 12C16.1642 12 16.5 12.3358 16.5 12.75C16.5 13.1642 16.1642 13.5 15.75 13.5H2.25C1.83579 13.5 1.5 13.1642 1.5 12.75C1.5 12.3358 1.83579 12 2.25 12C2.94079 12 3.5 11.4408 3.5 10.75V6.5Z"
      />
      <motion.path
        style={{
          rotate: clapper,
          transformBox: "fill-box",
          transformOrigin: "50% 0%",
        }}
        d="M10.2 15H7.80099C7.64999 15 7.50799 15.068 7.41299 15.185C7.31799 15.302 7.28099 15.456 7.31199 15.603C7.48499 16.425 8.17999 17 9.00099 17C9.82199 17 10.517 16.425 10.69 15.603C10.721 15.456 10.684 15.302 10.589 15.185C10.494 15.068 10.351 15 10.2 15Z"
      />
    </motion.svg>
  );
}

function CountBadge({
  total,
  size,
  color,
  reduced,
}: {
  total: number;
  size: number;
  color: keyof typeof COLORS;
  reduced: boolean;
}) {
  const { side, inset } = badgeMetrics(size);

  return (
    <AnimatePresence initial={false}>
      {total > 0 && (
        <motion.span
          key="badge"
          // motion does not turn layout animation off for reduced motion, so we do it here
          layout={!reduced}
          aria-hidden
          className={cn(
            "pointer-events-none absolute z-10 grid place-items-center rounded-full",
            COLORS[color],
          )}
          style={{
            top: inset,
            right: inset,
            height: side,
            minWidth: side,
          }}
          initial={{ scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0, opacity: 0 }}
          transition={reduced ? FADE : ENTER_SPRING}
        />
      )}
    </AnimatePresence>
  );
}

export type NotificationBellProps = Omit<
  ComponentProps<"button">,
  | "children"
  | "color"
  | "onAnimationStart"
  | "onDrag"
  | "onDragStart"
  | "onDragEnd"
> & {
  count?: number;
  variant?: "dot";
  size?: number;
  color?: keyof typeof COLORS;
};

export function NotificationBell({
  count = 0,
  size = 48,
  color = "red",
  className,
  style,
  ...props
}: NotificationBellProps) {
  const reduced = useReducedMotion() ?? false;
  const total = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  // use the total so a weird count cannot ring the bell
  const { swing, clapper } = useBellRing(total, reduced);

  return (
    <button
      type="button"
      data-slot="notification-bell"
      className={cn(
        "relative grid place-items-center rounded-full outline-none transition-transform active:scale-90 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:active:scale-100",
        SURFACE,
        GLYPH,
        className,
      )}
      style={{ width: size, height: size, ...style }}
      {...props}
    >
      <BellIcon side={size * ICON} swing={swing} clapper={clapper} />
      <CountBadge
        total={total}
        size={size}
        color={color}
        reduced={reduced}
      />
    </button>
  );
}

export default NotificationBell;

