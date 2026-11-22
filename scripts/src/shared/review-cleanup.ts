/** Review-owned storage inspection and retirement. Repository paths are display data only. */
import fs from "node:fs";
import path from "node:path";
import { cleanupFailure } from "./cleanup-diagnostics.js";
import { createHash, randomUUID } from "node:crypto";
import { attachmentIds, beginReviewDeletion, completeReviewDeletion, pathMissing, pendingDeletionDirectory, markReviewIdRetired, readReview, recoverInterruptedDeletion, retireReviewId, reviewDeletionPending, reviewDirectory, rollBackReviewDeletion, withReviewLock } from "./review-store.js";
import { parseJson } from "./json.js";
import { FEEDBACK_MANIFEST_SCHEMA_ID, THREAD_SCHEMA_ID } from "./documents.js";
import { isDocument, type DocumentTypes, type SchemaId } from "./schema-validation.js";
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
/** Why a feedback document cannot be read, in plain words, or its value. */
function readFeedbackDocument<K extends SchemaId>(schema: K, file: string): { value: DocumentTypes[K] } | { problem: string } {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (error) {
    const code = errorCode(error);
    return { problem: code === "ENOENT" ? "its file is missing" : code === "EISDIR" ? "it is a folder" : `its file cannot be read (${errorMessage(error)})` };
  }
  let value: unknown;
  try { value = parseJson(text); }
  catch { return { problem: "its file is not valid JSON" }; }
  return isDocument(schema, value) ? { value } : { problem: "its file does not match the feedback format" };
}
/** The submitted feedback whose attachments cleanup keeps: the threads the
 * feedback manifest lists, which are those the viewer and the feedback commands
 * read, and any other thread file found. Cleanup cannot know which attachments
 * are used while any of it cannot be read, or while part of it is reached
 * through a link (a symbolic link or a Windows junction), which the inventory
 * never follows; error then says why and no attachment counts as unused. */
function submittedFeedback(directory: string, entries: Entry[]) {
  const refs = new Set<string>();
  let threads = 0, unresolved = 0;
  const disabled = (problem: string) => ({ refs, threads, unresolved, error: `Clean unused files is disabled, so that no attachment of submitted feedback is removed: ${problem}.` });
  const link = entries.find((entry) => entry.link && (entry.name === "feedback" || entry.name.startsWith("feedback/")));
  if (link) return disabled(`${link.name} in the review's storage is a symbolic link or junction, which cleanup does not follow`);
  const folder = entries.find((entry) => entry.name === "feedback");
  const manifestFile = path.join(directory, "feedback", "manifest.json");
  if (!entries.some((entry) => entry.name === "feedback/manifest.json")) {
    // No feedback was submitted: the folder is missing or empty.
    if (!folder || folder.directory && !entries.some((entry) => entry.name.startsWith("feedback/"))) return { refs, threads, unresolved, error: "" };
    return disabled("feedback/manifest.json is missing, so the threads it should list are unknown");
  }
  const manifest = readFeedbackDocument(FEEDBACK_MANIFEST_SCHEMA_ID, manifestFile);
  if ("problem" in manifest) return disabled(`feedback/manifest.json cannot be read because ${manifest.problem}`);
  const listed = new Set(manifest.value.threads);
  const found = entries.flatMap((entry) => /^feedback\/threads\/([^/]+)\.json$/.exec(entry.name)?.[1] ?? []).filter((id) => !listed.has(id));
  for (const id of [...listed, ...found]) {
    const thread = readFeedbackDocument(THREAD_SCHEMA_ID, path.join(directory, "feedback", "threads", `${id}.json`));
    if ("problem" in thread) return disabled(`feedback thread ${id}${listed.has(id) ? ", listed in feedback/manifest.json," : ""} cannot be read because ${thread.problem}`);
    if (listed.has(id)) { threads++; if (thread.value.status !== "resolved") unresolved++; }
    for (const attachment of attachmentIds(thread.value)) refs.add(attachment);
  }
  return { refs, threads, unresolved, error: "" };
}
function inspect(id: string, generation: string) {
  const review = readReview(id);
  if (review.generation !== generation) throw new Error("The selected review was replaced. Refresh Saved reviews.");
  const directory = reviewDirectory(id), entries = inventory(directory), state = review.state;
  const refs = attachmentIds(state), snapshots = new Set(Object.values(isRecord(state.approvals) ? state.approvals : {}).map((value) => stringField(value, "snapshotId")));
  const feedback = submittedFeedback(directory, entries), referenceError = feedback.error, { threads: feedbackThreads, unresolved } = feedback;
  for (const id of feedback.refs) refs.add(id);
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
    // The candidates are included because an upload becomes one by age alone.
    fingerprint: digest(JSON.stringify([review, entries, unused])), unused, unusedBytes: unused.reduce((sum, item) => sum + item.bytes, 0) };
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
 * reached, or its ref keeps changing, the old ID is marked retired
 * instead, and the next registration that finds it in the artifact replaces it. When either step fails, the folder is
 * moved back and nothing has changed. When no snapshot holds the old ID, the mark
 * records that the deletion committed until the folder is removed, since an
 * interrupted deletion is completed only on such evidence. */
export function deleteReviewData(id: string, generation: string, fingerprint: string): ApiSuccess<ReviewDeleteResponse> {
  return withCleanupDiagnostics(id, "Use Refresh details, then retry deletion.", () => {
    recoverInterruptedDeletion(id);
    if (pathMissing(path.join(reviewDirectory(id), "review.json"))) {
      if (!pathMissing(reviewDirectory(id))) throw new Error("The review's folder has no review record, so it cannot be deleted safely. Open the review from its repository, then retry deletion.");
      if (!pathMissing(pendingDeletionDirectory(id))) throw new Error("An earlier deletion of this review was interrupted and cannot be settled yet: its repository cannot be reached at the recorded location. Run a Semantic Flow command from a worktree of the repository, then retry deletion.");
      return { deleted: true }; // Exact retry after completion.
    }
    const preview = inspect(id, generation);
    if (typeof fingerprint !== "string" || fingerprint !== preview.fingerprint) throw new Error("Review data changed since the preview. Refresh the details before deleting.");
    const record = readReview(id);
    beginReviewDeletion(id);
    let retirement: ReturnType<typeof retireReviewId>;
    try {
      retirement = retireReviewId(record);
      // The old ID may still be stored: the next registration that finds it
      // replaces it first. A remote review's ID
      // is held by nothing but its folder.
      if (retirement === "unconfirmed" || retirement === "unreachable") markReviewIdRetired(id);
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
    // A folder that cannot be renamed yet waits for cleanup; should the
    // implementation be archived first, the mark still shows the deletion committed.
    if (retirement === "rotated" && reviewDeletionPending(id)) markReviewIdRetired(id);
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
