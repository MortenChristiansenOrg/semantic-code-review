/** User-local review storage. All writes hold a per-review lock and replace one
 * document atomically; private data is never placed in implementation branches. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { jsonBytes, parseJson, replaceFile } from "./json.js";
import { activeImplementationId, ArtifactDraft, hasFile, readArtifact, readArtifactDirectory, readArtifactJson, readActiveArtifactInGitDirectory, replaceArtifactFileInGitDirectory, type ArtifactFiles, type ArtifactSnapshot } from "./artifact-store.js";
import { gitRaw } from "./git.js";
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
const slug = (value: string, limit: number, fallback: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, limit).replace(/-+$/g, "") || fallback;
/** A fresh random review ID. The readable labels aid manual browsing; the
 * random part alone identifies the review. */
export function newReviewId(repositoryName: string, label: string) {
  return `${slug(repositoryName, 24, "repository")}--${slug(label, 40, "review")}--${randomBytes(32).toString("hex")}`;
}
const unavailable = (message: string) => Object.assign(new Error(message), { code: "REVIEW_TARGET_UNAVAILABLE" });
/** The Git common directory of the repository of root, as an absolute path. */
export function gitCommonDirectory(root: string) {
  return fs.realpathSync(path.resolve(root, gitRaw(["rev-parse", "--git-common-dir"], { cwd: root })));
}
/** The name of the repository whose Git common directory is common: its main
 * worktree's folder name. */
function repositoryName(common: string) {
  return path.basename(common) === ".git" ? path.basename(path.dirname(common)) : path.basename(common).replace(/\.git$/, "");
}
/** The file of an active artifact that names its review. It is private: published
 * and archived artifacts leave it out. */
export const REVIEW_ID_FILE = "review.json";
/** The review ID an artifact stores, if it stores a valid one. */
export function artifactReviewId(files: ArtifactFiles): string | undefined {
  if (!hasFile(files, REVIEW_ID_FILE)) return undefined;
  try {
    const id = stringField(readArtifactJson(files, REVIEW_ID_FILE), "reviewId");
    return id !== undefined && isReviewId(id) ? id : undefined;
  } catch { return undefined; }
}
/** Gives a new artifact of root its review ID. */
export function writeReviewId(draft: ArtifactDraft, root: string, implementationId: string) {
  draft.writeJson(REVIEW_ID_FILE, { reviewId: newReviewId(repositoryName(gitCommonDirectory(root)), implementationId) });
}
/** Commits a fresh review ID into the active artifact of implementationId in the
 * repository whose Git common directory is given, only while the artifact still
 * holds expected: a compare-and-swap, so an ID another writer stored is kept.
 * Git is given the directory explicitly, so no worktree of the repository is
 * needed. Returns whether the ID was replaced. */
function rotateArtifactReviewId(gitDirectory: string, implementationId: string, expected: string, replacement: string): boolean {
  return replaceArtifactFileInGitDirectory(gitDirectory, implementationId, REVIEW_ID_FILE, (files) =>
    artifactReviewId(files) === expected ? jsonBytes({ reviewId: replacement }) : undefined);
}
/** Whether the active artifact of the implementation holds review ID id:
 * "active" when it does, "replaced" when it holds replacement, "other" when it
 * holds another review ID, and "none" when there is no active artifact or it
 * holds no ID (an archived implementation holds none); all but "active" only
 * once the ref is confirmed to still hold what was read. "unconfirmed" when it
 * is not. */
function reviewIdHolder(gitDirectory: string, implementationId: string, id: string, replacement?: string): "active" | "replaced" | "other" | "none" | "unconfirmed" {
  const { active, confirmed } = readActiveArtifactInGitDirectory(gitDirectory, implementationId);
  const stored = active === undefined ? undefined : storedReviewId(active);
  if (stored === id) return "active";
  // A review ID file that cannot be read may hold id.
  if (stored === null || !confirmed()) return "unconfirmed";
  return stored === undefined ? "none" : stored === replacement ? "replaced" : "other";
}
/** The review ID files store: undefined when they have no review ID file, null
 * when it cannot be read or holds no valid ID, since it may still name a review. */
