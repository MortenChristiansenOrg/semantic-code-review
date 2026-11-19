// Line threads inside the legacy diff panel. The diff markup leaves an empty
// island row for each shown line thread, and this renders the thread template
// into it, so line threads share the thread module with the rest of the page.
// This bridge goes away when the diff panel becomes a lit template.
import { nothing, render } from "lit-html";
import { LIT_ISLAND } from "./legacy-html";
import { lineThreadView, type ThreadListView } from "./thread";

const LINE = "data-line-thread";

/** The island row the diff markup leaves for a line's thread. `escape` makes
 * the line ID safe in an attribute. */
export function lineThreadIsland(lineId: string, escape: (value: string) => string): string {
  const id = escape(lineId);
  return `<div class="drow drow-thread" data-render-key="${id}" ${LINE}="${id}" ${LIT_ISLAND}></div>`;
}

/** Renders each island's line thread, or clears it when the thread is gone. */
export function renderLineThreads(root: ParentNode, view: (lineId: string) => ThreadListView | null): void {
  root.querySelectorAll<HTMLElement>(`[${LINE}]`).forEach((island) => {
    const thread = view(island.getAttribute(LINE)!);
    render(thread ? lineThreadView(thread) : nothing, island);
  });
}
