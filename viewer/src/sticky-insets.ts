// Keeps what receives focus clear of what stays at the top of a scroll area.
// Browsers scroll a focused element into view, and `scrollIntoView` aligns an
// element, within the scroll area less its scroll padding. Each scroll area
// below holds the height of what covers its top in `--sticky-inset`, which the
// style sheet turns into its `scroll-padding-top`. The heights are measured,
// as the top bar wraps on narrow screens and notices join it.

/** Scroll areas, the root standing for the window, and what covers their top. */
const areas: { scroller: string; covers: string }[] = [
  // The fresh-link notice sticks over the top bar; minimized agent questions sit just below it.
  { scroller: ":root", covers: ".topbar-wrap, #fresh-link-notice, .agent-questions-show" },
  { scroller: ".side.notes .notes-list", covers: ".notes-switch" },
];

const resizes = new ResizeObserver(measure);
let observed: Element[] = [];

/** How far below the top of its scroll area a cover reaches while it covers it. */
function coverBottom(cover: Element): number {
  return (parseFloat(getComputedStyle(cover).top) || 0) + cover.getBoundingClientRect().height;
}

function measure(): void {
  for (const area of areas) {
    const scroller = document.querySelector(area.scroller);
    if (!(scroller instanceof HTMLElement)) continue;
    const inset = Math.ceil(Math.max(0, ...[...scroller.querySelectorAll(area.covers)].map(coverBottom)));
    const value = `${inset}px`;
    if (scroller.style.getPropertyValue("--sticky-inset") !== value) scroller.style.setProperty("--sticky-inset", value);
  }
}

/** Follows the size of the covers now shown, and measures again when they changed. */
export function updateStickyInsets(): void {
  const covers = areas.flatMap((area) => [...document.querySelectorAll(`${area.scroller} :is(${area.covers})`)]);
  if (covers.length === observed.length && covers.every((cover, index) => cover === observed[index])) return;
  resizes.disconnect();
  covers.forEach((cover) => resizes.observe(cover));
  observed = covers;
  measure();
}

/** Follows covers that appear outside a render, such as the fresh-link notice. */
export function installStickyInsets(): void {
  new MutationObserver(updateStickyInsets).observe(document.body, { childList: true });
  updateStickyInsets();
}
