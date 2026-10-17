import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

export type ThemePreference = "system" | "light" | "dark";
type Appearance = "light" | "dark";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem("cm_theme") ?? localStorage.getItem("cm-preview-theme");
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function resolveTheme(preference: ThemePreference): Appearance {
  return preference === "system"
    ? window.matchMedia(MEDIA_QUERY).matches ? "dark" : "light"
    : preference;
}

function applyTheme(appearance: Appearance) {
  const root = document.documentElement;
  root.classList.toggle("dark", appearance === "dark");
  root.dataset.theme = appearance;
  root.style.colorScheme = appearance;
  const page = getComputedStyle(root).getPropertyValue("--page").trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    "content", page || (appearance === "dark" ? "#111111" : "#fafafa"),
  );
}

export function useTheme() {
  const [theme, setTheme] = useState(() => {
    const preference = readPreference();
    return { preference, appearance: resolveTheme(preference) };
  });
  // Activations in the same render frame must each see the preceding choice.
  const current = useRef(theme);
  const transition = useRef<ViewTransition | null>(null);
  const revision = useRef(0);
  const update = (preference: ThemePreference, origin?: HTMLElement | null) => {
    const next = { preference, appearance: resolveTheme(preference) };
    const changed = next.appearance !== current.current.appearance;
    current.current = next;
    const id = ++revision.current;
    transition.current?.skipTransition();
    transition.current = null;
    const root = document.documentElement;
    const settle = () => {
      if (id !== revision.current) return;
      delete root.dataset.themeSwitching;
      transition.current = null;
    };
    const apply = () => {
      if (id !== revision.current) return;
      applyTheme(next.appearance);
      setTheme(next);
    };
    if (!changed || !origin || !document.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      settle();
      apply();
      return;
    }
    const box = origin.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    root.style.setProperty("--theme-x", `${x}px`);
    root.style.setProperty("--theme-y", `${y}px`);
    root.style.setProperty("--theme-r", `${Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))}px`);
    root.dataset.themeSwitching = "";
    try {
      const wipe = document.startViewTransition(() => flushSync(apply));
      transition.current = wipe;
      wipe.ready.catch(() => {});
      wipe.finished.then(settle, settle);
    } catch {
      apply();
      settle();
    }
  };
  const choose = (preference: ThemePreference, origin: HTMLElement | null) => {
    try { localStorage.setItem("cm_theme", preference); } catch { /* Keep the choice for this session. */ }
    update(preference, origin);
  };

  useEffect(() => {
    const media = window.matchMedia(MEDIA_QUERY);
    const changed = () => {
      if (current.current.preference === "system") update("system");
    };
    const stored = (event: StorageEvent) => {
      if (event.key === null || event.key === "cm_theme" || event.key === "cm-preview-theme")
        update(readPreference());
    };
    // Recheck after loading: the browser preference can change before React mounts.
    update(current.current.preference);
    media.addEventListener("change", changed);
    window.addEventListener("storage", stored);
    return () => {
      revision.current += 1;
      transition.current?.skipTransition();
      delete document.documentElement.dataset.themeSwitching;
      media.removeEventListener("change", changed);
      window.removeEventListener("storage", stored);
    };
  }, []);

  return {
    dark: theme.appearance === "dark",
    preference: theme.preference,
    chooseTheme: choose,
  };
}