function storedReviewId(files: ArtifactFiles): string | null | undefined {
  if (!hasFile(files, REVIEW_ID_FILE)) return undefined;
  return artifactReviewId(files) ?? null;
}
/** Gives the implementation the review ID replacement in place of id: stored it,
 * or did not, because the ref kept changing, or the repository holds no snapshot
 * with id. That repository may be another one at a moved repository's old
 * location, so it does not show that id is retired. */
function replaceReviewId(gitDirectory: string, implementationId: string, id: string, replacement = newReviewId(repositoryName(gitDirectory), implementationId)): "rotated" | "unconfirmed" {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (rotateArtifactReviewId(gitDirectory, implementationId, id, replacement)) return "rotated";
    const holder = reviewIdHolder(gitDirectory, implementationId, id);
    if (holder !== "active" && holder !== "unconfirmed") return "unconfirmed";
    // The ref changed while it was read: try again.
  }
  return "unconfirmed";
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
  // The review ID is stored in the shared active artifact, so every worktree of
  // the repository, wherever it is, reaches the same review.
  const inactive = () => unavailable(`Implementation ${implementationId} is no longer active, so its review is unavailable.`);
  const snapshot = readArtifact(canonicalRoot, implementationId);
  if (!snapshot) throw inactive();
  const stored = artifactReviewId(snapshot);
  if (stored) return stored;
  // `implementation init` always stores one; reading never assigns one, so a
  // read-only command never writes and every writer sees the same review.
  if (hasFile(snapshot, REVIEW_ID_FILE)) throw new Error(`The review identity of the semantic implementation ${implementationId} is malformed.`);
  throw new Error(`The semantic implementation ${implementationId} has no review identity; it was created by an unreleased development build. Start it again.`);
}
/** Whether the worktree at root still reaches the review: it is a checkout whose
 * repository's active artifact of the implementation holds the review's ID. */
function reachesReview(root: string, implementationId: string, id: string) {
  try {
    // A worktree root always holds .git; without it the directory is no longer a checkout.
    if (!fs.existsSync(path.join(root, ".git"))) return false;
    const snapshot = readArtifact(root, implementationId);
    return snapshot !== undefined && artifactReviewId(snapshot) === id;
  } catch { return false; }
}
/** Updates the locators of a local review that root reaches, when the recorded
 * worktree no longer does. A recorded worktree that still works is kept, so two
 * working worktrees never take the locator from each other. Caller holds the lock. */
function relocate(id: string, root: string): ReviewRecord {
  const record = readReview(id);
  if (record.remote) return record;
  let changed = false;
  if (record.repositoryRoot !== root && !reachesReview(record.repositoryRoot, record.implementationId, id)) {
    record.repositoryRoot = root;
    changed = true;
  }
  if (changed || record.gitCommonDir === undefined || !fs.existsSync(record.gitCommonDir)) {
    const common = gitCommonDirectory(record.repositoryRoot);
    if (record.gitCommonDir !== common) { record.gitCommonDir = common; changed = true; }
  }
  // The repository is reachable again, so a later absence starts a new grace period.
  if (record.missingSince !== undefined) { delete record.missingSince; changed = true; }
  if (changed) atomicJson(path.join(reviewDirectory(id), "review.json"), record);
  return record;
}
/** Records root as the review's location if the recorded one no longer reaches it.
 * Root must reach the review. Does nothing when the review is not registered. */
export function relocateReview(id: string, root: string) {
  root = fs.realpathSync(root);
  const file = path.join(reviewDirectory(id), "review.json");
  if (!fs.existsSync(file)) return;
  const record = readReview(id);
  // Most commands run where the review is recorded; they need no lock.
  if (record.remote || (record.repositoryRoot === root && record.gitCommonDir !== undefined && record.missingSince === undefined)) return;
  withReviewLock(id, () => { if (fs.existsSync(file)) relocate(id, root); });
}
/** What giving a deleted review's implementation a fresh review ID did: stored
 * one, found nothing holding the old ID (a remote review, an implementation that
 * is no longer active, or one already given another ID), could not establish
 * that the old ID is replaced (the ref kept changing), or could not reach the
 * repository at all. */
