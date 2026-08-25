/* 在 CSS 前写入 data-theme，避免夜间模式首屏闪白。CSP 仅允许 'self'。
 * 优先级：用户显式选择（localStorage）→ 系统 prefers-color-scheme → 亮色。 */
(function () {
  var theme = null;
  try {
    var stored = localStorage.getItem("cm_theme");
    if (stored === "dark" || stored === "light") theme = stored;
  } catch (e) { /* private mode */ }
  if (!theme) {
    theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  document.documentElement.setAttribute("data-theme", theme);
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? "#0b1220" : "#f8fafd");
})();
