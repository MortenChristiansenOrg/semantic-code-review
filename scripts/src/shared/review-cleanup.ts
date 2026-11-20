/** Review-owned storage inspection and retirement. Repository paths are display data only. */
import fs from "node:fs";
import path from "node:path";
import { cleanupFailure } from "./cleanup-diagnostics.js";
import { createHash, randomUUID } from "node:crypto";
import { attachmentIds, beginReviewDeletion, clearReviewIdRetired, completeReviewDeletion, markReviewIdRetired, readReview, recoverInterruptedDeletion, retireReviewId, reviewDeletionPending, reviewDirectory, rollBackReviewDeletion, withReviewLock } from "./review-store.js";
import { parseJson } from "./json.js";
import { errorCode, errorMessage, isRecord, stringField } from "./narrow.js";
import type { ApiSuccess, ReviewCleanResponse, ReviewDeleteResponse, ReviewStorage } from "./viewer-protocol.js";

const GRACE_MS = 60 * 60 * 1000;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
type Entry = { name: string; size: number; modified: number; directory: boolean; link: boolean; hash?: string };
type Category = { label: string; detail: string; bytes: number };
/** Never follow directory links when calculating sizes or deletion candidates. */
function inventory(directory: string): Entry[] {
  if (!fs.existsSync(directory)) return [];
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("Review storage must not be a symbolic link.");
  const entries: Entry[] = [];
  function visit(relative: string) {
    const file = path.join(directory, relative), stat = fs.lstatSync(file), isDirectory = stat.isDirectory();
    entries.push({ name: relative.replaceAll(path.sep, "/"), size: isDirectory ? 0 : stat.size, modified: stat.mtimeMs, directory: isDirectory, link: stat.isSymbolicLink(),
      ...(!stat.isSymbolicLink() && stat.isFile() && relative.endsWith(".json") && !relative.startsWith("snapshots" + path.sep) ? { hash: digest(fs.readFileSync(file)) } : {}) });
    if (isDirectory) for (const name of fs.readdirSync(file).sort()) visit(path.join(relative, name));
  }
  for (const name of fs.readdirSync(directory).sort()) visit(name);
  return entries;
}
function inspect(id: string, generation: string) {
  const review = readReview(id);
  if (review.generation !== generation) throw new Error("The selected review was replaced. Refresh Saved reviews.");
  const directory = reviewDirectory(id), entries = inventory(directory), state = review.state;
  const refs = attachmentIds(state), snapshots = new Set(Object.values(isRecord(state.approvals) ? state.approvals : {}).map((value) => stringField(value, "snapshotId")));
  let feedbackThreads = 0, unresolved = 0, referenceError = "";
  for (const entry of entries.filter((item) => item.name.startsWith("feedback/threads/") && item.name.endsWith(".json"))) {
    try {
      if (entry.link) throw new Error("Feedback is a symbolic link.");
      const thread = parseJson(fs.readFileSync(path.join(directory, entry.name), "utf8"));
      if (!isRecord(thread) || !Array.isArray(thread.comments)) throw new Error("Invalid feedback comments.");
      feedbackThreads++; if (thread.status !== "resolved") unresolved++;
      for (const id of attachmentIds(thread)) refs.add(id);
    } catch { referenceError = "Some feedback cannot be read. Unused-file cleanup is disabled to preserve its attachments."; }
  }
  const unused: Array<{ path: string; bytes: number }> = [];
  if (!referenceError) for (const entry of entries) {
    let eligible = false, lastUse = entry.modified;
    const retired = /^\.cleanup\/[a-f0-9-]{36}$/.test(entry.name);
    const attachment = /^attachments\/([a-f0-9]{64})$/.exec(entry.name);
    const snapshot = /^snapshots\/([a-f0-9]{32})\.json$/.exec(entry.name);
    if (attachment && entry.directory && !refs.has(attachment[1])) {
      try { lastUse = Date.parse(stringField(parseJson(fs.readFileSync(path.join(directory, entry.name, "metadata.json"), "utf8")), "uploadedAt") ?? ""); eligible = Number.isFinite(lastUse); }
      catch { eligible = false; }
    } else if (snapshot && !snapshots.has(snapshot[1])) eligible = true;
    else if (/^(attachments\/\.upload-|snapshots\/\.compare-)[a-zA-Z0-9-]+$/.test(entry.name)) eligible = true;
    if (retired || eligible && Date.now() - lastUse >= GRACE_MS) unused.push({ path: entry.name, bytes: entries.filter((item) => item.name === entry.name || item.name.startsWith(entry.name + "/")).reduce((sum, item) => sum + item.size, 0) });
  }
  const notes = Array.isArray(state.comments) ? state.comments : [], replies = Array.isArray(state.replyDrafts) ? state.replyDrafts : [];
  const hasText = (value: unknown) => typeof value === "string" && Boolean(value.trim());
  const hasItems = (value: unknown) => Array.isArray(value) && value.length > 0;
  const editor = isRecord(state.editor) ? state.editor : {};
  const compose = isRecord(editor.compose) ? editor.compose : {};
  const isFeedbackNote = (note: unknown) => isRecord(note) && note.mode === "feedback";
  const drafts = notes.filter((note) => isFeedbackNote(note) && isRecord(note) && !note.exported).length + replies.length +
    Number(hasText(compose.body) || hasItems(compose.attachments)) + Number(Boolean(editor.replyTo && (hasText(editor.replyDraft) || hasItems(editor.replyAttachments))));
  const sizeOf = (matches: (item: Entry) => boolean) => entries.filter(matches).reduce((sum, item) => sum + item.size, 0);
  const underPrefix = (prefix: string) => sizeOf((item) => item.name.startsWith(prefix));
  const categories: Category[] = [
    { label: "Review state", bytes: sizeOf((item) => item.name === "review.json"), detail: `${drafts} unsent draft${drafts === 1 ? "" : "s"} · ${notes.filter((note) => !isFeedbackNote(note)).length} personal notes · ${Object.keys(isRecord(state.approvals) ? state.approvals : {}).length} approvals` },
    { label: "Submitted feedback", bytes: underPrefix("feedback/"), detail: `${feedbackThreads} threads · ${unresolved} unresolved` },
    { label: "Attachments", bytes: underPrefix("attachments/"), detail: `${entries.filter((item) => /^attachments\/[a-f0-9]{64}\/content\.bin$/.test(item.name)).length} files` },
    ...(review.remote ? [{ label: "Remote checkout", bytes: underPrefix("checkout/"), detail: `${review.remote.branch} · Includes Git objects and checked-out code` }] : []),
    { label: "Approved snapshots", bytes: underPrefix("snapshots/"), detail: `${entries.filter((item) => /^snapshots\/[a-f0-9]{32}\.json$/.test(item.name)).length} snapshots` },
  ];
  const bytes = entries.reduce((sum, item) => sum + item.size, 0), knownBytes = categories.reduce((sum, item) => sum + item.bytes, 0);
  if (bytes > knownBytes) categories.push({ label: "Other owned files", bytes: bytes - knownBytes, detail: "Temporary and auxiliary review files" });
  const { state: ignoredState, stateRevision: ignoredRevision, lastSaveId: ignoredSaveId, viewer: ignoredViewer, gitCommonDir: ignoredLocator, missingSince: ignoredMissing, ...identity } = review;
  return { review: identity, storageDirectory: directory, bytes, categories, drafts, unresolved, referenceError,
    fingerprint: digest(JSON.stringify([review, entries])), unused, unusedBytes: unused.reduce((sum, item) => sum + item.bytes, 0) };
}
function withCleanupDiagnostics<T>(id: string, retry: string, operation: () => T): T {
  try { return withReviewLock(id, operation); }
  catch (error) {
    if (!["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"].includes(errorCode(error) ?? "")) throw error;
    throw new Error(cleanupFailure(error, reviewDirectory(id), retry));
  }
}
export function inspectReviewStorage(id: string, generation: string): ReviewStorage {
  return withCleanupDiagnostics(id, "Use Refresh details, then retry cleanup.", () => inspect(id, generation));
}
/** Deleting a review first moves its folder to a pending name, so its writers fail
 * from then on, then gives its implementation a fresh review ID, so nothing
 * reaches the deleted review again and the next review of the implementation
 * starts empty. Only then is the folder removed. When the repository cannot be
 * reached, or an archive's claim holds the old ID, the old ID is marked retired
 * instead, and the next registration that finds it in the artifact replaces it. When either step fails, the folder is
 * moved back and nothing has changed. When no snapshot holds the old ID, the mark
 * records that the deletion committed until the folder is removed, since an
 * interrupted deletion is completed only on such evidence. */
