import { useEffect, useRef, useState } from "react";

type ThemePreference = "system" | "light" | "dark";
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
  const update = (preference: ThemePreference) => {
    const next = { preference, appearance: resolveTheme(preference) };
    current.current = next;
    applyTheme(next.appearance);
    setTheme(next);
  };
  const choose = (preference: ThemePreference) => {
    try { localStorage.setItem("cm_theme", preference); } catch { /* Keep the choice for this session. */ }
    update(preference);
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
      media.removeEventListener("change", changed);
      window.removeEventListener("storage", stored);
    };
  }, []);

  return {
    dark: theme.appearance === "dark",
    followsSystem: theme.preference === "system",
    followSystem: () => choose("system"),
    toggleTheme: () => choose(current.current.appearance === "dark" ? "light" : "dark"),
  };
}
