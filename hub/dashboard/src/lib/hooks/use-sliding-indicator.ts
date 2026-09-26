import { useLayoutEffect, useRef } from "react";

/**
 * Glides the container's `[data-sliding-indicator]` child to the active option
 * (transitions.dev 16, tabs sliding). JS measures the option's layout box, CSS
 * owns the tween. The first placement snaps, so the indicator never slides in
 * from the corner; until then the active option keeps its own highlight. The
 * container must be positioned: offsetLeft/offsetTop are read against it.
 */
export function useSlidingIndicator<T extends HTMLElement>(activeSelector: string) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const list = ref.current;
    const indicator = list?.querySelector<HTMLElement>(":scope > [data-sliding-indicator]");
    if (!list || !indicator) return;
    let placed = false;
    const place = () => {
      const active = list.querySelector<HTMLElement>(activeSelector);
      if (!active || active.offsetParent !== list || !active.offsetWidth) {
        delete list.dataset.indicator;
        placed = false;
        return;
      }
      const snap = !placed;
      if (snap) indicator.style.transition = "none";
      indicator.style.setProperty("--indicator-x", `${active.offsetLeft}px`);
      indicator.style.setProperty("--indicator-y", `${active.offsetTop}px`);
      indicator.style.setProperty("--indicator-w", `${active.offsetWidth}px`);
      indicator.style.setProperty("--indicator-h", `${active.offsetHeight}px`);
      if (snap) {
        void indicator.offsetWidth;
        indicator.style.transition = "";
      }
      placed = true;
      list.dataset.indicator = "ready";
    };
    place();
    const selection = new MutationObserver(place);
    selection.observe(list, {
      subtree: true,
      attributeFilter: ["data-state", "aria-pressed", "aria-current", "aria-selected"],
    });
    const size = new ResizeObserver(place);
    size.observe(list);
    for (const option of list.children) {
      if (option !== indicator) size.observe(option);
    }
    return () => {
      selection.disconnect();
      size.disconnect();
    };
  }, [activeSelector]);
  return ref;
}
