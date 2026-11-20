// The page's tooltips and reasoning popovers, shown in one floating element.
import { tagPopoverView, tooltipView } from "./views/tooltip";
import { render as renderLit } from "lit-html";


/* ---- reasoning popover (portal, escapes clipped containers) ----------- */
export let popEl: HTMLDivElement | null = null, popSticky = false, popOwner: HTMLElement | null = null, popTimer: number | undefined = undefined;
// Templates render hints as data-tooltip, and as data-tooltip-clipped where
// the hint only names a label in full while the layout cuts it off.
export const TOOLTIP_TARGET = ".tag-face[data-tagpop], [data-tooltip], [data-tooltip-clipped]";
/** The plain hint an element shows now; empty when it has none. */
export function tooltipText(el: HTMLElement): string {
  const { tooltip = "", tooltipClipped } = el.dataset;
  if (!tooltipClipped) return tooltip;
  const labels = [...(el.matches("[data-clippable]") ? [el] : []), ...el.querySelectorAll("[data-clippable]")];
  return labels.some((label) => label.scrollWidth > label.clientWidth) ? tooltipClipped : tooltip;
}
/** The nearest element at `target` with a popover or a hint to show now. */
export function tooltipTarget(target: EventTarget | null): HTMLElement | null {
  for (let el = target instanceof Element ? target.closest(TOOLTIP_TARGET) : null; el; el = el.parentElement?.closest(TOOLTIP_TARGET) ?? null)
    if (el instanceof HTMLElement && (el.matches(".tag-face[data-tagpop]") || tooltipText(el))) return el;
  return null;
}
/** The element whose tooltip leaving `target` closes: the open tooltip's
 * owner, even once it has no hint to show, or else the target's own. */
