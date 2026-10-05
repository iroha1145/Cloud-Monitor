import { useCallback, useRef } from "react";

/**
 * Marks a horizontal scroller with `data-more-start` / `data-more-end` while
 * content lies past that edge, so CSS can fade only the edges that hide
 * something, and makes it a Tab stop only while there is something to scroll
 * (Safari does not focus scrollers on its own). Nothing changes when it fits.
 */
export function useScrollEdges<T extends HTMLElement>() {
  const cleanup = useRef<(() => void) | null>(null);
  return useCallback((element: T | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!element) return;
    const update = () => {
      const max = element.scrollWidth - element.clientWidth;
      element.toggleAttribute("data-more-start", max > 1 && element.scrollLeft > 1);
      element.toggleAttribute("data-more-end", max > 1 && element.scrollLeft < max - 1);
      if (max > 1) element.tabIndex = 0;
      else element.removeAttribute("tabindex");
    };
    update();
    element.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    cleanup.current = () => {
      element.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, []);
}