export type ReviewIdRetirement = "rotated" | "absent" | "unconfirmed" | "unreachable";
/** Gives the implementation of a review being deleted a fresh review ID, so the
 * next review of it starts empty and nothing reaches the deleted one. Git is given
 * the recorded Git common directory, so this works when no worktree of the
 * repository is left, as in a bare repository. Fails when the ID cannot be
 * replaced. Caller holds the review's lock. */
export function retireReviewId(record: ReviewRecord): ReviewIdRetirement {
  if (record.remote) return "absent";
  const gitDirectory = record.gitCommonDir !== undefined && fs.existsSync(record.gitCommonDir) ? record.gitCommonDir : gitCommonDirectoryOf(record.repositoryRoot);
  if (gitDirectory === undefined) return "unreachable";
  // Recorded first: only this ID in the artifact shows that the deletion committed,
  // since an unrelated repository may hold the implementation under another one.
  const replacement = newReviewId(repositoryName(gitDirectory), record.implementationId);
  // Not replaced atomically, which would leave and remove a temporary file in the
  // pending folder: a partly written file names no ID, which proves nothing.
  fs.writeFileSync(replacementFile(record.id), JSON.stringify({ reviewId: replacement }), { mode: 0o600 });
  return replaceReviewId(gitDirectory, record.implementationId, record.id, replacement);
}
/** The file in a pending deletion's folder naming the review ID the deletion
 * stores. It never reaches a live folder: moving the folder back removes it. */
function replacementFile(id: string) {
  return path.join(pendingDeletionDirectory(id), "replacement-review-id.json");
}
/** The Git common directory of a recorded worktree, if it is still a checkout. */
function gitCommonDirectoryOf(root: string): string | undefined {
  // A worktree root always holds .git; without it Git would search the parents.
  if (!fs.existsSync(path.join(root, ".git"))) return undefined;
  try { return gitCommonDirectory(root); } catch { return undefined; }
}
const reviewsDirectory = () => path.join(reviewHome(), "reviews");
/** Folders of committed deletions, which cleanup removes without a lock. */
const DELETED_PREFIX = ".deleted-";
const DELETING_PREFIX = ".deleting-";
/** The folder a deletion moves a review's folder to while it may still roll back.
 * Nothing removes files from it; only once it is renamed to a deleted folder. */
export function pendingDeletionDirectory(id: string) {
  return path.join(reviewsDirectory(), DELETING_PREFIX + path.basename(reviewDirectory(id)));
}
/** Marks a review ID that a deletion retired while it could not reach the
 * repository, so the artifact still holds it. The registration that next finds
 * the ID in the artifact gives the implementation a fresh one and removes the
 * marker. So does a deletion that found no snapshot holding the ID, since the
 * repository it looked in may be another one at a moved repository's location;
 * the marker is also the record that the deletion committed. */
function retiredMarker(id: string) {
  return path.join(reviewsDirectory(), ".retired-" + path.basename(reviewDirectory(id)));
}
/** Records that review ID id is retired although the artifact may still hold it.
 * Caller holds the lock. */
export function markReviewIdRetired(id: string) {
  fs.writeFileSync(retiredMarker(id), "");
}
/** Moves a review's folder to its pending deletion folder in one step. Afterwards
 * nothing reaches the review: its writers fail. Caller holds the lock. */
