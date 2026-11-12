(() => {
  let preference = null;
  try { preference = localStorage.getItem("cm_theme") ?? localStorage.getItem("cm-preview-theme"); } catch {}
  const pinned = preference === "light" || preference === "dark";
  const dark = pinned ? preference === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  // The page's <meta> starts as "light dark", so the blank window already
  // follows the system while this file loads; a pinned choice names its one
  // scheme.
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", pinned ? preference : "light dark");
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#111111" : "#fafafa");
})();
