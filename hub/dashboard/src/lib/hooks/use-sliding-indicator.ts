import { useLayoutEffect, useRef } from "react";

/**
 * Glides the container's `[data-sliding-indicator]` child to the active option
 * (transitions.dev 16, tabs sliding). JS measures the option's layout box, CSS
 * owns the tween. Only a selection change glides; the first placement and size
 * changes snap, so the indicator never slides in from the corner or trails a
 * resize. Until placed, the active option keeps its own highlight. The
 * container must be positioned: offsetLeft/offsetTop are read against it.
 */
export function useSlidingIndicator<T extends HTMLElement>(activeSelector: string) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const list = ref.current;
    const indicator = list?.querySelector<HTMLElement>(":scope > [data-sliding-indicator]");
    if (!list || !indicator) return;
    let placed = "";
    const place = (glide: boolean) => {
      const active = list.querySelector<HTMLElement>(activeSelector);
      if (!active || active.offsetParent !== list || !active.offsetWidth) {
        delete list.dataset.indicator;
        placed = "";
        return;
      }
      const box = [active.offsetLeft, active.offsetTop, active.offsetWidth, active.offsetHeight];
      // A resize that follows a selection (bolder label) must not cut its glide.
      if (box.join() === placed) return;
      const snap = !glide || !placed;
      if (snap) indicator.style.transition = "none";
      indicator.style.setProperty("--indicator-x", `${box[0]}px`);
      indicator.style.setProperty("--indicator-y", `${box[1]}px`);
      indicator.style.setProperty("--indicator-w", `${box[2]}px`);
      indicator.style.setProperty("--indicator-h", `${box[3]}px`);
      if (snap) {
        void indicator.offsetWidth;
        indicator.style.transition = "";
      }
      placed = box.join();
      list.dataset.indicator = "ready";
    };
    place(false);
    const selection = new MutationObserver(() => place(true));
    selection.observe(list, {
      subtree: true,
      attributeFilter: ["data-state", "aria-pressed", "aria-current", "aria-selected"],
    });
    const size = new ResizeObserver(() => place(false));
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