export function beginReviewDeletion(id: string) {
  fs.renameSync(reviewDirectory(id), pendingDeletionDirectory(id));
}
/** Puts a folder that beginReviewDeletion moved back. Caller holds the lock. */
export function rollBackReviewDeletion(id: string) {
  fs.rmSync(replacementFile(id), { force: true });
  fs.renameSync(pendingDeletionDirectory(id), reviewDirectory(id));
}
/** Completes a deletion that can no longer roll back: its pending folder becomes
 * a deleted one and is removed. Files are removed only under the deleted name, so
 * a folder that cannot be renamed now keeps its pending name, and cleanup
 * completes the deletion later. Caller holds the lock. */
export function completeReviewDeletion(id: string) {
  const deleted = path.join(reviewsDirectory(), DELETED_PREFIX + randomUUID());
  try { fs.renameSync(pendingDeletionDirectory(id), deleted); }
  catch { return; }
  try { fs.rmSync(deleted, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  catch { /* A later cleanup removes it. */ }
}
/** Whether the deletion of id that left its folder under the pending name
 * committed. Only positive evidence counts: the deletion marked the ID retired,
 * the implementation's active artifact holds another review ID, or the review's
 * repository has been missing for ORPHAN_GRACE_MS. A deletion of a remote review
 * commits once it starts, since nothing holds its ID. A missing implementation,
 * a missing active artifact or an unrelated repository at the recorded location
 * proves nothing, since the repository may have moved: "unknown", as while the
 * repository cannot be reached. A worktree
 * found to hold the ID, when given, proves the deletion did not commit. The
 * first cleanup that finds the recorded Git directory missing records when, as
 * for any review. */
function interruptedDeletionOutcome(id: string, holdingRoot?: string): "committed" | "uncommitted" | "unknown" {
  if (fs.existsSync(retiredMarker(id))) return "committed";
  let record: ReviewRecord, replacement: string | undefined;
  const file = path.join(pendingDeletionDirectory(id), "review.json");
  try { record = parseReviewRecord(parseJson(fs.readFileSync(file, "utf8")), file); }
  catch { return "unknown"; }
  // Absent when the deletion stopped before it could store a new ID.
  try { replacement = stringField(parseJson(fs.readFileSync(replacementFile(id), "utf8")), "reviewId"); }
  catch { replacement = undefined; }
  if (record.id !== id) return "unknown";
  if (record.remote) return "committed";
  // Registration read, under the review's lock, that this worktree's active
  // artifact holds the ID. A deletion commits only by replacing that ID, under
  // the same lock, so it did not commit, however long the recorded location has
  // been gone. Moving the folder back loses nothing even if the implementation is
  // archived right after: its review then remains like any archived one's.
  // The grace period starts over first, so a crash before registration records
  // the new location cannot let cleanup count the old location's absence.
  if (holdingRoot !== undefined) {
    if (record.missingSince !== undefined) {
      const { missingSince: _cleared, ...current } = record;
      try { atomicJson(file, current); }
      catch { return "unknown"; }
    }
    return "uncommitted";
  }
  const presence = repositoryPresence(record);
  if (presence === "missing" && missingLongEnough(record)) return "committed";
  try {
    // Best effort: a later recovery records it when this one cannot.
    if (presence === "missing" && record.missingSince === undefined) {
      atomicJson(file, { ...record, missingSince: new Date().toISOString() });
    } else if (presence === "present" && record.missingSince !== undefined) {
      const { missingSince: _cleared, ...current } = record;
      atomicJson(file, current);
    }
  } catch { /* See above. */ }
  const gitDirectory = record.gitCommonDir !== undefined && fs.existsSync(record.gitCommonDir) ? record.gitCommonDir : gitCommonDirectoryOf(record.repositoryRoot);
  if (gitDirectory === undefined) return "unknown";
  try {
    // Only the ID this deletion stored proves that it committed.
    const holder = reviewIdHolder(gitDirectory, record.implementationId, id, replacement);
    return holder === "active" ? "uncommitted" : holder === "replaced" && replacement !== undefined ? "committed" : "unknown";
  } catch { return "unknown"; }
}
/** Settles a deletion of id that a crash interrupted, before anything else uses
 * the ID, by what the repository records: one that committed is completed, one
 * whose implementation still holds the ID is rolled back, and one that cannot be
 * told yet keeps its pending folder. holdingRoot is a worktree whose active
 * artifact the caller found, under the lock, to hold id. Caller holds the lock. */
export function recoverInterruptedDeletion(id: string, holdingRoot?: string) {
  if (!fs.existsSync(pendingDeletionDirectory(id)) || fs.existsSync(reviewDirectory(id))) return;
  const outcome = interruptedDeletionOutcome(id, holdingRoot);
  if (outcome === "committed") completeReviewDeletion(id);
  else if (outcome === "uncommitted") rollBackReviewDeletion(id);
}
/** Whether an interrupted deletion of id still holds its folder under the pending name. */
export function reviewDeletionPending(id: string) {
  return fs.existsSync(pendingDeletionDirectory(id));
}
/** Whether review id is gone for good, rather than moved aside by a deletion that
 * may still roll back. Never waits for the review's lock: a busy lock may be a
 * deletion in progress, so it is not confirmed and the caller asks again later.
 * False when that cannot be told now. */
export function reviewDeletionConfirmed(id: string): boolean {
  try { return withReviewLock(id, () => pathMissing(path.join(reviewDirectory(id), "review.json")) && pathMissing(pendingDeletionDirectory(id)), { wait: false }); }
  catch { return false; }
}
/** Whether file is known to be missing. Fails when that cannot be told, for
 * example for lack of permission, which says nothing about whether it exists. */
export function pathMissing(file: string): boolean {
  try { fs.lstatSync(file); return false; }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(errorCode(error) ?? "")) return true;
    throw error;
  }
}
/** How long the Git directory of a local review must have been missing before
 * cleanup removes the review. A repository on an unmounted drive, or one moved
 * together with its Git directory, is missing too; the review stays until a
 * command runs from it again. */
