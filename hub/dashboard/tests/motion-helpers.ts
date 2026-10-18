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
}

/** Wait for the finite CSS and Web Animations running on the element and its
 * descendants (an entering side sheet, for example) to finish. Looping
 * indicators never finish, so they are left alone. */
export async function finishAnimations(locator: Locator) {
  await locator.evaluate((element) =>
    Promise.all(
      element
        .getAnimations({ subtree: true })
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
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
