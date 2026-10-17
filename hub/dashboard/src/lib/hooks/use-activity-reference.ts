import { useEffect, useState } from "react";

/** Short-lived activity/cache observations expire even when a server refresh fails. */
export function useActivityReference(generatedAt: string): string {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const update = () => setClock(Date.now());
    const timer = window.setInterval(update, 30_000);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("pageshow", update);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("pageshow", update);
    };
  }, []);
  const snapshot = Date.parse(generatedAt);
  return new Date(Math.max(clock, Number.isFinite(snapshot) ? snapshot : 0)).toISOString();
}
