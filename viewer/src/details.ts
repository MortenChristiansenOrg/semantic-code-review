// Animated <details> and the saved open state of specifications.
import { app } from "./context";
import { persist, state } from "./state";
import { reduced } from "./util";

/* ---- animated <details> ---------------------------------------------- */

export const animatedSummaries = new WeakSet<Element>();
// A specification also opens and closes natively (reduced motion skips the
// animation), so its saved state follows every toggle.
export function animateDetails(): void {
  app.querySelectorAll("details > summary").forEach((summary) => {
    if (animatedSummaries.has(summary)) return;
    animatedSummaries.add(summary);
    summary.addEventListener("click", (e) => {
      if (!(e.target instanceof Element) || e.target.closest("button:not(.stage-title), a, [data-action]") || reduced()) return;
      e.preventDefault();
      const det = summary.parentElement;
      if (!(det instanceof HTMLDetailsElement) || det.dataset.animating) return;
      det.dataset.animating = "1";
      const start = det.getBoundingClientRect().height;
      const closing = det.open;
      if (!det.open) det.open = true;
      const end = closing ? summary.getBoundingClientRect().height : det.scrollHeight;
      det.style.overflow = "clip";
      const anim = det.animate([{ height: `${start}px` }, { height: `${end}px` }],
        { duration: closing ? 200 : 260, easing: "cubic-bezier(.22,.7,.2,1)" });
      anim.finished.catch(() => {}).then(() => {
        if (closing) det.open = false;
        det.style.removeProperty("height");
        det.style.removeProperty("overflow");
        delete det.dataset.animating;
        syncReqState(det);
      });
    });
  });
}
export function syncReqState(det: HTMLDetailsElement): void {
  if (det.matches(".specification") && setSpecificationOpen(det.dataset.reqId, det.open)) persist();
}
// Specification IDs come from the artifact, so only own keys count.
export function specificationIsOpen(id: string): boolean {
  const open = state.specificationOpen;
  return Boolean(open && typeof open === "object" && Object.hasOwn(open, id) && open[id]);
}
/** Records whether a specification is open; returns whether that changed. */
export function setSpecificationOpen(id: unknown, open: boolean): boolean {
  if (typeof id !== "string") return false;
  if (specificationIsOpen(id) === open) return false;
  const stored = state.specificationOpen;
  const specifications: Record<string, boolean> = stored && typeof stored === "object" ? stored : Object.create(null);
  state.specificationOpen = specifications;
  specifications[id] = open;
  return true;
}

/** Saves a specification's open state whenever it toggles. */
export function installDetails(): void {
  app.addEventListener("toggle", (e) => {
    if (e.target instanceof HTMLDetailsElement && e.target.matches(".specification")) syncReqState(e.target);
  }, true);
}
