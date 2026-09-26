import { useEffect, useRef } from "react";

/**
 * Replays the error shake (transitions.dev 12) on a field each time a new
 * error message arrives. The motion lives in motion.css (`.is-shaking`).
 */
export function useErrorShake<T extends HTMLElement>(error: string) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const field = ref.current;
    if (!error || !field) return;
    field.classList.remove("is-shaking");
    void field.offsetWidth;
    field.classList.add("is-shaking");
    const settle = () => field.classList.remove("is-shaking");
    field.addEventListener("animationend", settle, { once: true });
    return () => field.removeEventListener("animationend", settle);
  }, [error]);
  return ref;
}
