/** User-local review storage. All writes hold a per-review lock and replace one
 * document atomically; private data is never placed in implementation branches. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export function reviewHome() {
  const configured = process.env.SEMANTIC_FLOW_HOME;
  if (configured && !path.isAbsolute(configured)) throw new Error("SEMANTIC_FLOW_HOME must be an absolute path so all commands use the same user store.");
  return path.resolve(configured || path.join(os.homedir(), ".semantic-flow"));
}
export function reviewDirectory(id: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid review identity.");
  return path.join(reviewHome(), "reviews", id);
}
export function reviewId(root: string, implementationId: string) {
  return createHash("sha256").update(JSON.stringify([fs.realpathSync(root), implementationId])).digest("hex");
}
/** Resolves private feedback without registering a review or creating files. */
export function feedbackDirectory(root: string, implementationId?: string) {
  if (implementationId === undefined) {
    const file = path.join(root, ".semantic-review", "manifest.json");
    if (!fs.existsSync(file)) throw new Error("No active .semantic-review artifact exists.");
    implementationId = JSON.parse(fs.readFileSync(file, "utf8")).implementationId;
  }
  return path.join(reviewDirectory(reviewId(root, implementationId)), "feedback");
}
/** Caller must hold this review's lock. */
export function touchReview(id: string) {
  const record = readReview(id);
  record.updatedAt = new Date().toISOString();
  atomicJson(path.join(reviewDirectory(id), "review.json"), record);
}
export function atomicJson(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
/** Release the public lock name before removing files. Windows may defer a directory
 * deletion while a waiter briefly has the owner marker open; retries must never target
 * a newly acquired lock at the same public path. */
function retireLock(lock: string) {
  const retired = lock + ".retired-" + randomUUID();
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(lock, retired); break; }
    catch (error) {
      if (attempt >= 10 || !["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"].includes(error.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { fs.rmSync(retired, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); }
  catch { /* A retired directory cannot block or interfere with subsequent writers. */ }
}
export function withReviewLock<T>(id: string, operation: () => T): T {
  const locks = path.join(reviewHome(), "locks");
  fs.mkdirSync(locks, { recursive: true, mode: 0o700 });
  const lock = path.join(locks, path.basename(reviewDirectory(id)) + ".lock");
  const deadline = Date.now() + 10_000;
  // Publish a fully initialized, nonempty directory so a crash can never leave
  // a public lock whose owner is unknown. Private abandoned claims do not block.
  const claim = fs.mkdtempSync(lock + ".claim-");
  const owner = `owner-${randomUUID()}.json`;
  let published = false;
  try {
    fs.writeFileSync(path.join(claim, owner), JSON.stringify({ pid: process.pid }));
    while (true) {
      try { fs.renameSync(claim, lock); published = true; break; }
      catch (error) {
        if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error.code) || !fs.existsSync(lock)) throw error;
        try {
          const entries = fs.readdirSync(lock);
          if (!entries.length) fs.rmdirSync(lock); // A reaper died after removing its owner marker.
          else if (entries.length === 1 && /^owner-[a-f0-9-]{36}\.json$/.test(entries[0])) {
            const marker = path.join(lock, entries[0]);
            const { pid } = JSON.parse(fs.readFileSync(marker, "utf8"));
            if (Number.isInteger(pid) && pid > 0) {
              try { process.kill(pid, 0); }
              catch (error) {
                if (error.code === "ESRCH") {
                  // A unique marker prevents a delayed reaper from removing a
                  // replacement owner. rmdir can only remove an empty directory.
                  fs.unlinkSync(marker); fs.rmdirSync(lock);
                }
              }
            }
          }
        } catch { /* Another owner/reaper progressed, or a temporary read failed. */ }
        if (Date.now() >= deadline) throw new Error("Review data is busy. Retry the operation.");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
  } finally {
    if (!published) fs.rmSync(claim, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
  try { return operation(); }
  finally { retireLock(lock); }
}
export type ReviewRecord = {
  id: string; generation: string; repositoryRoot: string; implementationId: string;
  title: string; createdAt: string; updatedAt: string; completedAt: string | null;
  state: Record<string, any>;
  viewer?: { port: number; processId: number; viewerVersion: string; skillDirectory: string };
};
export function reviewDeletionPath(id: string, generation: string) {
  reviewDirectory(id);
  if (typeof generation !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(generation)) throw new Error("Invalid review generation.");
  return path.join(reviewHome(), "deletions", `${id}.${generation}.json`);
}
function hasPendingDeletion(id: string) {
  const directory = path.join(reviewHome(), "deletions");
  return fs.existsSync(directory) && fs.readdirSync(directory).some((file) => file.startsWith(id + ".") && file.endsWith(".json"));
}
export function attachmentIds(state: any): Set<string> {
  const ids = new Set<string>();
  function visit(value: any) {
    if (!value || typeof value !== "object") return;
    if (typeof value.id === "string" && /^[a-f0-9]{64}$/.test(value.id) && value.path === `attachments/${value.id}/content.bin`) ids.add(value.id);
    for (const item of Object.values(value)) visit(item);
  }
  visit(state); return ids;
}
export function readReview(id: string): ReviewRecord {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(reviewDirectory(id), "review.json"), "utf8"));
    if (fs.existsSync(reviewDeletionPath(id, record.generation))) throw Object.assign(new Error("Review data was deleted; file cleanup is pending. Retry deletion from Saved reviews."), { code: "REVIEW_UNAVAILABLE" });
    return record;
  }
  catch (error) { if (error.code === "ENOENT") throw Object.assign(new Error("Review data is unavailable or was deleted. Reopen the review explicitly."), { code: "REVIEW_UNAVAILABLE" }); throw error; }
}
export function registerReview(root: string, implementationId: string, title: string): ReviewRecord {
  root = fs.realpathSync(root);
  const id = reviewId(root, implementationId);
  return withReviewLock(id, () => {
    const directory = reviewDirectory(id);
    const file = path.join(directory, "review.json");
    if (hasPendingDeletion(id)) throw new Error("Finish pending review deletion before starting a fresh review.");
    if (fs.existsSync(file)) return readReview(id);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Children are owned by this review; later features can remove unreferenced
    // blobs without touching repository files. Locks live outside this directory.
    for (const child of ["feedback", "attachments", "snapshots"]) fs.mkdirSync(path.join(directory, child), { recursive: true });
    const now = new Date().toISOString();
    const record: ReviewRecord = { id, generation: randomUUID(), repositoryRoot: root, implementationId, title, createdAt: now, updatedAt: now, completedAt: null, state: {} };
    atomicJson(file, record);
    return record;
  });
}
type Value = { present: boolean; value?: any };
export type StateChange = { path: string[]; before: Value; after: Value };
function validateValue(value: Value) {
  if (!value || typeof value.present !== "boolean" || (value.present && !Object.hasOwn(value, "value"))) throw new Error("Invalid state change value.");
}
export function patchReviewState(id: string, generation: string, changes: StateChange[]) {
  if (!Array.isArray(changes) || changes.length > 10000) throw new Error("Invalid state changes.");
  return withReviewLock(id, () => {
    const record = readReview(id);
    if (record.generation !== generation) throw new Error("This review session was replaced. Reopen the review.");
    const previousActivity = structuredClone(reviewActivity(record.state));
    const previousSnapshots = approvalSnapshotIds(record.state);
    const previousAttachments = attachmentIds(record.state);
    for (const change of changes) {
      if (!Array.isArray(change.path) || !change.path.length || change.path.length > 32 || change.path.some((key) => typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key))) throw new Error("Invalid state change path.");
      validateValue(change.before); validateValue(change.after);
      let target = record.state;
      for (const key of change.path.slice(0, -1)) {
        if (!Object.hasOwn(target, key)) target[key] = {};
        if (!target[key] || typeof target[key] !== "object" || Array.isArray(target[key])) throw new Error("Review state changed in another tab. Keep your draft text and reload before retrying.");
        target = target[key];
      }
      const key = change.path.at(-1)!;
      const current: Value = Object.hasOwn(target, key) ? { present: true, value: target[key] } : { present: false };
      // Exact retries are harmless even if the original response was lost.
      if (isDeepStrictEqual(current, change.after)) continue;
      if (!isDeepStrictEqual(current, change.before)) throw new Error("Review state changed in another tab. Keep your draft text and reload before retrying.");
      if (change.after.present) Object.defineProperty(target, key, { value: change.after.value, enumerable: true, configurable: true, writable: true });
      else delete target[key];
    }
    for (const attachmentId of attachmentIds(record.state)) {
      if (!previousAttachments.has(attachmentId) && !fs.existsSync(path.join(reviewDirectory(id), "attachments", attachmentId, "metadata.json"))) throw new Error("Attachment content was removed. Upload the file again before saving.");
    }
    const snapshots = approvalSnapshotIds(record.state);
    for (const snapshotId of snapshots) {
      if (!previousSnapshots.has(snapshotId) && !fs.existsSync(path.join(reviewDirectory(id), "snapshots", snapshotId + ".json"))) throw new Error("Approved content is unavailable. Re-approve the file before saving.");
    }
    if (changes.length) {
      if (!isDeepStrictEqual(previousActivity, reviewActivity(record.state))) record.updatedAt = new Date().toISOString();
      atomicJson(path.join(reviewDirectory(id), "review.json"), record);
      for (const snapshotId of previousSnapshots) {
        if (!snapshots.has(snapshotId)) {
          try { fs.rmSync(path.join(reviewDirectory(id), "snapshots", snapshotId + ".json"), { force: true }); }
          catch { /* The owned orphan remains reclaimable during review cleanup. */ }
        }
      }
    }
    return record;
  });
}
function approvalSnapshotIds(state: Record<string, any>): Set<string> {
  return new Set(Object.values(state.approvals || {}).map((record: any) => record?.snapshotId).filter((id) => typeof id === "string" && /^[a-f0-9]{32}$/.test(id)));
}

/** Runtime location is discoverable without changing the user's edit timestamp. */
export function recordViewer(id: string, generation: string, viewer: ReviewRecord["viewer"]) {
  return withReviewLock(id, () => {
    const record = readReview(id);
    if (record.generation !== generation) throw new Error("The review session changed during viewer startup.");
    record.viewer = viewer;
    atomicJson(path.join(reviewDirectory(id), "review.json"), record);
  });
}
export function listReviews(): ReviewRecord[] {
  const directory = path.join(reviewHome(), "reviews");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((id) => /^[a-f0-9]{64}$/.test(id)).flatMap((id) => {
    if (hasPendingDeletion(id)) return [];
    try { return [readReview(id)]; }
    catch (error) {
      if (!fs.existsSync(path.join(reviewDirectory(id), "review.json"))) return [];
      throw error;
    }
  });
}

/** View preferences and opening an empty editor do not count as review edits. */
function reviewActivity(state: Record<string, any>) {
  return { approvals: state.approvals || {}, comments: state.comments || [], replyDrafts: state.replyDrafts || [],
    message: state.editor?.compose?.body || "", reply: state.editor?.replyDraft || "",
    messageAttachments: state.editor?.compose?.attachments || [], replyAttachments: state.editor?.replyAttachments || [] };
}
export function setReviewCompleted(id: string, generation: string, completed: boolean, expectedCompletedAt: string | null) {
  if (typeof completed !== "boolean" || (expectedCompletedAt !== null && typeof expectedCompletedAt !== "string")) throw new Error("Invalid review lifecycle change.");
  return withReviewLock(id, () => {
    const record = readReview(id);
    if (record.generation !== generation) throw new Error("The selected review was replaced. Refresh the review list.");
    if (Boolean(record.completedAt) === completed) return record;
    if (record.completedAt !== expectedCompletedAt) throw new Error("The review lifecycle changed in another tab. Refresh the review list.");
    record.updatedAt = new Date().toISOString();
    record.completedAt = completed ? record.updatedAt : null;
    atomicJson(path.join(reviewDirectory(id), "review.json"), record);
    return record;
  });
}
