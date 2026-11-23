/** Review-owned storage inspection and retirement. Repository paths are display data only. */
import fs from "node:fs";
import path from "node:path";
import { cleanupFailure } from "./cleanup-diagnostics.js";
import { createHash, randomUUID } from "node:crypto";
import { beginReviewDeletion, completeReviewDeletion, pathMissing, pendingDeletionDirectory, markReviewIdRetired, readReview, recoverInterruptedDeletion, retireReviewId, reviewDeletionPending, reviewDirectory, rollBackReviewDeletion, withReviewLock } from "./review-store.js";
import { parseJson, parseJsonDocument } from "./json.js";
import { FEEDBACK_MANIFEST_SCHEMA_ID, THREAD_SCHEMA_ID } from "./documents.js";
import { isDocument, type DocumentTypes, type SchemaId } from "./schema-validation.js";
import { errorCode, errorMessage, isRecord, stringField } from "./narrow.js";
import type { ApiSuccess, ReviewCleanResponse, ReviewDeleteResponse, ReviewStorage } from "./viewer-protocol.js";

const GRACE_MS = 60 * 60 * 1000;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
type Entry = { name: string; size: number; modified: number; directory: boolean; link: boolean; hash?: string };
type Category = { label: string; detail: string; bytes: number };
/** Stands in for the content of a file or folder that cannot be read. Its
 * change time and identity still change with every write, so the fingerprint
 * does too; recording it keeps whole-review deletion possible, and the readers
 * that need the content, such as cleanup's feedback check, report it. */
function unreadable(error: unknown, stat: fs.Stats): string {
  // A file in use for a moment is reported, with the processes using it, as before.
  if (errorCode(error) === "EBUSY") throw error;
  return `unreadable:${errorCode(error) ?? "unknown"}:${stat.dev}:${stat.ino}:${stat.ctimeMs}`;
}
/** A document's hash, so the fingerprint changes with its content. */
function contentHash(file: string, stat: fs.Stats): string {
  try { return digest(fs.readFileSync(file)); }
  catch (error) { return unreadable(error, stat); }
}
/** Never follow directory links when calculating sizes or deletion candidates. */
function inventory(directory: string): Entry[] {
  if (!fs.existsSync(directory)) return [];
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("Review storage must not be a symbolic link.");
  const entries: Entry[] = [];
  function visit(relative: string) {
    const file = path.join(directory, relative), stat = fs.lstatSync(file), isDirectory = stat.isDirectory();
    entries.push({ name: relative.replaceAll(path.sep, "/"), size: isDirectory ? 0 : stat.size, modified: stat.mtimeMs, directory: isDirectory, link: stat.isSymbolicLink(),
      ...(!stat.isSymbolicLink() && stat.isFile() && relative.endsWith(".json") && !relative.startsWith("snapshots" + path.sep) ? { hash: contentHash(file, stat) } : {}) });
    if (!isDirectory) return;
    let names: string[];
    try { names = fs.readdirSync(file).sort(); }
    catch (error) { entries[entries.length - 1].hash = unreadable(error, stat); return; }
    for (const name of names) visit(path.join(relative, name));
  }
  for (const name of fs.readdirSync(directory).sort()) visit(name);
  return entries;
}
/** The attachments value refers to. The viewer opens an attachment by its ID,
 * so a reference whose path names another attachment keeps both. */
function usedAttachmentIds(value: unknown): Set<string> {
  const ids = new Set<string>();
  (function visit(item: unknown) {
    if (!item || typeof item !== "object") return;
    const stored = isRecord(item) && typeof item.path === "string" ? /^attachments\/([a-f0-9]{64})\/content\.bin$/.exec(item.path) : null;
    if (stored && isRecord(item) && typeof item.id === "string" && /^[a-f0-9]{64}$/.test(item.id)) { ids.add(item.id); ids.add(stored[1]); }
    for (const child of Object.values(item)) visit(child);
  })(value);
  return ids;
}
/** Why a file cannot be read, in plain words. */
function readProblem(error: unknown): string {
  const code = errorCode(error);
  return code === "ENOENT" ? "it is missing" : code === "EISDIR" ? "it is a folder" : code === "EACCES" || code === "EPERM" ? "access to it was denied" :
    code === "EBUSY" ? "another program is using it" : `it cannot be read (${code ?? errorMessage(error)})`;
}
/** What is at file, without following a link. */
function probe(file: string): "missing" | "link" | "directory" | "file" | { problem: string } {
  try {
    const stat = fs.lstatSync(file);
    // Reading a special file, such as a named pipe, could wait forever.
    return stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : { problem: "it is not a regular file" };
  }
  catch (error) { return errorCode(error) === "ENOENT" ? "missing" : { problem: readProblem(error) }; }
}
/** A feedback document's value, or why it cannot be read. Duplicate keys and
 * byte-order marks are refused, as the feedback readers refuse them. */