export function leftTooltipTarget(target: EventTarget | null): HTMLElement | null {
  return target instanceof Node && popOwner?.contains(target) ? popOwner : tooltipTarget(target);
}
export function clearPopDescription(): void {
  if (!popOwner) return;
  const ids = (popOwner.getAttribute("aria-describedby") || "").split(/\s+/).filter((id) => id && id !== "review-tooltip");
  if (ids.length) popOwner.setAttribute("aria-describedby", ids.join(" "));
  else popOwner.removeAttribute("aria-describedby");
}
export function ensurePop(): HTMLDivElement {
  if (popEl) return popEl;
  const pop = document.createElement("div");
  popEl = pop;
  pop.className = "tag-pop-float";
  pop.id = "review-tooltip";
  pop.setAttribute("role", "tooltip");
  // Chromium would make it a tab stop while it scrolls; its keys come from
  // the element it describes instead (see scrollPopFromKey).
  pop.tabIndex = -1;
  document.body.appendChild(pop);
  pop.addEventListener("pointerenter", () => clearTimeout(popTimer));
  pop.addEventListener("pointerleave", () => { if (!popSticky) scheduleHide(); });
  return pop;
}
export function fillPop(btn: HTMLElement): void {
  const d = btn.dataset;
  const el = ensurePop();
  const text = tooltipText(btn);
  if (text) {
    el.className = "tag-pop-float is-tooltip";
    renderLit(tooltipView(text), el);
    return;
  }
  const kindLine = `${d.glyph} ${d.label}${d.meta ? ` · ${d.meta}` : ""}${d.review ? ` · ${d.review}` : ""}`;
  el.className = `tag-pop-float type-${d.type}${d.vstat ? ` vstat-${d.vstat}` : ""}`;
  renderLit(tagPopoverView({ kind: kindLine, title: d.title ?? "", body: d.body || "" }), el);
}
export function positionPop(btn: Element): void {
  if (!popEl) return;
  const r = btn.getBoundingClientRect();
  const p = popEl.getBoundingClientRect();
  const margin = 12, gap = 9;
  let left = Math.max(margin, Math.min(r.left, window.innerWidth - p.width - margin));
  let top = r.bottom + gap;
  if (top + p.height > window.innerHeight - margin && r.top - gap - p.height > margin) {
    top = r.top - gap - p.height; popEl.classList.add("is-above");
  } else {
    popEl.classList.remove("is-above");
    // A popover too tall for either side stays on screen and scrolls.
    top = Math.max(margin, Math.min(top, window.innerHeight - p.height - margin));
  }
  popEl.style.left = `${left}px`;
  popEl.style.top = `${top}px`;
}
export function showPop(btn: HTMLElement): void {
  clearTimeout(popTimer);
  if (popOwner === btn && popEl?.classList.contains("is-shown")) return;
  clearPopDescription();
  popOwner = btn;
  const ids = new Set((btn.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
  ids.add("review-tooltip");
  btn.setAttribute("aria-describedby", [...ids].join(" "));
  fillPop(btn);
  const pop = ensurePop();
  pop.scrollTop = 0;
  pop.style.visibility = "hidden";
  pop.classList.add("is-shown");
  requestAnimationFrame(() => {
    if (popOwner !== btn) return;
    positionPop(btn);
    markKeyScrollable();
    pop.style.visibility = "";
  });
}
export function scheduleHide(): void { clearTimeout(popTimer); popTimer = setTimeout(hidePop, 130); }
export function hidePop(): void {
  if (popSticky) return;
  if (popEl) popEl.classList.remove("is-shown", "is-above");
  clearPopDescription();
  popOwner = null;
}
export function forceHidePop(): void {
  popSticky = false;
  if (popEl) popEl.classList.remove("is-shown", "is-above");
  clearPopDescription();
  popOwner = null;
}

/** Whether the open tooltip or popover is cut off and scrolls. */
function popOverflows(): boolean {
  return Boolean(popEl?.classList.contains("is-shown") && popEl.scrollHeight > popEl.clientHeight);
}
/** Shows the scrolling keys on a cut-off tooltip while focus is on what it describes. */
export function markKeyScrollable(): void {
  if (!popEl) return;
  popEl.classList.remove("is-key-scrollable");
  const focused = document.activeElement;
  if (popOwner && focused && popOwner.contains(focused) && popOverflows()) popEl.classList.add("is-key-scrollable");
}
const POP_SCROLL_KEYS = new Set(["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End"]);
/**
 * Scrolls a cut-off tooltip or popover from the keyboard while focus stays on
 * the element it describes, so it keeps no tab stop of its own. Escape closes
 * it and gives these keys back to the page.
 */
export function scrollPopFromKey(e: KeyboardEvent): void {
  if (!POP_SCROLL_KEYS.has(e.key) || e.defaultPrevented || e.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const target = e.target;
  if (!popEl || !popOwner || !(target instanceof Element) || !popOwner.contains(target) || !popOverflows()) return;
  // Fields and widgets keep their own use of these keys.
  if ((target instanceof HTMLElement && target.isContentEditable) ||
      target.closest('input, textarea, select, [role="textbox"], [role="combobox"], [role="listbox"], [role="slider"]')) return;
  e.preventDefault();
  const line = 40, page = Math.max(line, popEl.clientHeight - line);
  if (e.key === "Home") popEl.scrollTop = 0;
  else if (e.key === "End") popEl.scrollTop = popEl.scrollHeight;
  else popEl.scrollTop += (e.key === "ArrowDown" ? line : e.key === "ArrowUp" ? -line : e.key === "PageDown" ? page : -page);
}

/** Opens the tooltip or popover for what the pointer or focus is on. */
export function installPopover(): void {
  document.addEventListener("keydown", scrollPopFromKey);
  document.addEventListener("pointerover", (e) => {
    const b = tooltipTarget(e.target);
    if (!b) return;
    if (popSticky && popOwner !== b) return;
    showPop(b);
  });
  document.addEventListener("pointerout", (e) => {
    const b = leftTooltipTarget(e.target);
    if (b && !(e.relatedTarget instanceof Node && b.contains(e.relatedTarget)) && !popSticky) scheduleHide();
  });
  document.addEventListener("focusin", (e) => {
    const b = tooltipTarget(e.target);
    if (b) showPop(b);
    markKeyScrollable();
  });
  document.addEventListener("focusout", (e) => {
    const b = leftTooltipTarget(e.target);
    if (b && !popSticky) scheduleHide();
    markKeyScrollable();
  });
  document.addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest(".tag-face[data-tagpop]") : null;
    if (b instanceof HTMLElement) {
      e.preventDefault();
      if (popSticky && popOwner === b) { popSticky = false; hidePop(); }
      else { popSticky = true; showPop(b); }
      return;
    }
    if (popSticky && !(e.target instanceof Element && e.target.closest(".tag-pop-float"))) forceHidePop();
  });
  window.addEventListener("scroll", () => {
    if (!popEl || !popEl.classList.contains("is-shown")) return;
    if (popOwner && popOwner.isConnected) positionPop(popOwner); else forceHidePop();
  }, true);
  // A resize can uncover or cut off a label, which changes or ends its hint.
  window.addEventListener("resize", () => {
    if (!popOwner?.isConnected) return;
    if (!popOwner.matches(".tag-face[data-tagpop]")) {
      if (!tooltipText(popOwner)) { forceHidePop(); return; }
      // Filling resets the tooltip's classes, so it is shown again.
      fillPop(popOwner);
      popEl?.classList.add("is-shown");
    }
    positionPop(popOwner);
    markKeyScrollable();
  });
}
