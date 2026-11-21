// The page's keyboard shortcuts.
import { clearFileDropTarget } from "./attachments";
import { closeReply, compose, replyTo, setCompose } from "./editor";
import { toggleThreadCollapse } from "./feedback-actions";
import { openFileSearch } from "./file-search-dialog";
import { closeCinema, toggleCinema } from "./navigation";
import { dismissPop, popOwner } from "./popover";
import { render } from "./render";
import { persist, reviewDeleted, state } from "./state";


/** Handles the page's keyboard shortcuts. */
export function installKeyboard(): void {
  document.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() === "t" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey &&
        !e.defaultPrevented && !e.isComposing && !e.repeat && !reviewDeleted &&
        !document.querySelector("dialog[open]") && e.target instanceof Element &&
        !(e.target instanceof HTMLElement && e.target.isContentEditable) && !e.target.closest('input, textarea, select, [role="textbox"], [role="combobox"]')) {
      e.preventDefault();
      openFileSearch();
      return;
    }
    if (e.key === "Enter" && e.ctrlKey && !e.isComposing && !e.repeat && e.target instanceof HTMLTextAreaElement && e.target.matches('textarea[name="nc-body"], textarea[name="reply-body"]')) {
      e.preventDefault();
      e.target.form?.requestSubmit();
      return;
    }
    if (e.key === "Escape") clearFileDropTarget();
    // Let the topmost native dialog handle Escape without touching a background draft.
    if (e.key === "Escape" && document.querySelector("dialog[open]")) return;
    if (e.key === "Escape" && popOwner) { dismissPop(); return; }
    if ((e.key === "Enter" || e.key === " ") && e.target instanceof HTMLElement && e.target.matches('[data-action="open-file"]')) {
      e.preventDefault(); toggleCinema(e.target.dataset.id, e.target.dataset.nodeId); return;
    }
    if ((e.key === "Enter" || e.key === " ") && e.target instanceof Element) {
      const h = e.target.closest('[data-action="toggle-thread-collapse"]');
      if (h instanceof HTMLElement && h.dataset.id !== undefined && !e.target.closest("button, a")) { e.preventDefault(); toggleThreadCollapse(h.dataset.id, h); return; }
    }
    if (e.key === "Escape") {
      if (compose) { setCompose(null); persist(); render(); return; }
      if (replyTo) { closeReply(); persist(); render(); return; }
      if (state.coverageOpen || state.notesOpen) { state.coverageOpen = false; state.notesOpen = false; persist(); render(); return; }
      if (Object.keys(state.activeFiles).length) { closeCinema(); return; }
    }
  });
}
