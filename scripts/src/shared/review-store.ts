/** User-local review storage. All writes hold a per-review lock and replace one
 * document atomically; private data is never placed in implementation branches. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseJson } from "./json.js";
import { activeImplementationId, readArtifact, readArtifactDirectory, type ArtifactSnapshot } from "./artifact-store.js";
import { errorCode, isRecord, numberField, stringField, type JsonRecord } from "./narrow.js";
import type { ReviewStateChange, ReviewStateValue, StoredReviewState } from "./viewer-protocol.js";

export function reviewHome() {
  const configured = process.env.SEMANTIC_FLOW_HOME;
  if (configured && !path.isAbsolute(configured)) throw new Error("SEMANTIC_FLOW_HOME must be an absolute path so all commands use the same user store.");
  return path.resolve(configured || path.join(os.homedir(), ".semantic-flow"));
}
export function isReviewId(id: string) {
  return typeof id === "string" && /^[a-z0-9-]{1,24}--[a-z0-9-]{1,40}--[a-f0-9]{64}$/.test(id);
}
export function reviewDirectory(id: string) {
  if (!isReviewId(id)) throw new Error("Invalid review identity.");
  return path.join(reviewHome(), "reviews", id);
}
export function reviewId(root: string, implementationId: string) {
  const canonicalRoot = fs.realpathSync(root);
  // Managed remote clones are children of their owning review, whose identity
  // is stable across refreshes and independent of the cloned artifact's ID.
  const managedRoot = process.platform === "win32" ? fs.realpathSync.native(root) : canonicalRoot;
  const owner = path.basename(path.dirname(managedRoot));
  if (path.basename(managedRoot) === "checkout" && isReviewId(owner) && fs.existsSync(reviewDirectory(owner))) {
    // Git and Windows processes may report the same checkout using either 8.3
    // aliases or full paths. Native realpath expands aliases; comparison must
    // also respect Windows' case-insensitive paths.
    const canonical = (value: string) => {
      const resolved = fs.realpathSync.native(value);
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    if (canonical(path.dirname(managedRoot)) === canonical(reviewDirectory(owner))) {
      const record = readReview(owner);
      if (record.remote && canonical(record.repositoryRoot) === canonical(managedRoot) && record.implementationId === implementationId) return owner;
    }
  }
  const slug = (value: string, limit: number, fallback: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, limit).replace(/-+$/g, "") || fallback;
  const hash = createHash("sha256").update(JSON.stringify([canonicalRoot, implementationId])).digest("hex");
  // Stable labels aid manual browsing; the complete hash still distinguishes
  // worktrees and implementation IDs that normalize to the same readable name.
  return `${slug(path.basename(canonicalRoot), 24, "repository")}--${slug(implementationId, 40, "review")}--${hash}`;
}
/** Where a remote review keeps the artifact it reconstructed for its managed checkout. */
export function projectionDirectory(id: string) {
  return path.join(reviewDirectory(id), "artifact");
}
/** The review owning a managed remote checkout at root, if root is one. */
function managedCheckoutOwner(root: string): string | undefined {
  let real: string;
  try { real = fs.realpathSync.native(root); } catch { return undefined; }
  const owner = path.basename(path.dirname(real));
  if (path.basename(real) !== "checkout" || !isReviewId(owner) || !fs.existsSync(reviewDirectory(owner))) return undefined;
  const canonical = (value: string) => {
    const resolved = fs.realpathSync.native(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return canonical(path.dirname(real)) === canonical(reviewDirectory(owner)) ? owner : undefined;
}
/** Moves the projection an earlier version kept inside a managed checkout out
 * of it, whole. It runs under the review's lock, so a refresh that briefly
 * vacates the projection is never mistaken for a missing one, and it moves
 * only an untracked folder, never one that the checked-out branch tracks. */
function moveLegacyProjection(owner: string, root: string, directory: string): void {
  const legacy = path.join(root, ".semantic-review");
  if (!fs.existsSync(path.join(legacy, "manifest.json"))) return;
  withReviewLock(owner, () => {
    if (fs.existsSync(directory) || !fs.existsSync(path.join(legacy, "manifest.json"))) return;
    const tracked = spawnSync("git", ["ls-files", "--", ".semantic-review/manifest.json"], { cwd: root, encoding: "utf8", windowsHide: true });
    if (tracked.status !== 0 || tracked.stdout.trim()) return;
    try { fs.renameSync(legacy, directory); } catch { /* It stays unavailable until reopened. */ }
  });
}
/** The artifact a review of root shows: the projection a remote review made for
 * its managed checkout, or else the active artifact of root. */
export function readReviewArtifact(root: string): { files: ArtifactSnapshot; projection: boolean } | undefined {
  const owner = managedCheckoutOwner(root);
  if (owner !== undefined) {
    // A managed checkout shows only its review's projection, never files in the checkout.
    const directory = projectionDirectory(owner);
    if (!fs.existsSync(directory)) moveLegacyProjection(owner, root, directory);
    const projection = readArtifactDirectory(root, directory);
    return projection && { files: projection, projection: true };
  }
  const active = readArtifact(root);
  return active && { files: active, projection: false };
}
/** Resolves private feedback without registering a review or creating files. */
export function feedbackDirectory(root: string, implementationId?: string) {
  if (implementationId === undefined) implementationId = activeImplementationId(root);
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
      if (attempt >= 10 || !["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"].includes(errorCode(error) ?? "")) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { fs.rmSync(retired, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); }
  catch { /* A retired directory cannot block or interfere with subsequent writers. */ }
}
const heldLocks = new Set<string>();
/** Reentrant within one process, so a locked operation can call another locked helper. */
export function withReviewLock<T>(id: string, operation: () => T): T {
  const key = path.join(reviewHome(), id);
  if (heldLocks.has(key)) return operation();
  return acquireReviewLock(id, () => {
    heldLocks.add(key);
    try { return operation(); }
    finally { heldLocks.delete(key); }
  });
}
function acquireReviewLock<T>(id: string, operation: () => T): T {
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
        // The owner can retire the destination after a contended rename. Its
        // absence here is a reason to retry, not evidence of a fatal error.
        if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(errorCode(error) ?? "")) throw error;
        let blockingPid: number | undefined;
        try {
          const entries = fs.readdirSync(lock);
          if (!entries.length) { fs.rmdirSync(lock); continue; } // A reaper died after removing its owner marker.
          else if (entries.length === 1 && /^owner-[a-f0-9-]{36}\.json$/.test(entries[0])) {
            const marker = path.join(lock, entries[0]);
            const pid = numberField(parseJson(fs.readFileSync(marker, "utf8")), "pid");
            if (pid !== undefined && Number.isInteger(pid) && pid > 0) {
              blockingPid = pid;
              try { process.kill(pid, 0); }
              catch (error) {
                if (errorCode(error) === "ESRCH") {
                  blockingPid = undefined;
                  // A unique marker prevents a delayed reaper from removing a
                  // replacement owner. rmdir can only remove an empty directory.
                  fs.unlinkSync(marker); fs.rmdirSync(lock);
                  continue;
                }
              }
            }
          }
        } catch { /* Another owner/reaper progressed, or a temporary read failed. */ }
        if (Date.now() >= deadline) throw new Error(`Review data is busy at ${JSON.stringify(lock)}${blockingPid ? `; held by process PID ${blockingPid}` : "; holding process could not be identified"}. Wait for that operation to finish, or close the application using this review, then retry. Do not delete lock or review files manually.`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
  } finally {
    if (!published) fs.rmSync(claim, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
  let result: T;
  try { result = operation(); }
  catch (error) {
    try { retireLock(lock); } catch { /* The operation's own error says more. */ }
    throw error;
  }
  // The operation's writes are done. A failure to release the lock must not report
  // them as refused; a lock left behind names this process to the next writer.
  try { retireLock(lock); } catch { /* See above. */ }
  return result;
}
export type RemoteReview = { sourceRoot: string; remoteName: string; branch: string; targetBranch: string; headRevision?: string; refreshedAt?: string };
export type ViewerRecord = { port: number; processId: number; viewerVersion: string; skillDirectory: string };
export type ReviewRecord = {
  id: string; generation: string; repositoryRoot: string; implementationId: string;
  title: string; createdAt: string; updatedAt: string; completedAt: string | null;
  /** The viewer's saved review state. The browser owns its shape; read it by narrowing. */
  state: StoredReviewState;
  /** Counts the patches that changed the state, so a client can tell whether saves landed while it lacked an answer. */
  stateRevision: number;
  /** The ID the viewer gave the save that last changed the state, if it gave one. */
  lastSaveId?: string;
  remote?: RemoteReview;
  viewer?: ViewerRecord;
};
function optionalString(value: JsonRecord, key: string): boolean {
  return value[key] === undefined || typeof value[key] === "string";
}
function parseRemote(value: unknown): RemoteReview | undefined {
  if (!isRecord(value)) return undefined;
  const { sourceRoot, remoteName, branch, targetBranch } = value;
  if (typeof sourceRoot !== "string" || typeof remoteName !== "string" || typeof branch !== "string" || typeof targetBranch !== "string" ||
    !optionalString(value, "headRevision") || !optionalString(value, "refreshedAt")) return undefined;
  return { sourceRoot, remoteName, branch, targetBranch, headRevision: stringField(value, "headRevision"), refreshedAt: stringField(value, "refreshedAt") };
}
function parseViewer(value: unknown): ViewerRecord | undefined {
  if (!isRecord(value)) return undefined;
  const { port, processId, viewerVersion, skillDirectory } = value;
  // An out-of-range port would abort viewer startup instead of letting it choose one.
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535 ||
    typeof processId !== "number" || typeof viewerVersion !== "string" || typeof skillDirectory !== "string") return undefined;
  return { port, processId, viewerVersion, skillDirectory };
}
/** Narrows a stored review.json record; fails when a required field is missing or malformed. */
export function parseReviewRecord(value: unknown, file: string): ReviewRecord {
  const invalid = () => new Error(`Review data at ${JSON.stringify(file)} is malformed. Reopen the review explicitly.`);
  if (!isRecord(value)) throw invalid();
  const { id, generation, repositoryRoot, implementationId, createdAt, remote, viewer, lastSaveId } = value;
  // Older viewers could save a record without a title, lifecycle or state; those keep their defaults.
  const { title = "", updatedAt = createdAt, completedAt = null, state = {}, stateRevision = 0 } = value;
  if (typeof id !== "string" || typeof generation !== "string" || typeof repositoryRoot !== "string" || typeof implementationId !== "string" ||
    typeof title !== "string" || typeof createdAt !== "string" || typeof updatedAt !== "string" ||
    (completedAt !== null && typeof completedAt !== "string") || !isRecord(state) ||
    typeof stateRevision !== "number" || !Number.isSafeInteger(stateRevision) || stateRevision < 0 ||
    (lastSaveId !== undefined && typeof lastSaveId !== "string")) throw invalid();
  const record: ReviewRecord = { id, generation, repositoryRoot, implementationId, title, createdAt, updatedAt, completedAt, state, stateRevision };
  if (lastSaveId !== undefined) record.lastSaveId = lastSaveId;
  if (remote !== undefined) {
    const parsed = parseRemote(remote);
    if (!parsed) throw invalid();
    record.remote = parsed;
  }
  // Viewer metadata only locates a running viewer; damaged metadata counts as absent.
  const parsedViewer = parseViewer(viewer);
  if (parsedViewer) record.viewer = parsedViewer;
  return record;
}
export function reviewDeletionPath(id: string, generation: string) {
  reviewDirectory(id);
  if (typeof generation !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(generation)) throw new Error("Invalid review generation.");
  return path.join(reviewHome(), "deletions", `${id}.${generation}.json`);
}
export function hasPendingDeletion(id: string) {
  const directory = path.join(reviewHome(), "deletions");
  return fs.existsSync(directory) && fs.readdirSync(directory).some((file) => file.startsWith(id + ".") && file.endsWith(".json"));
}
export function attachmentIds(state: unknown): Set<string> {
  const ids = new Set<string>();
  function visit(value: unknown) {
    if (!value || typeof value !== "object") return;
    if (isRecord(value) && typeof value.id === "string" && /^[a-f0-9]{64}$/.test(value.id) && value.path === `attachments/${value.id}/content.bin`) ids.add(value.id);
    for (const item of Object.values(value)) visit(item);
  }
  visit(state); return ids;
}
export function readReview(id: string): ReviewRecord {
  try {
    const file = path.join(reviewDirectory(id), "review.json");
    const record = parseReviewRecord(parseJson(fs.readFileSync(file, "utf8")), file);
    if (fs.existsSync(reviewDeletionPath(id, record.generation))) throw Object.assign(new Error("Review data was deleted; file cleanup is pending. Retry deletion from Saved reviews."), { code: "REVIEW_UNAVAILABLE" });
    return record;
  }
  catch (error) { if (errorCode(error) === "ENOENT") throw Object.assign(new Error("Review data is unavailable or was deleted. Reopen the review explicitly."), { code: "REVIEW_UNAVAILABLE" }); throw error; }
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
    const record: ReviewRecord = { id, generation: randomUUID(), repositoryRoot: root, implementationId, title, createdAt: now, updatedAt: now, completedAt: null, state: {}, stateRevision: 0 };
    atomicJson(file, record);
    return record;
  });
}
type Value = ReviewStateValue;
export type StateChange = ReviewStateChange;
function validateValue(value: Value) {
  if (!value || typeof value.present !== "boolean" || (value.present && !Object.hasOwn(value, "value"))) throw new Error("Invalid state change value.");
}
/** Artifact IDs name state keys, so any key, including "__proto__", "constructor"
 * and "prototype", is an ordinary own property. Defining it, rather than assigning,
 * never reaches a prototype setter; reads check own properties only, and JSON keeps
 * such keys as own properties in both directions. */
