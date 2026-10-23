import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Scroll reveal (src/lib/scroll-reveal.ts) hides a top-level card that starts
 * below the fold and lets it rise once it is scrolled to: it is faded,
 * blurred, 20px lower and scaled to 98% until then, and keeps the
 * `data-reveal` attribute until the rise has finished. Read geometry, tap raw
 * coordinates or audit colours only after the card holding the element has
 * dropped the attribute. Nested cards rise with their outermost card.
 */
export async function waitForReveal(locator: Locator) {
  await expect
    .poll(
      () =>
        locator.evaluate((element) => {
          let card = element.closest("[data-feel-card]");
          for (let outer = card?.parentElement?.closest("[data-feel-card]"); outer; outer = outer.parentElement?.closest("[data-feel-card]")) card = outer;
          return card?.getAttribute("data-reveal") ?? null;
        }),
      { message: "the card holding this element is still rising into view" },
    )
    .toBeNull();
}

/** Scroll the element into view, then wait for its card to finish rising. */
export async function scrollIntoViewAndReveal(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await waitForReveal(locator);
  // Revealing a taller card can change the browser's scroll destination.
  // A hover sent during that final scroll correctly dismisses metric details.
  // Wait for the viewport and the target to settle, not just the reveal flag.
  await locator.scrollIntoViewIfNeeded();
  await locator.evaluate(element => new Promise<void>((resolve, reject) => {
    const ancestors: Element[] = [];
    for (let node: Element | null = element; node; node = node.parentElement) ancestors.push(node);
    const sample = () => {
      const box = element.getBoundingClientRect();
      return [box.x, box.y, box.width, box.height, ...ancestors.flatMap(node => [node.scrollLeft, node.scrollTop])];
    };
    let previous = sample();
    let stableFrames = 0;
    const started = performance.now();
    const frame = () => {
      const current = sample();
      stableFrames = current.every((value, index) => Math.abs(value - previous[index]) < 0.1) ? stableFrames + 1 : 0;
      previous = current;
      if (stableFrames >= 6) return resolve();
      if (performance.now() - started > 3000) return reject(new Error("The scrolled target did not settle"));
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }));
}

/** Wait for the finite CSS and Web Animations running on the element and its
 * descendants (an entering side sheet, for example) to finish. Looping
 * indicators never finish, so they are left alone. */
export async function finishAnimations(locator: Locator) {
  // A closing/reopening dialog may replace an animation after it is sampled.
  // Inspect current animations instead of retaining an old finished promise.
  // Paused and pending animations still fail this wait; nothing is forced to end.
  await expect.poll(() => locator.evaluate((element) =>
    element.getAnimations({ subtree: true })
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity
        && (animation.pending || !["finished", "idle"].includes(animation.playState)))
      .map((animation) => {
        const effect = animation.effect;
        const target = effect instanceof KeyframeEffect ? effect.target : null;
        return {
          name: animation instanceof CSSAnimation ? animation.animationName : animation.id || "Web Animation",
          target: target instanceof Element ? target.id || target.getAttribute("class") || target.tagName : null,
          state: animation.playState,
          pending: animation.pending,
          currentTime: animation.currentTime,
          playbackRate: animation.playbackRate,
          duration: effect?.getTiming().duration,
        };
      }),
  ), { message: "finite animations should finish before checking layout" }).toEqual([]);
}

/** Scroll through the whole page so every card that waits below the fold
 * rises in, return to the top and wait until none is still rising. */
export async function revealAll(page: Page) {
  await page.evaluate(async () => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    for (let top = 0; top < document.documentElement.scrollHeight; top += innerHeight * 0.8) {
      window.scrollTo({ top, behavior: "instant" });
      await frame();
    }
    window.scrollTo({ top: 0, behavior: "instant" });
  });
  await expect(page.locator("[data-reveal]")).toHaveCount(0);
}
