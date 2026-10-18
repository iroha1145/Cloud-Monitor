"use client";

import { useRef, useState, type ReactNode } from "react";

type GlideMenuProps = {
  children: ReactNode;
  className?: string;
  highlightClassName?: string;
  rowSelector?: string;
};

/** A single hover layer that glides between interactive menu rows. */
export default function GlideMenu({
  children,
  className = "",
  highlightClassName = "inset-x-0 rounded-[8px] bg-hover",
  rowSelector = "[data-menu-row]",
}: GlideMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ top: number; height: number; animate: boolean } | null>(null);
  const [visible, setVisible] = useState(false);

  const moveTo = (target: EventTarget | null) => {
    const container = ref.current;
    if (!(target instanceof Element) || !container) return;
    const row = target.closest(rowSelector);
    if (!(row instanceof HTMLElement) || !container.contains(row)) return;
    const containerRect = container.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const scaleY = container.offsetHeight > 0 ? containerRect.height / container.offsetHeight : 1;
    setBox({
      top: (rowRect.top - containerRect.top) / (scaleY || 1),
      height: rowRect.height / (scaleY || 1),
      animate: visible && box !== null,
    });
    setVisible(true);
  };

  return (
    <div
      ref={ref}
      onMouseOver={(event) => moveTo(event.target)}
      onMouseLeave={() => setVisible(false)}
      onFocusCapture={(event) => moveTo(event.target)}
      onBlurCapture={(event) => {
        if (!ref.current?.contains(event.relatedTarget as Node | null)) setVisible(false);
      }}
      className={`group/glide-menu relative ${className}`}
    >
      <span
        aria-hidden
        className={`pointer-events-none absolute ${highlightClassName}`}
        style={{
          top: 0,
          height: box?.height ?? 0,
          opacity: box && visible ? 1 : 0,
          transform: `translate3d(0, ${box?.top ?? 0}px, 0)`,
          transition: box?.animate
            ? "transform var(--duration-normal, 220ms) var(--ease-spring-smooth, cubic-bezier(0.22,1,0.36,1)), height var(--duration-normal, 220ms) var(--ease-spring-smooth, cubic-bezier(0.22,1,0.36,1)), opacity var(--duration-quick, 140ms) var(--ease-smooth-out, ease)"
            : "opacity var(--duration-quick, 140ms) var(--ease-smooth-out, ease)",
        }}
      />
      {children}
    </div>
  );
}