function readFeedbackDocument<K extends SchemaId>(schema: K, file: string): { value: DocumentTypes[K] } | { problem: string } {
  const kind = probe(file);
  if (kind === "link") return { problem: "it is a symbolic link or junction, which cleanup does not follow" };
  if (typeof kind === "object") return kind;
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (error) { return { problem: readProblem(error) }; }
  let value: unknown;
  try { value = parseJsonDocument(text, file); }
  catch { return { problem: "it is not valid JSON" }; }
  return isDocument(schema, value) ? { value } : { problem: "it does not match the feedback format" };
}
/** The submitted feedback whose attachments cleanup keeps: the threads the
 * feedback manifest lists, which are those the viewer and the feedback commands
 * read, and any other thread file found. It probes the paths those readers open,
 * which a case-insensitive volume also resolves when a folder's case differs.
 * Cleanup cannot know which attachments are used while any of it cannot be
 * read, or while part of it is reached through a link (a symbolic link or a
 * Windows junction), which the inventory never follows; error then says why
 * and no attachment counts as unused. */
function submittedFeedback(directory: string) {
  const refs = new Set<string>();
  let threads = 0, unresolved = 0;
  // Stands in for the listed threads the inventory cannot see, for the fingerprint.
  const stamps: string[] = [];
  const none = { refs, threads, unresolved, stamps, error: "" };
  const disabled = (problem: string) => ({ refs, threads, unresolved, stamps, error: `Clean unused files is disabled, so that no attachment of submitted feedback is removed: ${problem}.` });
  const folderProblem = (name: string, kind: ReturnType<typeof probe>) => kind === "link" ? `${name} in the review's storage is a symbolic link or junction, which cleanup does not follow` :
    kind === "file" ? `${name} in the review's storage is a file, not a folder` : `${name} cannot be read because ${typeof kind === "object" ? kind.problem : kind}`;
  const feedback = path.join(directory, "feedback"), threadFolder = path.join(feedback, "threads");
  const feedbackKind = probe(feedback);
  if (feedbackKind === "missing") return none;
  if (feedbackKind !== "directory") return disabled(folderProblem("feedback", feedbackKind));
  if (probe(path.join(feedback, "manifest.json")) === "missing") {
    let empty: boolean;
    try { empty = fs.readdirSync(feedback).length === 0; }
    catch (error) { return disabled(`feedback cannot be read because ${readProblem(error)}`); }
    // No feedback was submitted while its folder is empty.
    return empty ? none : disabled("feedback/manifest.json is missing, so the threads it should list are unknown");
  }
  const manifest = readFeedbackDocument(FEEDBACK_MANIFEST_SCHEMA_ID, path.join(feedback, "manifest.json"));
  if ("problem" in manifest) return disabled(`feedback/manifest.json cannot be read because ${manifest.problem}`);
  const listed = new Set(manifest.value.threads), threadsKind = probe(threadFolder);
  let found: string[] = [];
  if (threadsKind === "directory") {
    // The feedback commands ignore folders there too.
    try { found = fs.readdirSync(threadFolder, { withFileTypes: true }).filter((entry) => !entry.isDirectory() && entry.name.endsWith(".json")).map((entry) => entry.name.slice(0, -5)).filter((id) => !listed.has(id)).sort(); }
    catch (error) {
      for (const id of listed) {
        try { const stat = fs.lstatSync(path.join(threadFolder, `${id}.json`)); stamps.push(`${id}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`); }
        catch (statError) { stamps.push(`${id}:${errorCode(statError) ?? "unknown"}`); }
      }
      return disabled(`feedback/threads cannot be read because ${readProblem(error)}`);
    }
  } else if (threadsKind !== "missing") return disabled(folderProblem("feedback/threads", threadsKind));
  for (const id of [...listed, ...found]) {
    const thread = readFeedbackDocument(THREAD_SCHEMA_ID, path.join(threadFolder, `${id}.json`));
    if ("problem" in thread) return disabled(`feedback thread ${id}${listed.has(id) ? ", listed in feedback/manifest.json," : ""} cannot be read because ${thread.problem}`);
    if (listed.has(id)) { threads++; if (thread.value.status !== "resolved") unresolved++; }
    for (const attachment of usedAttachmentIds(thread.value)) refs.add(attachment);
  }
  return { refs, threads, unresolved, stamps, error: "" };
}
function inspect(id: string, generation: string) {
  const review = readReview(id);
  if (review.generation !== generation) throw new Error("The selected review was replaced. Refresh Saved reviews.");
  const directory = reviewDirectory(id), entries = inventory(directory), state = review.state;
  const refs = usedAttachmentIds(state), snapshots = new Set(Object.values(isRecord(state.approvals) ? state.approvals : {}).map((value) => stringField(value, "snapshotId")));
  const feedback = submittedFeedback(directory), referenceError = feedback.error, { threads: feedbackThreads, unresolved } = feedback;
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
    fingerprint: digest(JSON.stringify([review, entries, unused, feedback.stamps])), unused, unusedBytes: unused.reduce((sum, item) => sum + item.bytes, 0) };
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
