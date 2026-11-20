// What each render carries across: focus and the scroll of open files.
import { app } from "./context";
import { activeFileNodeId, fileById } from "./lookups";
import { cinemaHolder, fileRowElement } from "./navigation";
import { state } from "./state";
import { cssEsc } from "./util";

/* ---- what rendering cannot keep ---------------------------------------
   lit keeps every element a keyed template still renders, and with it the
   element's draft text, caret and selection, the open state of a disclosure
   and the page's scroll position. Two things are lost even so, and so are
   carried across each render here:
   - Focus. Moving an element, as a keyed list does when it reorders, blurs
     it although it survives; a control rendered anew, as a draft's editor is
     when it moves between its inline thread and the notes panel, starts
     unfocused. The browser tests for agent answers, Markdown previews, moved
     file buttons and drafts in the notes panel fail without it.
   - The scroll of an open file's diff or Markdown preview, which moving or
     recreating the element around it, as keyed lists do when stages, steps
     or groups change, resets. The browser test for a Markdown preview whose
     group is renamed fails without it. */
/** The caret of a text field: start, end and direction. */
type Caret = [number, number, "forward" | "backward" | "none" | undefined];
/** The focus before a render, and how to find its replacement. */
export interface FocusCapture {
  focused: Element | null;
  selector: string | null;
  caret: Caret | null;
}
/** A text field, which has a caret. */
const textField = (element: Element | null | undefined): HTMLInputElement | HTMLTextAreaElement | null =>
  element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element : null;

export function captureFocus(): FocusCapture {
  const focused = document.activeElement;
  const stage = focused?.closest(".stage");
  const node = focused?.parentElement;
  // A control replaced by the render passes focus to the one that matches
  // all it is identified by: its data attributes other than tooltips, and
  // its name and value. A control for something else, such as another
  // draft's Delete, never matches, so focus then stays where it fell.
  const selector = focused?.matches?.("[data-action], textarea[name], input[name]")
    ? [...focused.attributes].filter(({ name }) => name === "name" || name === "value" || name.startsWith("data-") && !name.startsWith("data-tooltip"))
      .map(({ name, value }) => `[${name}="${cssEsc(value)}"]`).join("")
    : focused?.tagName === "SUMMARY" && focused.parentElement?.matches("details.node")
      ? `.stage[data-stage="${cssEsc(String(stage instanceof HTMLElement ? stage.dataset.stage : undefined))}"] details.node[data-node="${cssEsc(String(node?.dataset.node))}"] > summary`
      : null;
  // A moved element keeps its caret; a replacement takes the old one's.
  const field = textField(focused);
  const caret: Caret | null = field && typeof field.selectionStart === "number"
    ? [field.selectionStart, field.selectionEnd ?? field.selectionStart, field.selectionDirection ?? undefined] : null;
  return { focused, selector, caret };
}
export function restoreFocus({ focused, selector, caret }: FocusCapture): void {
  if (document.activeElement && document.activeElement !== document.body) return;
  if (focused?.isConnected && focused !== document.body && (focused instanceof HTMLElement || focused instanceof SVGElement)) {
    focused.focus({ preventScroll: true });
  } else if (!focused?.isConnected && selector) {
    // A closed panel stays in the page, inert; only a usable control takes focus.
    const replacement = [...app.querySelectorAll(selector)].find((el) => !el.closest("[inert]"));
    if (replacement instanceof HTMLElement || replacement instanceof SVGElement) {
      replacement.focus({ preventScroll: true });
      const field = textField(replacement);
      if (caret && field) field.setSelectionRange(...caret);
    }
  }
}
// The scrolling parts of an open file's diff. Only a visible scroller reports
// its position, and only the same scroller, still visible, gets it back.
export const fileScrollers: string[] = [".diff-scroll", ".markdown-preview"];
/** Saved scroll positions, keyed by file ID and scroller selector. */
type FileScrolls = Map<string, { top: number; left: number }>;
export function captureFileScrolls(): FileScrolls {
  const scrolls: FileScrolls = new Map();
  Object.keys(state.activeFiles).forEach((fid) => {
    if (!activeFileNodeId(fid)) return;
    const holder = fileRowElement(fid)?.nextElementSibling;
    if (!holder?.classList.contains("cinema-diff")) return;
    for (const selector of fileScrollers) {
      const scroller = holder.querySelector(selector);
      if (scroller?.getClientRects().length) scrolls.set(`${fid}\0${selector}`, { top: scroller.scrollTop, left: scroller.scrollLeft });
    }
  });
  return scrolls;
}
export function restoreFileScrolls(scrolls: FileScrolls): void {
  if (!scrolls.size) return;
  Object.keys(state.activeFiles).forEach((fid) => {
    if (!activeFileNodeId(fid) || !fileById.has(fid)) return;
    const holder = cinemaHolder(fid);
    for (const selector of fileScrollers) {
      const saved = scrolls.get(`${fid}\0${selector}`);
      const scroller = saved && holder?.querySelector(selector);
      if (saved && scroller?.getClientRects().length) { scroller.scrollTop = saved.top; scroller.scrollLeft = saved.left; }
    }
  });
}
