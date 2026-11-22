// Keeps what receives focus clear of what stays at the top of a scroll area.
// Browsers scroll a focused element into view, and `scrollIntoView` aligns an
// element, within the scroll area less its scroll padding. Each scroll area
// below holds the height of what covers its top in `--sticky-inset`, which the
// style sheet turns into its `scroll-padding-top`. The heights are measured,
// as the top bar wraps on narrow screens and notices join it.
//
// The root also holds `--fresh-link-inset`, the height of the fresh-link
// notice, which the top bar and the side panels start below, and
// `--topbar-bottom`, where the top bar ends, which the agent questions start below.
// When the notice and the top bar would take more than a third of the window,
// as in a short or zoomed window, `data-header-scrolls` on the root lets them
// scroll away with the page instead.

/** Scroll areas, the root standing for the window, and what covers their top. */
const areas: { scroller: string; covers: string }[] = [
  // The top bar sticks below the fresh-link notice; minimized agent questions sit below the bar.
  { scroller: ":root", covers: ".topbar-wrap, #fresh-link-notice, .agent-questions-show" },
  { scroller: ".side.notes .notes-list", covers: ".notes-switch" },
];

const resizes = new ResizeObserver(measure);
let observed: Element[] = [];

/** How far below the top of its scroll area a cover reaches while it covers it; one that scrolls away covers nothing. */
function coverBottom(cover: Element): number {
  const style = getComputedStyle(cover);
  if (style.position !== "sticky" && style.position !== "fixed") return 0;
  return (parseFloat(style.top) || 0) + cover.getBoundingClientRect().height;
}

function setLength(element: HTMLElement, property: string, length: number): void {
  const value = `${Math.ceil(length)}px`;
  if (element.style.getPropertyValue(property) !== value) element.style.setProperty(property, value);
}

/** The window's inset when last measured. */
let pageInset = 0;

function measure(): void {
  const root = document.documentElement;
  const height = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().height ?? 0;
  const notice = height("#fresh-link-notice"), header = notice + height(".topbar-wrap");
  const scrolls = root.hasAttribute("data-header-scrolls");
  root.toggleAttribute("data-header-scrolls", header > window.innerHeight / 3);
  setLength(root, "--fresh-link-inset", notice);
  setLength(root, "--topbar-bottom", header);
  // The covers' positions read below follow the attribute and lengths set above.
  for (const area of areas) {
    const scroller = document.querySelector(area.scroller);
    if (scroller instanceof HTMLElement) setLength(scroller, "--sticky-inset", Math.max(0, ...[...scroller.querySelectorAll(area.covers)].map(coverBottom)));
  }
  const grew = (parseFloat(root.style.getPropertyValue("--sticky-inset")) || 0) > pageInset;
  pageInset = parseFloat(root.style.getPropertyValue("--sticky-inset")) || 0;
  if (grew || scrolls !== root.hasAttribute("data-header-scrolls")) revealFocus();
}

/** Scrolls the focused element back into view when the header left it hidden: a review element under covers that
 * grew over it, such as an appearing notice, or a top bar control or the minimized agent questions above the
 * window once the header scrolls away. */
export function revealFocus(): void {
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement || focused instanceof SVGElement)) return;
  const box = focused.getBoundingClientRect();
  const hidden = focused.closest(".topbar-wrap, .agent-questions-show") ? box.bottom <= 0 : focused.closest(".shell") ? box.top < pageInset && box.bottom > 0 : false;
  if (hidden) focused.scrollIntoView({ block: "nearest" });
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
  // The share of the window the covers take changes with its height.
  window.addEventListener("resize", measure);
  updateStickyInsets();
}