export const ORPHAN_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
/** Removes local reviews whose repository's Git directory has been missing for
 * ORPHAN_GRACE_MS, and folders of committed deletions, and settles interrupted
 * deletions. The first cleanup that
 * finds a Git directory missing records when; one that finds it again clears
 * that. A review whose repository exists stays, even when its implementation was
 * archived or discarded, so its feedback can still be read. The review named by
 * keep, and every review whose lock is busy, is left alone. */
export function removeOrphanedReviews(keep?: string) {
  // Taking other reviews' locks while holding one could wait on a process that waits on this one.
  if (heldLocks.size) return;
  const directory = reviewsDirectory();
  let names: string[];
  try { names = fs.readdirSync(directory); } catch { return; }
  for (const name of names) {
    try {
      if (name.startsWith(DELETED_PREFIX)) { fs.rmSync(path.join(directory, name), { recursive: true, force: true }); continue; }
      if (name.startsWith(DELETING_PREFIX)) {
        // An interrupted deletion is settled by what the repository records.
        const id = name.slice(DELETING_PREFIX.length);
        if (isReviewId(id)) withReviewLock(id, () => recoverInterruptedDeletion(id), { wait: false });
        continue;
      }
      if (name === keep || !isReviewId(name)) continue;
      const seen = readReview(name), presence = repositoryPresence(seen);
      // Most reviews need no change, so no lock.
      const changes = presence === "present" ? seen.missingSince !== undefined
        : presence === "missing" && (seen.missingSince === undefined || missingLongEnough(seen));
      if (!changes) continue;
      // One review lock at a time, and never waiting for a busy one.
      withReviewLock(name, () => {
        if (!fs.existsSync(path.join(reviewDirectory(name), "review.json"))) return;
        const record = readReview(name), current = repositoryPresence(record);
        if (current === "present" && record.missingSince !== undefined) {
          delete record.missingSince;
          atomicJson(path.join(reviewDirectory(name), "review.json"), record);
        } else if (current === "missing" && record.missingSince === undefined) {
          record.missingSince = new Date().toISOString();
          atomicJson(path.join(reviewDirectory(name), "review.json"), record);
        } else if (current === "missing" && missingLongEnough(record)) {
          beginReviewDeletion(name);
          completeReviewDeletion(name);
        }
      }, { wait: false });
    } catch { /* Unreadable or busy reviews stay; a later cleanup tries again. */ }
  }
}
/** Whether a local review's Git directory exists. Only a missing path counts as
 * missing; any other failure, such as a denied permission, tells nothing. */