function defineOwn(target: JsonRecord, key: string, value: unknown) {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}
export function patchReviewState(id: string, generation: string, changes: StateChange[], saveId?: string) {
  if (!Array.isArray(changes) || changes.length > 10000) throw new Error("Invalid state changes.");
  return withReviewLock(id, () => {
    const record = readReview(id);
    if (record.generation !== generation) throw new Error("This review session was replaced. Reopen the review.");
    const previousActivity = structuredClone(reviewActivity(record.state));
    const previousSnapshots = approvalSnapshotIds(record.state);
    const previousAttachments = attachmentIds(record.state);
    let changed = false;
    for (const change of changes) {
      if (!Array.isArray(change.path) || !change.path.length || change.path.length > 32 || change.path.some((key) => typeof key !== "string")) throw new Error("Invalid state change path.");
      validateValue(change.before); validateValue(change.after);
      let target = record.state;
      for (const key of change.path.slice(0, -1)) {
        if (!Object.hasOwn(target, key)) defineOwn(target, key, {});
        const next = target[key];
        if (!isRecord(next)) throw new Error("Review state changed in another tab. Keep your draft text and reload before retrying.");
        target = next;
      }
      const key = change.path[change.path.length - 1];
      const current: Value = Object.hasOwn(target, key) ? { present: true, value: target[key] } : { present: false };
      // Exact retries are harmless even if the original response was lost.
      if (isDeepStrictEqual(current, change.after)) continue;
      if (!isDeepStrictEqual(current, change.before)) throw new Error("Review state changed in another tab. Keep your draft text and reload before retrying.");
      if (change.after.present) defineOwn(target, key, change.after.value);
      else delete target[key];
      changed = true;
    }
    const { comments, replyDrafts, editor } = record.state;
    const compose = isRecord(editor) ? editor.compose : undefined;
    if (record.remote && ((Array.isArray(comments) && comments.some((note) => isRecord(note) && note.mode === "feedback")) ||
      (Array.isArray(replyDrafts) && replyDrafts.length) || (isRecord(compose) && compose.mode === "feedback") || (isRecord(editor) && editor.replyTo))) {
      throw new Error("Remote reviews support personal notes only.");
    }
    for (const attachmentId of attachmentIds(record.state)) {
      if (!previousAttachments.has(attachmentId) && !fs.existsSync(path.join(reviewDirectory(id), "attachments", attachmentId, "metadata.json"))) throw new Error("Attachment content was removed. Upload the file again before saving.");
    }
    const snapshots = approvalSnapshotIds(record.state);
    for (const snapshotId of snapshots) {
      if (!previousSnapshots.has(snapshotId) && !fs.existsSync(path.join(reviewDirectory(id), "snapshots", snapshotId + ".json"))) throw new Error("Approved content is unavailable. Re-approve the file before saving.");
    }
    if (changes.length) {
      if (changed) {
        record.stateRevision += 1;
        if (saveId) record.lastSaveId = saveId;
        else delete record.lastSaveId;
      }
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
function approvalSnapshotIds(state: JsonRecord): Set<string> {
  const approvals = isRecord(state.approvals) ? Object.values(state.approvals) : [];
  return new Set(approvals.map((record) => stringField(record, "snapshotId")).filter((id): id is string => id !== undefined && /^[a-f0-9]{32}$/.test(id)));
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
  return fs.readdirSync(directory).filter(isReviewId).flatMap((id) => {
    if (hasPendingDeletion(id)) return [];
    try { return [readReview(id)]; }
    catch (error) {
      if (!fs.existsSync(path.join(reviewDirectory(id), "review.json"))) return [];
      throw error;
    }
  });
}

/** View preferences and opening an empty editor do not count as review edits. */
function reviewActivity(state: JsonRecord) {
  const editor = isRecord(state.editor) ? state.editor : {};
  const compose = isRecord(editor.compose) ? editor.compose : {};
  return { approvals: state.approvals || {}, insightReviews: state.insightReviews || {}, comments: state.comments || [], replyDrafts: state.replyDrafts || [],
    message: compose.body || "", reply: editor.replyDraft || "",
    messageAttachments: compose.attachments || [], replyAttachments: editor.replyAttachments || [] };
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
