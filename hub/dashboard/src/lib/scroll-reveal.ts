/*
 * Scroll reveal, ported from game-manage's v-reveal (frontend/src/motion.js).
 * Cards are visible by default. Only a card that starts below the fold of a
 * live page waits, hidden, until it is scrolled to, then rises in; cards that
 * arrive together rise one after another. Anything already on screen, any
 * card under reduced motion and any browser without IntersectionObserver
 * shows at once, so no content depends on an observer that may never fire.
 */
const CARD = '[data-feel-card]';
const SETTLE_MS = 700;

export function installScrollReveal(root: HTMLElement, selector = CARD) {
  const view = root.ownerDocument.defaultView;
  if (!view || typeof view.IntersectionObserver !== 'function') return () => {};
  const reduced = view.matchMedia('(prefers-reduced-motion: reduce)');
  const timers = new Map<HTMLElement, number>();
  const settle = (el: HTMLElement) => {
    view.clearTimeout(timers.get(el));
    timers.delete(el);
    delete el.dataset.reveal;
    el.style.removeProperty('--reveal-delay');
  };
  const observer = new view.IntersectionObserver(entries => {
    let order = 0;
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target as HTMLElement;
      observer.unobserve(el);
      const delay = Math.min(order++, 6) * 60;
      el.style.setProperty('--reveal-delay', `${delay}ms`);
      el.dataset.reveal = 'shown';
      // Afterwards the card's own hover and press transitions take over again.
      timers.set(el, view.setTimeout(() => settle(el), SETTLE_MS + delay));
    }
  }, { rootMargin: '0px 0px -10% 0px' });
  const consider = (el: HTMLElement) => {
    if (el.dataset.reveal || el.parentElement?.closest(selector) || el.closest('[role="dialog"]')) return;
    const box = el.getBoundingClientRect();
    if (!box.height || box.top < view.innerHeight * 0.9 || box.right <= 0 || box.left >= view.innerWidth) return;
    el.dataset.reveal = 'pending';
    observer.observe(el);
  };
  const scan = (node: Node) => {
    if (reduced.matches || !(node instanceof HTMLElement)) return;
    if (node.matches(selector)) consider(node);
    else node.querySelectorAll<HTMLElement>(selector).forEach(consider);
  };
  // Turning reduced motion on shows everything that is still waiting.
  const showAll = () => {
    if (!reduced.matches) return;
    root.querySelectorAll<HTMLElement>('[data-reveal]').forEach(el => { observer.unobserve(el); settle(el); });
  };
  reduced.addEventListener('change', showAll);
  // The observer ignores the bottom tenth of the window, which the last rows
  // of a page never leave: at the end of the page, show what is on screen.
  const atEnd = () => {
    const page = root.ownerDocument.documentElement;
    if (view.scrollY + view.innerHeight < page.scrollHeight - 4) return;
    root.querySelectorAll<HTMLElement>('[data-reveal="pending"]').forEach(el => {
      if (el.getBoundingClientRect().top < view.innerHeight) { observer.unobserve(el); el.dataset.reveal = 'shown'; timers.set(el, view.setTimeout(() => settle(el), SETTLE_MS)); }
    });
  };
  const mutations = new view.MutationObserver(records => {
    for (const record of records) record.addedNodes.forEach(scan);
    atEnd();
  });
  mutations.observe(root, { childList: true, subtree: true });
  view.addEventListener('scroll', atEnd, { passive: true });
  view.addEventListener('resize', atEnd);
  scan(root);
  atEnd();
  return () => {
    mutations.disconnect();
    observer.disconnect();
    reduced.removeEventListener('change', showAll);
    view.removeEventListener('scroll', atEnd);
    view.removeEventListener('resize', atEnd);
    root.querySelectorAll<HTMLElement>('[data-reveal]').forEach(settle);
    for (const el of [...timers.keys()]) settle(el);
  };
}
