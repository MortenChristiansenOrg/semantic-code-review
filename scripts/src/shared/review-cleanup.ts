/** Review-owned storage inspection and retirement. Repository paths are display data only. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { atomicJson, attachmentIds, isReviewId, readReview, reviewDeletionPath, reviewDirectory, reviewHome, withReviewLock, type ReviewRecord } from "./review-store.js";

const GRACE_MS = 60 * 60 * 1000;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
type Entry = { name: string; size: number; modified: number; directory: boolean; link: boolean; hash?: string };
type Ticket = { review: Omit<ReviewRecord, "state" | "viewer">; preview: any; requestedAt: string; error?: string };
function trashDirectory(id: string, generation: string) {
  reviewDeletionPath(id, generation); return path.join(reviewHome(), "trash", `${id}.${generation}`);
}
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
function rawTicket(id: string, generation: string): Ticket | null {
  const file = reviewDeletionPath(id, generation);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}
export function pendingReviewDeletions() {
  const directory = path.join(reviewHome(), "deletions");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((file) => {
    const parts = /^(.+)\.([a-f0-9-]{36})\.json$/.exec(file);
    return parts && isReviewId(parts[1]);
  }).map((file) => {
    const ticket: Ticket = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
    if (path.basename(reviewDeletionPath(ticket.review.id, ticket.review.generation)) !== file) throw new Error("Invalid pending deletion identity.");
    return { ...ticket.review, available: false, deletionPending: true, unavailableReason: ticket.error || "File removal is pending." };
  });
}
function inspect(id: string, generation: string) {
  const ticket = rawTicket(id, generation);
  if (ticket) {
    const trash = trashDirectory(id, generation), location = fs.existsSync(trash) ? trash : reviewDirectory(id);
    const entries = inventory(location), ticketBytes = fs.statSync(reviewDeletionPath(id, generation)).size;
    const categories = ticket.preview.categories.map((category) => {
      const prefix = { "Submitted feedback": "feedback/", Attachments: "attachments/", "Approved snapshots": "snapshots/" }[category.label];
      const matches = (entry: Entry) => category.label === "Review state" ? entry.name === "review.json"
        : prefix ? entry.name.startsWith(prefix) : entry.name !== "review.json" && !/^(feedback|attachments|snapshots)\//.test(entry.name);
      return { label: category.label, detail: "Pending removal", bytes: entries.filter(matches).reduce((sum, entry) => sum + entry.size, 0) };
    });
    categories.push({ label: "Deletion record", detail: "Removed when cleanup finishes", bytes: ticketBytes });
    return { ...ticket.preview, storageDirectory: location, deletionPending: true, error: ticket.error, categories, drafts: 0, unresolved: 0,
      bytes: entries.reduce((sum, entry) => sum + entry.size, 0) + ticketBytes, unused: [], unusedBytes: 0 };
  }
  const review = readReview(id);
  if (review.generation !== generation) throw new Error("The selected review was replaced. Refresh Saved reviews.");
  const directory = reviewDirectory(id), entries = inventory(directory), state = review.state;
  const refs = attachmentIds(state), snapshots = new Set(Object.values(state.approvals || {}).map((value: any) => value?.snapshotId));
  let feedbackThreads = 0, unresolved = 0, referenceError = "";
  for (const entry of entries.filter((item) => item.name.startsWith("feedback/threads/") && item.name.endsWith(".json"))) {
    try {
      if (entry.link) throw new Error("Feedback is a symbolic link.");
      const thread = JSON.parse(fs.readFileSync(path.join(directory, entry.name), "utf8"));
      if (!Array.isArray(thread.comments)) throw new Error("Invalid feedback comments.");
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
      try { lastUse = Date.parse(JSON.parse(fs.readFileSync(path.join(directory, entry.name, "metadata.json"), "utf8")).uploadedAt); eligible = Number.isFinite(lastUse); }
      catch { eligible = false; }
    } else if (snapshot && !snapshots.has(snapshot[1])) eligible = true;
    else if (/^(attachments\/\.upload-|snapshots\/\.compare-)[a-zA-Z0-9-]+$/.test(entry.name)) eligible = true;
    if (retired || eligible && Date.now() - lastUse >= GRACE_MS) unused.push({ path: entry.name, bytes: entries.filter((item) => item.name === entry.name || item.name.startsWith(entry.name + "/")).reduce((sum, item) => sum + item.size, 0) });
  }
  const notes = Array.isArray(state.comments) ? state.comments : [], replies = Array.isArray(state.replyDrafts) ? state.replyDrafts : [];
  const hasMessage = (value: any) => Boolean(value?.body?.trim() || value?.attachments?.length);
  const drafts = notes.filter((note) => note.mode === "feedback" && !note.exported).length + replies.length + Number(hasMessage(state.editor?.compose)) + Number(Boolean(state.editor?.replyTo && (state.editor.replyDraft?.trim() || state.editor.replyAttachments?.length)));
  const categories = [
    { label: "Review state", bytes: entries.filter((item) => item.name === "review.json").reduce((sum, item) => sum + item.size, 0), detail: `${drafts} unsent draft${drafts === 1 ? "" : "s"} · ${notes.filter((note) => note.mode !== "feedback").length} personal notes · ${Object.keys(state.approvals || {}).length} approvals` },
    { label: "Submitted feedback", prefix: "feedback/", detail: `${feedbackThreads} threads · ${unresolved} unresolved` },
    { label: "Attachments", prefix: "attachments/", detail: `${entries.filter((item) => /^attachments\/[a-f0-9]{64}\/content\.bin$/.test(item.name)).length} files` },
    { label: "Approved snapshots", prefix: "snapshots/", detail: `${entries.filter((item) => /^snapshots\/[a-f0-9]{32}\.json$/.test(item.name)).length} snapshots` },
  ].map((category) => ({ label: category.label, detail: category.detail, bytes: category.bytes ?? entries.filter((item) => item.name.startsWith(category.prefix)).reduce((sum, item) => sum + item.size, 0) }));
  const bytes = entries.reduce((sum, item) => sum + item.size, 0), knownBytes = categories.reduce((sum, item) => sum + item.bytes, 0);
  if (bytes > knownBytes) categories.push({ label: "Other owned files", bytes: bytes - knownBytes, detail: "Temporary and auxiliary review files" });
  const { state: ignoredState, viewer: ignoredViewer, ...identity } = review;
  return { review: identity, storageDirectory: directory, bytes, categories, drafts, unresolved, referenceError,
    fingerprint: digest(JSON.stringify([review, entries])), unused, unusedBytes: unused.reduce((sum, item) => sum + item.bytes, 0), deletionPending: false };
}
export function inspectReviewStorage(id: string, generation: string) {
  return withReviewLock(id, () => inspect(id, generation));
}
/** The durable ticket invalidates all old writers before file removal starts. */
export function deleteReviewData(id: string, generation: string, fingerprint: string) {
  return withReviewLock(id, () => {
    const file = reviewDeletionPath(id, generation), live = reviewDirectory(id), trash = trashDirectory(id, generation);
    let ticket = rawTicket(id, generation);
    if (!ticket) {
      if (!fs.existsSync(live)) return { deleted: true, cleanupPending: false }; // Exact retry after completion.
      const preview = inspect(id, generation);
      if (typeof fingerprint !== "string" || fingerprint !== preview.fingerprint) throw new Error("Review data changed since the preview. Refresh the details before deleting.");
      ticket = { review: preview.review, preview, requestedAt: new Date().toISOString() };
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); atomicJson(file, ticket);
    }
    try {
      if (fs.existsSync(live)) {
        const record = JSON.parse(fs.readFileSync(path.join(live, "review.json"), "utf8"));
        if (record.generation !== generation) throw new Error("A newer review session exists; it will not be removed.");
        fs.mkdirSync(path.dirname(trash), { recursive: true, mode: 0o700 }); fs.renameSync(live, trash);
      }
      fs.rmSync(trash, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      fs.rmSync(file, { force: true });
      return { deleted: true, cleanupPending: false };
    } catch (error) {
      ticket.error = `Review is deleted, but file cleanup needs a retry: ${error.message}`;
      try { atomicJson(file, ticket); } catch { /* Preserve the existing durable ticket. */ }
      return { deleted: true, cleanupPending: true, error: ticket.error };
    }
  });
}
export function cleanUnusedReviewFiles(id: string, generation: string, fingerprint: string) {
  return withReviewLock(id, () => {
    const preview = inspect(id, generation);
    if (preview.deletionPending || preview.referenceError) throw new Error(preview.referenceError || "Finish deleting this review first.");
    if (typeof fingerprint !== "string" || fingerprint !== preview.fingerprint) throw new Error("Review data changed since the preview. Refresh the details before cleanup.");
    const failures: string[] = []; let reclaimedBytes = 0;
    for (const item of preview.unused) {
      try {
        let retired = path.join(reviewDirectory(id), item.path);
        if (!item.path.startsWith(".cleanup/")) {
          const directory = path.join(reviewDirectory(id), ".cleanup"); fs.mkdirSync(directory, { recursive: true });
          retired = path.join(directory, randomUUID()); fs.renameSync(path.join(reviewDirectory(id), item.path), retired);
        }
        fs.rmSync(retired, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); reclaimedBytes += item.bytes;
      }
      catch (error) { failures.push(`${item.path}: ${error.message}`); }
    }
    return { reclaimedBytes, failures };
  });
}
