/** Scroll to the top; fall back when ScrollToOptions is ignored or throws. */
export function scrollToTop() {
  try {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  } catch {
    window.scrollTo(0, 0);
  }
}
