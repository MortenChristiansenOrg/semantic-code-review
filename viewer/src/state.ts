// The review state: what the reviewer has approved, opened and written, saved
// to the review server as changes to the state it last saved.
import type { ReviewStateChange, ReviewTarget, StoredReviewState } from "../../scripts/src/shared/viewer-protocol";
import * as api from "./api";
import { approvalOps } from "./approval-state";
import { uploadOps } from "./attachments";
import { captureEditor } from "./editor";
import { exportState } from "./feedback-actions";
import { errorMessage, failureOf, isRecord, type UnknownRecord } from "./narrow";
import { markReviewDeleted } from "./saved-reviews";
import { readState } from "./stored-state";
import type { ViewerState } from "./types";

export let reviewDeleted = false;
export let deletedElsewhere = false;

/** The review whose state the page saves, as the server last sent it. */
export interface SavedReview extends ReviewTarget {
  state: StoredReviewState;
}

export let savedReview: SavedReview;
export let persistedState: StoredReviewState;
export let savingState = false;
export let saveError = "";
export let saveTimer: number | undefined;
export let commentSaveNotBefore = 0;
export let saveOperation: Promise<void> | null = null;

/* ---- state ------------------------------------------------------------ */
export let state: ViewerState;

/** Starts the page's state from the saved review; `deleted` when it no longer exists. */
export function initState(saved: SavedReview, deleted: boolean): void {
  savedReview = saved;
  reviewDeleted = deleted;
  persistedState = structuredClone(savedReview.state);
  state = load();
}
/** Marks the review deleted, `external` when another tab or session deleted it. */
export function setReviewDeleted(external: boolean): void { reviewDeleted = true; deletedElsewhere = external; }
/** Stops saving once the review is gone. */
export function stopSaving(): void { clearTimeout(saveTimer); saveError = ""; showSaveStatus(); }

export function load(): ViewerState {
  return readState(savedReview.state);
}
/** The state as JSON, as the server stores it. */
function storedState(): StoredReviewState {
  const copy: unknown = JSON.parse(JSON.stringify(state));
  return isRecord(copy) ? copy : {};
}
export function stateChanges(before: UnknownRecord, after: UnknownRecord, prefix: string[] = []): ReviewStateChange[] {
  const changes: ReviewStateChange[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const had = Object.hasOwn(before, key), has = Object.hasOwn(after, key);
    const a = had ? before[key] : undefined, b = has ? after[key] : undefined;
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if ((a === undefined || isRecord(a)) && isRecord(b)) changes.push(...stateChanges(a || {}, b, [...prefix, key]));
    else changes.push({ path: [...prefix, key], before: had ? { present: true, value: a } : { present: false }, after: has ? { present: true, value: b } : { present: false } });
  }
  return changes;
}

// A completed in-flight write must also respect the latest typing deadline.
// Explicit flushes still call saveState directly before navigation or actions.
export function scheduleSave(delay = 0): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    void saveState();
  }, Math.max(delay, commentSaveNotBefore - Date.now()));
}
export function persist(commentInput = false): void {
  if (reviewDeleted) return;
  captureEditor();
  if (commentInput) commentSaveNotBefore = Date.now() + 300;
  scheduleSave(50);
}
export function showSaveStatus(): void {
  let notice = document.getElementById("save-status");
  if (!notice) { notice = document.createElement("div"); notice.id = "save-status"; notice.setAttribute("role", "status"); document.body.append(notice); }
  notice.className = "save-status";
  notice.hidden = !saveError;
  notice.textContent = saveError ? `Review changes are not saved: ${saveError}` : "";
}
export function saveState(): Promise<void> {
  if (saveOperation) return saveOperation;
  saveOperation = writeState().finally(() => { saveOperation = null; });
  return saveOperation;
}
/** How a save ended: stored, refused by the server, or unknown when no answer arrived. */
type SaveOutcome = "saved" | "rejected" | "unknown";
/** A save whose outcome is unknown: the server may hold its changes or the state before them. */
let unconfirmedSave: { changes: ReviewStateChange[]; after: StoredReviewState } | null = null;
/** Sends one change set and records why it failed. A failure the server reports stored nothing. */
async function sendChanges(changes: ReviewStateChange[]): Promise<SaveOutcome> {
  try {
    const response = await api.saveReviewState({ reviewId: savedReview.reviewId, generation: savedReview.generation, changes });
    const payload = await response.json();
    if (response.ok && payload.ok) return "saved";
    if (payload.ok === false) {
      const failure = failureOf(payload);
      if (failure.reviewUnavailable) markReviewDeleted(true);
      saveError = failure.error || "Save failed. Make another edit to retry.";
      return "rejected";
    }
    saveError = "Save failed. Make another edit to retry.";
  } catch (error) { saveError = errorMessage(error); }
  return "unknown";
}
export async function writeState(): Promise<void> {
  if (reviewDeleted) return;
  captureEditor();
  // With nothing left to save and every earlier save's outcome known, an earlier failure no longer applies.
  if (!unconfirmedSave && !stateChanges(persistedState, storedState()).length) { if (saveError) { saveError = ""; showSaveStatus(); } return; }
  savingState = true; showSaveStatus();
  try {
    // The store accepts an exact retry, so resending a save of unknown outcome
    // leaves the server with its changes either way. Until then the state the
    // server last confirmed may not be its state, and a change back to it would
    // not be sent.
    if (unconfirmedSave) {
      if (await sendChanges(unconfirmedSave.changes) !== "saved") return;
      persistedState = unconfirmedSave.after;
      unconfirmedSave = null;
    }
    const next = storedState();
    const changes = stateChanges(persistedState, next);
    if (changes.length) {
      const outcome = await sendChanges(changes);
      if (outcome === "unknown") unconfirmedSave = { changes, after: next };
      if (outcome !== "saved") return;
      persistedState = next;
    }
    saveError = "";
  } finally { savingState = false; showSaveStatus(); }
  if (stateChanges(persistedState, storedState()).length) scheduleSave();
}
export async function flushReviewState(): Promise<void> {
  if (reviewDeleted) return;
  await Promise.all([...uploadOps, ...approvalOps.values()]);
  clearTimeout(saveTimer);
  await saveState();
  if (saveError) throw new Error(saveError);
  captureEditor();
  while (uploadOps.size || approvalOps.size || stateChanges(persistedState, storedState()).length) {
    await Promise.all([...uploadOps, ...approvalOps.values()]);
    // Another tab or session deleted the review while this flush waited.
    if (reviewDeleted) throw new Error("The review was deleted before its changes were saved.");
    await saveState();
    if (saveError) throw new Error(saveError);
    captureEditor();
  }
  clearTimeout(saveTimer);
}

/** Warns before leaving while review changes are not saved. */
export function installUnloadGuard(): void {
  window.addEventListener("beforeunload", (event) => {
    if (reviewDeleted) return;
    captureEditor();
    if (uploadOps.size || approvalOps.size || savingState || saveError || exportState.phase === "working" || saveTimer && stateChanges(persistedState, storedState()).length) { event.preventDefault(); event.returnValue = ""; }
  });
}
