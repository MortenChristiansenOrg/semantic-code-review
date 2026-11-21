// The review state: what the reviewer has approved, opened and written, saved
// to the review server as changes to the state it last saved.
import type { ApiFailure, ReviewStateChange, ReviewStateValue, ReviewTarget, StoredReviewState } from "../../scripts/src/shared/viewer-protocol";
import * as api from "./api";
import { approvalOps } from "./approval-state";
import { uploadOps } from "./attachments";
import { captureEditor } from "./editor";
import { exportState } from "./feedback-actions";
import { errorMessage, failureOf, isRecord, type UnknownRecord } from "./narrow";
import { endedReviewText, markReviewEnded, updateReviewList } from "./saved-reviews";
import { readState } from "./stored-state";
import type { ViewerState } from "./types";

/** Why the page's review ended: its data was deleted, or its implementation archived. */
export type ReviewEnd = "deleted" | "archived";
/** Set once the review ended; the page then saves and polls nothing more. */
export let reviewEnded: ReviewEnd | null = null;
/** Whether another tab or session ended the review, before this page loaded or
 * while it showed the review, so the page offers its unsent text for copying. */
export let endedElsewhere = false;
/** How a failure says the review ended, if it does. */
export function reviewEndOf(failure: Partial<ApiFailure>): ReviewEnd | null {
  return failure.reviewUnavailable ? "deleted" : failure.implementationArchived ? "archived" : null;
}

/** The review whose state the page saves, as the server last sent it. */
export interface SavedReview extends ReviewTarget {
  state: StoredReviewState;
  /** Counts the saves that changed the state. */
  stateRevision: number;
}

export let savedReview: SavedReview;
export let persistedState: StoredReviewState;
/** The server's state revision when it last confirmed `persistedState`. */
let persistedRevision = 0;
export let savingState = false;
export let saveError = "";
export let saveTimer: number | undefined;
export let commentSaveNotBefore = 0;
export let saveOperation: Promise<void> | null = null;

/* ---- state ------------------------------------------------------------ */
export let state: ViewerState;

/** Starts the page's state from the saved review; `ended` when the review already ended. */
export function initState(saved: SavedReview, ended: ReviewEnd | null): void {
  savedReview = saved;
  reviewEnded = ended;
  endedElsewhere = ended !== null;
  persistedState = structuredClone(savedReview.state);
  persistedRevision = savedReview.stateRevision;
  state = load();
}
/** Marks the review ended, `external` when another tab or session ended it. */
export function setReviewEnded(end: ReviewEnd, external: boolean): void { reviewEnded = end; endedElsewhere = external; }
/** Stops saving once the review ended. */
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
  if (reviewEnded) return;
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
/** One save: the ID the server records when it lands, and its changes. */
interface StateSave { saveId: string; changes: ReviewStateChange[] }
/** A save whose outcome is unknown: the server may hold its changes or the values before them. */
let unresolvedSave: StateSave | null = null;
/** The server's message when another tab changed state this page saves. */
const changedInAnotherTab = "Review state changed in another tab. Keep your draft text and reload before retrying.";
/** Set once another tab changed a value this page saved without an answer; saving stops until reload. */
let changedElsewhere = false;
/** A random save ID. Unlike `crypto.randomUUID`, `getRandomValues` also works outside a secure context. */
function newSaveId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
/** Sends one change set and records why it failed. A failure the server reports stored nothing. */
async function sendChanges({ saveId, changes }: StateSave): Promise<SaveOutcome> {
  try {
    const response = await api.saveReviewState({ reviewId: savedReview.reviewId, generation: savedReview.generation, changes, saveId });
    const payload = await response.json();
    if (response.ok && payload.ok) { persistedRevision = payload.stateRevision; return "saved"; }
    if (payload.ok === false) {
      const failure = failureOf(payload);
      const end = reviewEndOf(failure);
      if (end) markReviewEnded(end, true);
      saveError = failure.error || "Save failed. Make another edit to retry.";
      return "rejected";
    }
    saveError = "Save failed. Make another edit to retry.";
  } catch (error) { saveError = errorMessage(error); }
  return "unknown";
}
/** Whether two JSON values are equal, regardless of key order. */
function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => sameJson(item, b[index]));
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]));
  }
  return a === b;
}
function sameValue(a: ReviewStateValue, b: ReviewStateValue): boolean {
  return a.present ? b.present && sameJson(a.value, b.value) : !b.present;
}
/** The value at `path`, or undefined when a key on the way holds something other than an object. */
function valueAt(root: StoredReviewState, path: string[]): ReviewStateValue | undefined {
  let target: UnknownRecord = root;
  for (const [index, key] of path.entries()) {
    if (!Object.hasOwn(target, key)) return { present: false };
    const value = target[key];
    if (index === path.length - 1) return { present: true, value };
    if (!isRecord(value)) return undefined;
    target = value;
  }
  return undefined;
}
/** Sets the value at `path` in `root`, creating the objects on the way. Keys are
 * defined as own properties, so a key such as "__proto__" never reaches a prototype. */
