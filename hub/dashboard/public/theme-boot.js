(() => {
  let preference = null;
  try { preference = localStorage.getItem("cm_theme") || localStorage.getItem("cm-preview-theme"); } catch {}
  const dark = preference === "dark" || (preference !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#191b20" : "#fafafb");
})();
