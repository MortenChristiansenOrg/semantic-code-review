/** Review-owned storage inspection and retirement. Repository paths are display data only. */
import fs from "node:fs";
import path from "node:path";
import { cleanupFailure } from "./cleanup-diagnostics.js";
import { createHash, randomUUID } from "node:crypto";
import { atomicJson, attachmentIds, isReviewId, parseReviewRecord, readReview, reviewDeletionPath, reviewDirectory, reviewHome, withReviewLock, type ReviewRecord } from "./review-store.js";
import { parseJson } from "./json.js";
import { errorCode, isRecord, stringField } from "./narrow.js";

const GRACE_MS = 60 * 60 * 1000;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
type Entry = { name: string; size: number; modified: number; directory: boolean; link: boolean; hash?: string };
type Category = { label: string; detail: string; bytes: number };
/** The ticket keeps the storage inspection shown before deletion for display only;
 * removal never depends on it, so it stays unvalidated and is narrowed where shown. */
type Ticket = { review: Omit<ReviewRecord, "state" | "viewer">; preview: unknown; requestedAt: string; error?: string };
function isCategory(value: unknown): value is Category {
  return isRecord(value) && typeof value.label === "string" && typeof value.detail === "string" && typeof value.bytes === "number";
}
/** The categories of a ticket's preview, or undefined when the preview is damaged. */
function previewCategories(preview: unknown): Category[] | undefined {
  const categories = isRecord(preview) ? preview.categories : undefined;
  return Array.isArray(categories) && categories.every(isCategory) ? categories : undefined;
}
/** Tickets are written by this module; anything else in their place is damage. */
function parseTicket(value: unknown, file: string): Ticket {
  const damaged = new Error(`Pending review deletion record ${JSON.stringify(file)} is damaged.`);
  if (!isRecord(value) || !isRecord(value.review) || typeof value.requestedAt !== "string" ||
    (value.error !== undefined && typeof value.error !== "string")) throw damaged;
  // The identity has the record's fields without its state; parse it with an empty one.
  const { state: ignoredState, viewer: ignoredViewer, ...review } = parseReviewRecord({ ...value.review, state: {} }, file);
  return { review, preview: value.preview, requestedAt: value.requestedAt, error: stringField(value, "error") };
}
function trashDirectory(id: string, generation: string) {
  reviewDeletionPath(id, generation); return path.join(reviewHome(), "trash", `${id}.${generation}`);
}
/** Never follow directory links when calculating sizes or deletion candidates. */
function inventory(directory: string, hashContents = true): Entry[] {
  if (!fs.existsSync(directory)) return [];
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("Review storage must not be a symbolic link.");
  const entries: Entry[] = [];
  function visit(relative: string) {
    const file = path.join(directory, relative), stat = fs.lstatSync(file), isDirectory = stat.isDirectory();
    entries.push({ name: relative.replaceAll(path.sep, "/"), size: isDirectory ? 0 : stat.size, modified: stat.mtimeMs, directory: isDirectory, link: stat.isSymbolicLink(),
      ...(hashContents && !stat.isSymbolicLink() && stat.isFile() && relative.endsWith(".json") && !relative.startsWith("snapshots" + path.sep) ? { hash: digest(fs.readFileSync(file)) } : {}) });
    if (isDirectory) for (const name of fs.readdirSync(file).sort()) visit(path.join(relative, name));
  }
  for (const name of fs.readdirSync(directory).sort()) visit(name);
  return entries;
}
function rawTicket(id: string, generation: string): Ticket | null {
  const file = reviewDeletionPath(id, generation);
  return fs.existsSync(file) ? parseTicket(parseJson(fs.readFileSync(file, "utf8")), file) : null;
}
export function pendingReviewDeletions() {
  const directory = path.join(reviewHome(), "deletions");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((file) => {
    const parts = /^(.+)\.([a-f0-9-]{36})\.json$/.exec(file);
    return parts && isReviewId(parts[1]);
  }).map((file) => {
    const ticket = parseTicket(parseJson(fs.readFileSync(path.join(directory, file), "utf8")), path.join(directory, file));
    if (path.basename(reviewDeletionPath(ticket.review.id, ticket.review.generation)) !== file) throw new Error("Invalid pending deletion identity.");
    return { ...ticket.review, available: false, deletionPending: true, unavailableReason: ticket.error || "File removal is pending." };
  });
}
function inspect(id: string, generation: string) {
  const ticket = rawTicket(id, generation);
  if (ticket) {
    const trash = trashDirectory(id, generation), location = fs.existsSync(trash) ? trash : reviewDirectory(id);
    const known = previewCategories(ticket.preview);
    // The stored preview is display data; only narrowed fields reach the browser.
    const pending = { review: ticket.review, storageDirectory: location, deletionPending: true,
      referenceError: stringField(ticket.preview, "referenceError") ?? "", fingerprint: stringField(ticket.preview, "fingerprint") ?? "",
      drafts: 0, unresolved: 0, unused: [], unusedBytes: 0 };
    // Pending deletion needs no content hashes. Even unreadable files must not
    // prevent the user from retrying removal through the viewer.
    let entries: Entry[];
    try { entries = inventory(location, false); }
    catch (error) {
      const categories = (known ?? []).map((category) => ({ ...category, detail: "Last known size; current inspection unavailable" }));
      return { ...pending, error: ticket.error || cleanupFailure(error, location, "Use Retry file removal after releasing it."),
        categories, bytes: categories.reduce((sum, category) => sum + category.bytes, 0) };
    }
    const ticketBytes = fs.statSync(reviewDeletionPath(id, generation)).size;
    const unavailable = { label: "Pending removal", detail: "Earlier preview unavailable", bytes: entries.reduce((sum, entry) => sum + entry.size, 0) };
    const categories = !known ? [unavailable] : known.map((category) => {
      const prefixes: Record<string, string> = { "Submitted feedback": "feedback/", Attachments: "attachments/", "Approved snapshots": "snapshots/", "Remote checkout": "checkout/" };
      const prefix = prefixes[category.label];
      const matches = (entry: Entry) => category.label === "Review state" ? entry.name === "review.json"
        : prefix ? entry.name.startsWith(prefix) : entry.name !== "review.json" && !/^(feedback|attachments|snapshots|checkout)\//.test(entry.name);
      return { label: category.label, detail: "Pending removal", bytes: entries.filter(matches).reduce((sum, entry) => sum + entry.size, 0) };
    });
    categories.push({ label: "Deletion record", detail: "Removed when cleanup finishes", bytes: ticketBytes });
    return { ...pending, error: ticket.error, categories, bytes: entries.reduce((sum, entry) => sum + entry.size, 0) + ticketBytes };
  }
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
  const { state: ignoredState, viewer: ignoredViewer, ...identity } = review;
  return { review: identity, storageDirectory: directory, bytes, categories, drafts, unresolved, referenceError,
    fingerprint: digest(JSON.stringify([review, entries])), unused, unusedBytes: unused.reduce((sum, item) => sum + item.bytes, 0), deletionPending: false };
}
function withCleanupDiagnostics<T>(id: string, retry: string, operation: () => T): T {
  try { return withReviewLock(id, operation); }
  catch (error) {
    if (!["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"].includes(errorCode(error) ?? "")) throw error;
    throw new Error(cleanupFailure(error, reviewDirectory(id), retry));
  }
}
export function inspectReviewStorage(id: string, generation: string) {
  return withCleanupDiagnostics(id, "Use Refresh details, then retry cleanup.", () => inspect(id, generation));
}
/** The durable ticket invalidates all old writers before file removal starts. */
export function deleteReviewData(id: string, generation: string, fingerprint: string) {
  return withCleanupDiagnostics(id, "Use Refresh details, then retry deletion.", () => {
    const file = reviewDeletionPath(id, generation), live = reviewDirectory(id), trash = trashDirectory(id, generation);
    let ticket = rawTicket(id, generation);
    if (!ticket) {
      if (!fs.existsSync(live)) return { deleted: true, cleanupPending: false }; // Exact retry after completion.
      const preview = inspect(id, generation);
      if (typeof fingerprint !== "string" || fingerprint !== preview.fingerprint) throw new Error("Review data changed since the preview. Refresh the details before deleting.");
      ticket = { review: preview.review, preview, requestedAt: new Date().toISOString() };
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); atomicJson(file, ticket);
    }
    let failedPath = live;
    try {
      if (fs.existsSync(live)) {
        const record = parseJson(fs.readFileSync(path.join(live, "review.json"), "utf8"));
        if (stringField(record, "generation") !== generation) throw new Error("A newer review session exists; it will not be removed.");
        fs.mkdirSync(path.dirname(trash), { recursive: true, mode: 0o700 }); fs.renameSync(live, trash);
      }
      failedPath = trash;
      fs.rmSync(trash, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      failedPath = file;
      fs.rmSync(file, { force: true });
      return { deleted: true, cleanupPending: false };
    } catch (error) {
      ticket.error = `Review deletion is pending; the old session cannot write. ${cleanupFailure(error, failedPath, "In Reviews, choose Retry deletion…, then Retry file removal.")}`;
      try { atomicJson(file, ticket); } catch { /* Preserve the existing durable ticket. */ }
      return { deleted: true, cleanupPending: true, error: ticket.error };
    }
  });
}
export function cleanUnusedReviewFiles(id: string, generation: string, fingerprint: string) {
  return withCleanupDiagnostics(id, "Use Refresh details, then retry Clean unused files.", () => {
    const preview = inspect(id, generation);
    if (preview.deletionPending || preview.referenceError) throw new Error(preview.referenceError || "Finish deleting this review first.");
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
