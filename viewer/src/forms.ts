// The page's forms: editor text, note and reply drafts, and agent answers.
import type { DraftNote, NoteMode } from "../../scripts/src/shared/viewer-protocol";
import { agentAnswers, answerAgent, autoSendFeedback, sendingDrafts, setAutoSendPreferred } from "./agent";
import { uploadOps } from "./attachments";
import { compose, draftSnapshots, rememberDraftSnapshot, replyAttachments, saveReplyDraft, setCompose, setReplyDraft } from "./editor";
import { render } from "./render";
import { persist, state } from "./state";
import { isNoteMode } from "./stored-state";
import { noteAt } from "./threads";
import type { Note } from "./types";


// Keep unsent editor text in state for persistence and live updates.

/** Keeps editor text in state and saves submitted notes, replies and answers. */
export function installForms(): void {
  document.addEventListener("input", (e) => {
    const t = e.target;
    // Every field below is a textarea.
    if (!(t instanceof HTMLTextAreaElement)) return;
    if (compose && t.matches('.note-compose textarea[name="nc-body"]')) {
      compose.body = t.value;
      compose.dirty = true;
      persist(true);
    } else if (t.matches('.tthread-reply textarea[name="reply-body"]')) {
      setReplyDraft(t.value);
      persist(true);
    } else if (t.matches(".agent-answer textarea")) {
      const answer = t.closest("[data-agent-answer]");
      if (answer instanceof HTMLElement && answer.dataset.id !== undefined) agentAnswers.set(answer.dataset.id, t.value);
    }
  });
  document.addEventListener("change", (e) => {
    const t = e.target;
    // Both fields below are inputs.
    if (!(t instanceof HTMLInputElement)) return;
    if (t.matches('.notes-auto-send input[name="auto-send"]')) {
      setAutoSendPreferred(t.checked);
      render();
      return;
    }
    if (compose && t.matches('.note-compose input[name="nc-mode"]') && t.checked && isNoteMode(t.value)) {
      compose.mode = t.value;
      compose.dirty = true;
      persist(); render();
    }
  });
  document.addEventListener("submit", (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    const field = form.querySelector("textarea");
    if (form.matches("[data-note-form]")) {
      e.preventDefault();
      if (!field) return;
      const body = field.value.trim();
      const checked = form.querySelector('input[name="nc-mode"]:checked');
      const chosen = checked instanceof HTMLInputElement ? checked.value : "";
      const mode: NoteMode = isNoteMode(chosen) ? chosen : "personal";
      if (uploadOps.size || !compose || (!body && !compose.attachments?.length)) return;
      let saved: Note | null = null;
      if (compose) {
        if (compose.editIndex != null) {
          const c = noteAt(compose.editIndex);
          if (c && !c.exported && !sendingDrafts.has(c)) { c.body = body; c.mode = mode; c.attachments = structuredClone(compose.attachments || []); saved = c; }
        } else {
          const note: DraftNote = { kind: compose.kind, id: compose.id, body, mode, attachments: structuredClone(compose.attachments || []), createdAt: Date.now() };
          if (compose.stageId) note.stageId = compose.stageId;
          if (compose.nodeId) note.nodeId = compose.nodeId;
          const snapshot = draftSnapshots.get(compose);
          if (snapshot) draftSnapshots.set(note, snapshot); else rememberDraftSnapshot(note);
          state.comments.push(note);
          saved = note;
        }
        state.lastNoteMode = mode;
      }
      setCompose(null);
      persist();
      render();
      if (saved && mode === "feedback") autoSendFeedback({ note: saved });
      return;
    }
    const id = form.dataset.id;
    if (form.matches("[data-agent-answer]")) {
      e.preventDefault();
      if (field && id !== undefined) void answerAgent(id, field.value);
      return;
    }
    if (form.matches("[data-reply-form]")) {
      e.preventDefault();
      if (!field || id === undefined) return;
      const body = field.value.trim();
      if (!uploadOps.size && (body || replyAttachments.length)) saveReplyDraft(id, body);
      return;
    }
  });
}