export function deleteReviewData(id: string, generation: string, fingerprint: string): ApiSuccess<ReviewDeleteResponse> {
  return withCleanupDiagnostics(id, "Use Refresh details, then retry deletion.", () => {
    recoverInterruptedDeletion(id);
    if (!fs.existsSync(path.join(reviewDirectory(id), "review.json"))) {
      if (reviewDeletionPending(id)) throw new Error("An earlier deletion of this review was interrupted and cannot be settled yet: its repository cannot be reached at the recorded location, or an archive of its implementation is in progress. Run a Semantic Flow command from a worktree of the repository, or finish the archive, then retry deletion.");
      return { deleted: true }; // Exact retry after completion.
    }
    const preview = inspect(id, generation);
    if (typeof fingerprint !== "string" || fingerprint !== preview.fingerprint) throw new Error("Review data changed since the preview. Refresh the details before deleting.");
    const record = readReview(id);
    beginReviewDeletion(id);
    let retirement: ReturnType<typeof retireReviewId>;
    try {
      retirement = retireReviewId(record);
      // The old ID may still be stored, or come back with a failed archive: the
      // next registration that finds it replaces it first. When nothing holds it,
      // nothing else shows that this deletion committed.
      if (retirement !== "rotated") markReviewIdRetired(id);
    } catch (error) {
      try { rollBackReviewDeletion(id); }
      catch (restoreError) {
        // The folder keeps its pending name, which cleanup never removes; the next
        // deletion or registration of the review moves it back first.
        throw new Error(`The implementation could not be given a new review ID (${errorMessage(error)}), and the review's data could not be moved back (${errorMessage(restoreError)}). Nothing was deleted: opening the review from its repository again moves the data back.`);
      }
      throw error;
    }
    completeReviewDeletion(id);
    if (retirement === "absent") clearReviewIdRetired(id);
    return { deleted: true };
  });
}
export function cleanUnusedReviewFiles(id: string, generation: string, fingerprint: string): ApiSuccess<ReviewCleanResponse> {
  return withCleanupDiagnostics(id, "Use Refresh details, then retry Clean unused files.", () => {
    const preview = inspect(id, generation);
    if (preview.referenceError) throw new Error(preview.referenceError);
    if (typeof fingerprint !== "string" || fingerprint !== preview.fingerprint) throw new Error("Review data changed since the preview. Refresh the details before cleanup.");
    const failures: string[] = []; let reclaimedBytes = 0;
    for (const item of preview.unused) {
      let retired = path.join(reviewDirectory(id), item.path);
      let failedPath = retired;
      try {
        if (!item.path.startsWith(".cleanup/")) {
          const directory = path.join(reviewDirectory(id), ".cleanup"); fs.mkdirSync(directory, { recursive: true });
          retired = path.join(directory, randomUUID()); fs.renameSync(path.join(reviewDirectory(id), item.path), retired);
        }
        failedPath = retired;
        fs.rmSync(retired, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); reclaimedBytes += item.bytes;
      }
      catch (error) { failures.push(cleanupFailure(error, failedPath, "Your saved review is unchanged. Choose Clean unused files again to retry.")); }
    }
    return { reclaimedBytes, failures };
  });
}
