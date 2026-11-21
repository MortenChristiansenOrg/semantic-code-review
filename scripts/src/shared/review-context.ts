/** Immutable execution context for all viewer-triggered commands. A worker and
 * every queued job keep this context; selection in another tab cannot change it. */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn, type SpawnOptions } from "node:child_process";
import { readReview, readReviewArtifact, remoteProjectionStale, reviewId, reviewHome, type ReviewRecord } from "./review-store.js";
import { SUBPROCESS_MAX_BUFFER } from "./subprocess.js";
import { activeImplementationId } from "./artifact-store.js";
import { errorCode } from "./narrow.js";
import { gitEnvironment, isolateGitEnvironment } from "./git.js";

export type ReviewContext = Readonly<{
  reviewId: string; generation: string; repositoryRoot: string; implementationId: string;
}>;

/** The environment of commands the viewer runs: without Git's repository-local
 * variables, so they act on their explicit worktree. */
export function reviewEnvironment(): NodeJS.ProcessEnv {
  return gitEnvironment();
}

/** Removes Git's repository-local variables from this process, so commands that
 * run in-process target their explicit worktree. */
export const isolateReviewEnvironment = isolateGitEnvironment;
/** How a review check treats the review's artifact. "read" reads it, first
 * making a remote review's projection again where an interrupted refresh left
 * it unusable; "unbuilt" reads it as it is and accepts a projection such a
 * refresh left missing without making it, which opening the review does; "skip"
 * reads no artifact and checks only the review's identity, for a refresh that
 * makes the projection anyway. */
export type ArtifactCheck = "read" | "unbuilt" | "skip";
export function captureReviewContext(id: string, artifactCheck: ArtifactCheck = "read"): ReviewContext {
  const review = readReview(id);
  const context = Object.freeze({ reviewId: id, generation: review.generation, repositoryRoot: review.repositoryRoot, implementationId: review.implementationId });
  assertReviewContext(context, artifactCheck);
  return context;
}
export function assertReviewContext(context: ReviewContext, artifactCheck: ArtifactCheck = "read"): ReviewRecord {
  const review = readReview(context.reviewId);
  if (review.generation !== context.generation || review.repositoryRoot !== context.repositoryRoot || review.implementationId !== context.implementationId) throw new Error("This review session changed or was deleted. Reopen the review.");
  try {
    // A worktree root always holds .git; without it the directory is no longer a checkout.
    if (!fs.existsSync(path.join(context.repositoryRoot, ".git"))) throw Object.assign(new Error("The review worktree or implementation is unavailable."), { code: "REVIEW_TARGET_UNAVAILABLE" });
    // The implementation's artifact names its review; a deleted review's ID was replaced there.
    if (reviewId(context.repositoryRoot, context.implementationId) !== context.reviewId) throw Object.assign(new Error("The implementation has another review now. Reopen the review."), { code: "REVIEW_TARGET_UNAVAILABLE" });
    if (artifactCheck === "skip") return review;
    const artifact = readReviewArtifact(context.repositoryRoot, context.implementationId, { rebuild: artifactCheck === "read" });
    // Opening makes a projection that an interrupted refresh left missing.
    if (!artifact && artifactCheck === "unbuilt" && remoteProjectionStale(context.repositoryRoot)) return review;
    if (!artifact) throw Object.assign(new Error("The review worktree or implementation is unavailable."), { code: "REVIEW_TARGET_UNAVAILABLE" });
    if (activeImplementationId(context.repositoryRoot, artifact.files) !== context.implementationId) throw Object.assign(new Error("The active implementation changed. Reopen the review."), { code: "REVIEW_TARGET_UNAVAILABLE" });
  } catch (error) {
    if (errorCode(error) === "ENOENT") throw Object.assign(new Error("The review worktree or implementation is unavailable."), { code: "REVIEW_TARGET_UNAVAILABLE" });
    throw error;
  }
  return review;
}

/** Internal command runner; executable/args are selected by server handlers,
 * never by a general-purpose shell endpoint. Future viewer CLI actions use this. */
type ReviewCommandOptions = { input?: string; workingWorktree?: string };
export function runReviewCommand(context: ReviewContext, executable: string, args: string[], options: ReviewCommandOptions & { encoding: null }): Buffer;
export function runReviewCommand(context: ReviewContext, executable: string, args: string[], options?: ReviewCommandOptions & { encoding?: BufferEncoding }): string;
export function runReviewCommand(context: ReviewContext, executable: string, args: string[], options: ReviewCommandOptions & { encoding?: BufferEncoding | null } = {}): string | Buffer {
  assertReviewContext(context);
  const cwd = options.workingWorktree ? fs.realpathSync(options.workingWorktree) : context.repositoryRoot;
  const env = { ...reviewEnvironment(), SEMANTIC_FLOW_HOME: reviewHome() };
  if (options.workingWorktree) {
    const common = (root: string) => fs.realpathSync(path.resolve(root, execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: root, env, encoding: "utf8", windowsHide: true }).trim()));
    if (common(cwd) !== common(context.repositoryRoot)) throw new Error("The command's working worktree belongs to another repository.");
  }
  return execFileSync(executable, args, { cwd, env, input: options.input, encoding: options.encoding === null ? null : options.encoding || "utf8", windowsHide: true, maxBuffer: SUBPROCESS_MAX_BUFFER });
}

/** Asynchronous counterpart for launching another registered review service. */
export function spawnReviewCommand(context: ReviewContext, executable: string, args: string[],
  options: Pick<SpawnOptions, "detached" | "stdio"> & { environment?: NodeJS.ProcessEnv; artifactCheck?: ArtifactCheck } = {}) {
  assertReviewContext(context, options.artifactCheck);
  return spawn(executable, args, {
    cwd: context.repositoryRoot, detached: options.detached, stdio: options.stdio, windowsHide: true,
    env: { ...reviewEnvironment(), ...options.environment, SEMANTIC_FLOW_HOME: reviewHome() },
  });
}