function repositoryPresence(record: ReviewRecord): "present" | "missing" | "unknown" {
  if (record.remote || record.gitCommonDir === undefined) return "unknown";
  try { fs.statSync(record.gitCommonDir); return "present"; }
  catch (error) { return ["ENOENT", "ENOTDIR"].includes(errorCode(error) ?? "") ? "missing" : "unknown"; }
}
function missingLongEnough(record: ReviewRecord) {
  const since = Date.parse(record.missingSince ?? "");
  return Number.isFinite(since) && Date.now() - since >= ORPHAN_GRACE_MS;
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
    // Any tracked file inside means the checked-out branch owns the folder; the
    // match ignores case, as the file system may.
    const tracked = spawnSync("git", ["ls-files", "--", ":(icase).semantic-review"], { cwd: root, encoding: "utf8", windowsHide: true });
    if (tracked.status !== 0 || tracked.stdout.trim()) return;
    try { fs.renameSync(legacy, directory); } catch { /* It stays unavailable until reopened. */ }
  });
}
/** The artifact a review of root shows: the projection a remote review made for
 * its managed checkout, or else the active artifact of root. */
export function readReviewArtifact(root: string, implementationId?: string): { files: ArtifactSnapshot; projection: boolean } | undefined {
  const owner = managedCheckoutOwner(root);
  if (owner !== undefined) {
    // A managed checkout shows only its review's projection, never files in the checkout.
    const directory = projectionDirectory(owner);
    if (!fs.existsSync(directory)) moveLegacyProjection(owner, root, directory);
    const projection = readArtifactDirectory(root, directory);
    return projection && { files: projection, projection: true };
  }
  const active = readArtifact(root, implementationId);
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
    replaceFile(temporary, file);
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
/** Reentrant within one process, so a locked operation can call another locked
 * helper. Without wait, fails at once when another process holds the lock. */
export function withReviewLock<T>(id: string, operation: () => T, { wait = true }: { wait?: boolean } = {}): T {
  const key = path.join(reviewHome(), id);
  if (heldLocks.has(key)) return operation();
  return acquireReviewLock(id, wait ? 10_000 : 0, () => {
    heldLocks.add(key);
    try { return operation(); }
    finally { heldLocks.delete(key); }
  });
}
function acquireReviewLock<T>(id: string, waitMs: number, operation: () => T): T {
  const locks = path.join(reviewHome(), "locks");
  fs.mkdirSync(locks, { recursive: true, mode: 0o700 });
  const lock = path.join(locks, path.basename(reviewDirectory(id)) + ".lock");
  const deadline = Date.now() + waitMs;
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
/** A remote review is found again by the remote URL and branch it reviews. */
export type RemoteReview = { sourceRoot: string; remoteName: string; branch: string; targetBranch: string; headRevision?: string; refreshedAt?: string };
export type ViewerRecord = { port: number; processId: number; viewerVersion: string; skillDirectory: string };
export type ReviewRecord = {
  id: string; generation: string;
  /** Locates the review's repository: a worktree that reaches it, and the
   * repository's Git common directory. Updated when the worktree moves. */
  repositoryRoot: string; gitCommonDir?: string; implementationId: string;
  /** When cleanup first found the Git common directory missing; cleared once it is found again. */
  missingSince?: string;
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
  const { id, generation, repositoryRoot, gitCommonDir, missingSince, implementationId, createdAt, remote, viewer, lastSaveId } = value;
  // Older viewers could save a record without a title, lifecycle or state; those keep their defaults.
  const { title = "", updatedAt = createdAt, completedAt = null, state = {}, stateRevision = 0 } = value;
  if (typeof id !== "string" || typeof generation !== "string" || typeof repositoryRoot !== "string" || typeof implementationId !== "string" ||
    typeof title !== "string" || typeof createdAt !== "string" || typeof updatedAt !== "string" ||
    (completedAt !== null && typeof completedAt !== "string") || !isRecord(state) ||
    typeof stateRevision !== "number" || !Number.isSafeInteger(stateRevision) || stateRevision < 0 ||
    (lastSaveId !== undefined && typeof lastSaveId !== "string") || (gitCommonDir !== undefined && typeof gitCommonDir !== "string") ||
    (missingSince !== undefined && typeof missingSince !== "string")) throw invalid();
  const record: ReviewRecord = { id, generation, repositoryRoot, implementationId, title, createdAt, updatedAt, completedAt, state, stateRevision };
  if (gitCommonDir !== undefined) record.gitCommonDir = gitCommonDir;
  if (missingSince !== undefined) record.missingSince = missingSince;
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
    return parseReviewRecord(parseJson(fs.readFileSync(file, "utf8")), file);
  }
  catch (error) { if (errorCode(error) === "ENOENT") throw Object.assign(new Error("Review data is unavailable or was deleted. Reopen the review explicitly."), { code: "REVIEW_UNAVAILABLE" }); throw error; }
}
/** Registers the review of the implementation that root reaches, or returns the
 * registered one with its locators updated. */
export function registerReview(root: string, implementationId: string, title: string): ReviewRecord {
  root = fs.realpathSync(root);
  let record: ReviewRecord | undefined;
  for (let attempt = 0; !record; attempt++) {
    if (attempt >= 5) throw new Error(`The review of the semantic implementation ${implementationId} changed repeatedly while it was being opened. Retry the command.`);
    const id = reviewId(root, implementationId);
    record = withReviewLock(id, () => {
      // A deletion that held this lock gave the implementation a new review ID;
      // registering the old one would recreate the deleted review.
      if (reviewId(root, implementationId) !== id) return undefined;
      recoverInterruptedDeletion(id, root);
      if (fs.existsSync(retiredMarker(id))) {
        // A deletion retired this ID while it could not reach the repository. The
        // repository is reachable now: store a fresh ID, then register that one.
        // The marker stays until this stores one. The deletion
        // committed, so a folder it left under the pending name only waits for
        // cleanup to remove it and never blocks the fresh review.
        // While a folder of the deletion waits for cleanup, the marker stays as
        // the evidence that the deletion committed.
        if (replaceReviewId(gitCommonDirectory(root), implementationId, id) === "rotated" && !reviewDeletionPending(id)) fs.rmSync(retiredMarker(id), { force: true });
        return undefined;
      }
      // Its data would otherwise be shadowed by a new, empty review of the same ID.
      if (reviewDeletionPending(id) && !fs.existsSync(path.join(reviewDirectory(id), "review.json"))) {
        throw new Error(`An interrupted deletion of the review of ${implementationId} cannot be settled yet: its refs changed while they were read. Retry the command.`);
      }
      const directory = reviewDirectory(id);
      const file = path.join(directory, "review.json");
      if (fs.existsSync(file)) return relocate(id, root);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      // Children are owned by this review; later features can remove unreferenced
      // blobs without touching repository files. Locks live outside this directory.
      for (const child of ["feedback", "attachments", "snapshots"]) fs.mkdirSync(path.join(directory, child), { recursive: true });
      const now = new Date().toISOString();
      const created: ReviewRecord = { id, generation: randomUUID(), repositoryRoot: root, gitCommonDir: gitCommonDirectory(root), implementationId, title, createdAt: now, updatedAt: now, completedAt: null, state: {}, stateRevision: 0 };
      atomicJson(file, created);
      return created;
    });
  }
  // Only once this review records where it is now. Outside its lock: cleanup takes
  // the locks of the reviews it removes.
  removeOrphanedReviews(record.id);
  return record;
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
