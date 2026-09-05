import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  HTMLAttributes,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  ReactNode,
} from "react";
import { createPortal } from "react-dom";
import "./metric-tooltip.css";

export type MetricDetailRow = {
  label: string;
  value: ReactNode;
  color?: string;
};
type Anchor = { x: number; y: number; input: "mouse" | "touch" | "keyboard" };
type Gesture = {
  id: number;
  x: number;
  y: number;
  startedAt: number;
  dragged: boolean;
};
const OPEN_EVENT = "cm-metric-tooltip-open";

/** Same fixed, pointer-relative placement as the trend. No arrow is rendered. */
function FloatingMetricCard({
  id,
  anchor,
  title,
  rows,
  note,
}: {
  id: string;
  anchor: Anchor;
  title: string;
  rows: MetricDetailRow[];
  note?: string;
}) {
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const card = element.current;
    if (!card) return;
    const view = window.visualViewport;
    const margin = 12;
    const minX = (view?.offsetLeft ?? 0) + margin;
    const minY = (view?.offsetTop ?? 0) + margin;
    const availableWidth = Math.max(
      1,
      (view?.width ?? window.innerWidth) - margin * 2,
    );
    const availableHeight = Math.max(
      1,
      (view?.height ?? window.innerHeight) - margin * 2,
    );
    card.style.width = `${Math.min(274, availableWidth)}px`;
    const scale = Math.min(1, availableHeight / card.offsetHeight);
    const width = card.offsetWidth * scale;
    const height = card.offsetHeight * scale;
    const maxX = minX + availableWidth;
    const maxY = minY + availableHeight;
    const above = anchor.input !== "mouse";
    const gap = anchor.input === "touch" ? 28 : 16;
    let x = above ? anchor.x - width / 2 : anchor.x + gap;
    let y = above ? anchor.y - height - gap : anchor.y + gap;
    if (!above && x + width > maxX) x = anchor.x - width - gap;
    if (above && y < minY) y = anchor.y + gap;
    if (!above && y + height > maxY) y = anchor.y - height - gap;
    x = Math.min(Math.max(x, minX), maxX - width);
    y = Math.min(Math.max(y, minY), maxY - height);
    card.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
    card.style.visibility = "visible";
  }, [anchor, title, rows, note]);
  return createPortal(
    <div
      ref={element}
      id={`${id}-content`}
      className="metric-tooltip-card"
      role="tooltip"
      data-slot="tooltip-content"
      data-state="open"
      data-input={anchor.input}
      data-metric-tooltip={id}
    >
      <strong className="metric-tooltip-title">{title}</strong>
      <dl>
        {rows.map((row, index) => (
          <div key={`${row.label}-${index}`}>
            <dt>
              {row.color && <i style={{ background: row.color }} />}
              {row.label}
            </dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      {note && <p>{note}</p>}
    </div>,
    document.body,
  );
}

/** Mouse movement and a held touch update independent screen coordinates.
 * Touch release pins the details; keyboard focus uses a stable trigger anchor. */
export function MetricTooltip({
  children,
  title,
  rows,
  note,
  preserveAction = false,
  strictTouchBounds = false,
}: {
  children: ReactElement;
  title: string;
  rows: MetricDetailRow[];
  note?: string;
  /** Keep a short tap/keyboard action; suppress click after inspection by drag or hold. */
  preserveAction?: boolean;
  /** Ignore native touch retargeting beyond a deliberately sized bar trigger. */
  strictTouchBounds?: boolean;
}) {
  const id = useId();
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const anchorRef = useRef<Anchor | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const scrollSnapshot = useRef<{ node: Element; x: number; y: number }[]>([]);
  const open = anchor !== null;
  const close = useCallback(() => {
    anchorRef.current = null;
    setAnchor(null);
  }, []);
  const show = (next: Anchor, target: HTMLElement) => {
    if (!anchorRef.current) {
      window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: id }));
      scrollSnapshot.current = [];
      for (let node: Element | null = target; node; node = node.parentElement)
        scrollSnapshot.current.push({
          node,
          x: node.scrollLeft,
          y: node.scrollTop,
        });
    }
    anchorRef.current = next;
    setAnchor(next);
  };
  const showFromPointer = (event: ReactPointerEvent<HTMLElement>) =>
    show(
      {
        x: event.clientX,
        y: event.clientY,
        input: event.pointerType === "mouse" ? "mouse" : "touch",
      },
      event.currentTarget,
    );
  const showFromKeyboard = (target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    show(
      { x: rect.left + rect.width / 2, y: rect.top, input: "keyboard" },
      target,
    );
  };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        (target.closest(`[data-metric-trigger="${id}"]`) ||
          target.closest(`[data-metric-tooltip="${id}"]`))
      )
        return;
      close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const anotherMetric = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== id) close();
    };
    const scroll = () => {
      // Ignore an old queued scroll from bringing a row into view before tap.
      // Only a real change to a trigger ancestor closes the open details.
      if (
        scrollSnapshot.current.some(
          ({ node, x, y }) => node.scrollLeft !== x || node.scrollTop !== y,
        )
      )
        close();
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    window.addEventListener(OPEN_EVENT, anotherMetric);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", scroll, true);
    window.visualViewport?.addEventListener("resize", close);
    window.visualViewport?.addEventListener("scroll", close);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", escape);
      window.removeEventListener(OPEN_EVENT, anotherMetric);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", scroll, true);
      window.visualViewport?.removeEventListener("resize", close);
      window.visualViewport?.removeEventListener("scroll", close);
    };
  }, [open, id, close]);

  const child = children as ReactElement<HTMLAttributes<HTMLElement>>;
  // cloneElement retains the existing child ref, including calendar roving focus.
  const trigger = cloneElement(child, {
    tabIndex: child.props.tabIndex ?? 0,
    "aria-label": child.props["aria-label"] || `${title}，查看详细信息`,
    "aria-describedby":
      [child.props["aria-describedby"], open ? `${id}-content` : null]
        .filter(Boolean)
        .join(" ") || undefined,
    ...{ "data-metric-trigger": id },
    onPointerEnter(event) {
      child.props.onPointerEnter?.(event);
      if (event.pointerType === "mouse") showFromPointer(event);
    },
    onPointerMove(event) {
      child.props.onPointerMove?.(event);
      const held = gesture.current;
      if (
        held &&
        Math.hypot(event.clientX - held.x, event.clientY - held.y) > 5
      )
        held.dragged = true;
      if (event.pointerType === "mouse" || held?.id === event.pointerId)
        showFromPointer(event);
    },
    onPointerDown(event) {
      if (strictTouchBounds && event.pointerType !== "mouse") {
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        ) {
          // Also prevent the adjusted touch from focusing and reopening the card.
          event.preventDefault();
          suppressClick.current = true;
          close();
          return;
        }
      }
      if (preserveAction) child.props.onPointerDown?.(event);
      if (event.pointerType !== "mouse" || !preserveAction)
        event.preventDefault();
      if (!preserveAction) event.stopPropagation();
      suppressClick.current = false;
      gesture.current = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        startedAt: performance.now(),
        dragged: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      showFromPointer(event);
    },
    onPointerUp(event) {
      if (preserveAction) child.props.onPointerUp?.(event);
      else event.stopPropagation();
      const held = gesture.current;
      suppressClick.current = Boolean(
        held && (held.dragged || performance.now() - held.startedAt >= 350),
      );
      gesture.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
    },
    onPointerCancel(event) {
      child.props.onPointerCancel?.(event);
      gesture.current = null;
      suppressClick.current = true;
      close();
    },
    onPointerLeave(event) {
      child.props.onPointerLeave?.(event);
      if (event.pointerType === "mouse" && !gesture.current) close();
    },
    onFocus(event) {
      child.props.onFocus?.(event);
      if (!gesture.current) showFromKeyboard(event.currentTarget);
    },
    onBlur(event) {
      child.props.onBlur?.(event);
      if (anchorRef.current?.input === "keyboard") close();
    },
    onClick(event) {
      if (!preserveAction || suppressClick.current) {
        event.preventDefault();
        event.stopPropagation();
        suppressClick.current = false;
        return;
      }
      child.props.onClick?.(event);
    },
    onKeyDown(event) {
      if (event.key === "Escape" && anchorRef.current) {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        suppressClick.current = false;
        if (!preserveAction) {
          event.preventDefault();
          event.stopPropagation();
          if (anchorRef.current) close();
          else showFromKeyboard(event.currentTarget);
          return;
        }
      }
      child.props.onKeyDown?.(event);
    },
  });
  return (
    <>
      {trigger}
      {anchor && (
        <FloatingMetricCard
          id={id}
          anchor={anchor}
          title={title}
          rows={rows}
          note={note}
        />
      )}
    </>
  );
}
