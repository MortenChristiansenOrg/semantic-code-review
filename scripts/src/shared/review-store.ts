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
export function withReviewLock<T>(id: string, operation: () => T): T {
  const locks = path.join(reviewHome(), "locks");
  fs.mkdirSync(locks, { recursive: true, mode: 0o700 });
  const lock = path.join(locks, path.basename(reviewDirectory(id)) + ".lock");
  const deadline = Date.now() + 10_000;
  while (true) {
    let acquired = false;
    try {
      fs.mkdirSync(lock);
      acquired = true;
      fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid }));
      break;
    } catch (error) {
      if (acquired) {
        // Initialization failed before the normal release path was installed.
        try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* Preserve the original write error. */ }
        throw error;
      }
      if (error.code !== "EEXIST") throw error;
      // Serialize crash recovery too: two waiters must not both remove a
      // dead owner's directory after one of them has acquired the new lock.
      const reaper = lock + ".reap";
      let reaping = false;
      try {
        fs.mkdirSync(reaper); reaping = true;
        const { pid } = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8"));
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); }
          catch (e) { if (e.code === "ESRCH") fs.rmSync(lock, { recursive: true, force: true }); }
        }
      } catch { /* Another reaper or an owner still initializing: retry. */ }
      finally { if (reaping) fs.rmdirSync(reaper); }
      if (Date.now() >= deadline) throw new Error("Review data is busy. Retry the operation.");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { return operation(); }
  finally { fs.rmSync(lock, { recursive: true, force: true }); }
}
export type ReviewRecord = {
  id: string; generation: string; repositoryRoot: string; implementationId: string;
  title: string; createdAt: string; updatedAt: string; completedAt: string | null;
  state: Record<string, any>;
  viewer?: { port: number; processId: number; viewerVersion: string; skillDirectory: string };
};
export function readReview(id: string): ReviewRecord {
  try { return JSON.parse(fs.readFileSync(path.join(reviewDirectory(id), "review.json"), "utf8")); }
  catch (error) { if (error.code === "ENOENT") throw new Error("Review data is unavailable or was deleted. Reopen the review explicitly."); throw error; }
}
export function registerReview(root: string, implementationId: string, title: string): ReviewRecord {
  root = fs.realpathSync(root);
  const id = reviewId(root, implementationId);
  return withReviewLock(id, () => {
    const directory = reviewDirectory(id);
    const file = path.join(directory, "review.json");
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
    if (changes.length) {
      record.updatedAt = new Date().toISOString();
      atomicJson(path.join(reviewDirectory(id), "review.json"), record);
    }
    return record;
  });
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
    try { return [readReview(id)]; }
    catch (error) {
      if (!fs.existsSync(path.join(reviewDirectory(id), "review.json"))) return [];
      throw error;
    }
  });
}
