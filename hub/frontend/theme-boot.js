/* 在 CSS 前写入 data-theme，避免夜间模式首屏闪白。CSP 仅允许 'self'。 */
(function () {
  var theme = "light";
  try {
    var stored = localStorage.getItem("cm_theme");
    if (stored === "dark" || stored === "light") theme = stored;
  } catch (e) { /* private mode */ }
  document.documentElement.setAttribute("data-theme", theme);
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? "#0b1220" : "#f8fafd");
})();
