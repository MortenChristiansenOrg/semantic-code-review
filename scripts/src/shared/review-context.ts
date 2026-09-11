/** Immutable execution context for all viewer-triggered commands. A worker and
 * every queued job keep this context; selection in another tab cannot change it. */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn, type SpawnOptions } from "node:child_process";
import { readReview, reviewId, reviewHome, type ReviewRecord } from "./review-store.js";

export type ReviewContext = Readonly<{
  reviewId: string; generation: string; repositoryRoot: string; implementationId: string;
}>;

/** Git's repository-local environment must not override an explicit worktree. */
export function reviewEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_(ALTERNATE_OBJECT_DIRECTORIES|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|OBJECT_DIRECTORY|DIR|WORK_TREE|IMPLICIT_WORK_TREE|GRAFT_FILE|INDEX_FILE|NO_REPLACE_OBJECTS|REPLACE_REF_BASE|PREFIX|SHALLOW_FILE|COMMON_DIR|NAMESPACE)$/i.test(key)) delete env[key];
  }
  return env;
}
export function captureReviewContext(id: string): ReviewContext {
  const review = readReview(id);
  const context = Object.freeze({ reviewId: id, generation: review.generation, repositoryRoot: review.repositoryRoot, implementationId: review.implementationId });
  assertReviewContext(context);
  return context;
}
export function assertReviewContext(context: ReviewContext): ReviewRecord {
  const review = readReview(context.reviewId);
  if (review.generation !== context.generation || review.repositoryRoot !== context.repositoryRoot || review.implementationId !== context.implementationId) throw new Error("This review session changed or was deleted. Reopen the review.");
  if (!fs.existsSync(context.repositoryRoot) || reviewId(context.repositoryRoot, context.implementationId) !== context.reviewId) throw new Error("The review worktree is unavailable or moved.");
  const manifest = path.join(context.repositoryRoot, ".semantic-review", "manifest.json");
  if (!fs.existsSync(manifest) || JSON.parse(fs.readFileSync(manifest, "utf8")).implementationId !== context.implementationId) throw new Error("The active implementation changed or is unavailable. Reopen the review.");
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
  const env = { ...reviewEnvironment(), SEMANTIC_FLOW_HOME: reviewHome(), SEMANTIC_FLOW_REVIEW_ID: context.reviewId, SEMANTIC_FLOW_REVIEW_GENERATION: context.generation };
  if (options.workingWorktree) {
    const common = (root: string) => fs.realpathSync(path.resolve(root, execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: root, env, encoding: "utf8", windowsHide: true }).trim()));
    if (common(cwd) !== common(context.repositoryRoot)) throw new Error("The command's working worktree belongs to another repository.");
  }
  return execFileSync(executable, args, { cwd, env, input: options.input, encoding: options.encoding === null ? null : options.encoding || "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
}

/** Asynchronous counterpart for launching another registered review service. */
export function spawnReviewCommand(context: ReviewContext, executable: string, args: string[], options: Pick<SpawnOptions, "detached" | "stdio"> & { environment?: NodeJS.ProcessEnv } = {}) {
  assertReviewContext(context);
  return spawn(executable, args, {
    cwd: context.repositoryRoot, detached: options.detached, stdio: options.stdio, windowsHide: true,
    env: { ...reviewEnvironment(), ...options.environment, SEMANTIC_FLOW_HOME: reviewHome(), SEMANTIC_FLOW_REVIEW_ID: context.reviewId, SEMANTIC_FLOW_REVIEW_GENERATION: context.generation },
  });
}