function setValueAt(root: StoredReviewState, path: string[], value: ReviewStateValue): void {
  const define = (target: UnknownRecord, key: string, item: unknown) => Object.defineProperty(target, key, { value: item, enumerable: true, configurable: true, writable: true });
  let target: UnknownRecord = root;
  for (const [index, key] of path.entries()) {
    if (index === path.length - 1) {
      if (value.present) define(target, key, value.value);
      else delete target[key];
      return;
    }
    const next = Object.hasOwn(target, key) ? target[key] : undefined;
    const record = isRecord(next) ? next : {};
    if (record !== next) define(target, key, record);
    target = record;
  }
}
/** Finds out from the server whether a save of unknown outcome landed. If no
 * save changed the state since the page's last confirmed one, it did not. If
 * exactly one did, the server's `lastSaveId` says whether it was this one or
 * another tab's. With more, this one may have landed under another tab's, so it
 * counts as a conflict. So does a value another tab changed at one of this
 * save's paths, even to the same value: as when the server refuses a save for
 * that reason, saving stops until reload. A request that fails leaves the
 * outcome unknown. */
async function resolveUnknownSave({ saveId, changes }: StateSave): Promise<"resolved" | "conflict" | "unknown"> {
  try {
    const response = await api.getReviewState();
    const body = await response.json();
    if (!response.ok || !body.ok) {
      const failure = failureOf(body);
      const end = reviewEndOf(failure);
      if (end) markReviewEnded(end, true);
      saveError = failure.error || "Save failed. Make another edit to retry.";
      return "unknown";
    }
    if (body.generation !== savedReview.generation) { saveError = "This review session was replaced. Reopen the review."; return "unknown"; }
    const conflict = () => { changedElsewhere = true; saveError = changedInAnotherTab; return "conflict" as const; };
    const landedSince = body.stateRevision - persistedRevision;
    if (landedSince < 0 || landedSince > 1) return conflict();
    const stored = landedSince === 1 && body.lastSaveId === saveId;
    const acknowledged = structuredClone(persistedState);
    for (const change of changes) {
      const current = valueAt(body.state, change.path);
      if (!current || !sameValue(current, stored ? change.after : change.before)) return conflict();
      if (stored) setValueAt(acknowledged, change.path, change.after);
    }
    persistedState = acknowledged;
    persistedRevision = body.stateRevision;
    return "resolved";
  } catch (error) { saveError = errorMessage(error); return "unknown"; }
}
export async function writeState(): Promise<void> {
  if (reviewEnded) return;
  captureEditor();
  if (changedElsewhere) return;
  // With nothing left to save and every earlier save's outcome known, an earlier failure no longer applies.
  if (!unresolvedSave && !stateChanges(persistedState, storedState()).length) { if (saveError) { saveError = ""; showSaveStatus(); } return; }
  savingState = true; showSaveStatus();
  try {
    // Until a save's outcome is known, the state the server last confirmed may
    // not be its state, and a change back to it would not be sent.
    if (unresolvedSave) {
      if (await resolveUnknownSave(unresolvedSave) !== "resolved") return;
      unresolvedSave = null;
      // The review may have ended while the server's state was read.
      if (reviewEnded) return;
    }
    const next = storedState();
    const changes = stateChanges(persistedState, next);
    if (changes.length) {
      const save = { saveId: newSaveId(), changes };
      const outcome = await sendChanges(save);
      if (outcome === "unknown") unresolvedSave = save;
      if (outcome !== "saved") return;
      persistedState = next;
    }
    saveError = "";
  } finally {
    savingState = false; showSaveStatus();
    // A save that lands after the review ended changes what the notice lists as not saved.
    if (reviewEnded) updateReviewList();
  }
  if (stateChanges(persistedState, storedState()).length) scheduleSave();
}
export async function flushReviewState(): Promise<void> {
  if (reviewEnded) return;
  /** Refuses once another tab or session ended the review while this flush
   * waited: the changes it waited for were not saved, and the page keeps saying so. */
  const assertNotEnded = () => {
    if (reviewEnded) throw new Error(reviewEnded === "archived" ? "The implementation was archived before the review's changes were saved." : "The review was deleted before its changes were saved.");
  };
  await Promise.all([...uploadOps, ...approvalOps.values()]);
  assertNotEnded();
  clearTimeout(saveTimer);
  await saveState();
  if (saveError) throw new Error(saveError);
  captureEditor();
  while (uploadOps.size || approvalOps.size || stateChanges(persistedState, storedState()).length) {
    await Promise.all([...uploadOps, ...approvalOps.values()]);
    assertNotEnded();
    await saveState();
    if (saveError) throw new Error(saveError);
    captureEditor();
  }
  clearTimeout(saveTimer);
}

/** Warns before leaving while review changes are not saved, or, once the
 * review ended, while the page offers unsent text that leaving would discard. */
export function installUnloadGuard(): void {
  window.addEventListener("beforeunload", (event) => {
    if (reviewEnded) {
      if (endedReviewText()) { event.preventDefault(); event.returnValue = ""; }
      return;
    }
    captureEditor();
    if (uploadOps.size || approvalOps.size || savingState || saveError || unresolvedSave || changedElsewhere || exportState.phase === "working" || saveTimer && stateChanges(persistedState, storedState()).length) { event.preventDefault(); event.returnValue = ""; }
  });
}
