/** Immutable execution context for all viewer-triggered commands. A worker and
 * every queued job keep this context; selection in another tab cannot change it. */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn, type SpawnOptions } from "node:child_process";
import { readReview, reviewId, reviewHome, type ReviewRecord } from "./review-store.js";
import { SUBPROCESS_MAX_BUFFER } from "./subprocess.js";
import { parseJson } from "./json.js";
import { errorCode, stringField } from "./narrow.js";

export type ReviewContext = Readonly<{
  reviewId: string; generation: string; repositoryRoot: string; implementationId: string;
}>;

/** Git's repository-local environment must not override an explicit worktree. */
const REPOSITORY_LOCAL_GIT_VARIABLE = /^GIT_(ALTERNATE_OBJECT_DIRECTORIES|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|OBJECT_DIRECTORY|DIR|WORK_TREE|IMPLICIT_WORK_TREE|GRAFT_FILE|INDEX_FILE|NO_REPLACE_OBJECTS|REPLACE_REF_BASE|PREFIX|SHALLOW_FILE|COMMON_DIR|NAMESPACE)$/i;

export function reviewEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (REPOSITORY_LOCAL_GIT_VARIABLE.test(key)) delete env[key];
  }
  return env;
}

/** Removes Git's repository-local variables from this process, so commands that
 * run in-process target their explicit worktree. Only the viewer server, a
 * process of its own, does this. */
export function isolateReviewEnvironment(): void {
  for (const key of Object.keys(process.env)) {
    if (REPOSITORY_LOCAL_GIT_VARIABLE.test(key)) delete process.env[key];
  }
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
  try {
    if (reviewId(context.repositoryRoot, context.implementationId) !== context.reviewId) throw Object.assign(new Error("The review worktree moved."), { code: "REVIEW_TARGET_UNAVAILABLE" });
    const manifest = path.join(context.repositoryRoot, ".semantic-review", "manifest.json");
    if (stringField(parseJson(fs.readFileSync(manifest, "utf8")), "implementationId") !== context.implementationId) throw Object.assign(new Error("The active implementation changed. Reopen the review."), { code: "REVIEW_TARGET_UNAVAILABLE" });
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
export function spawnReviewCommand(context: ReviewContext, executable: string, args: string[], options: Pick<SpawnOptions, "detached" | "stdio"> & { environment?: NodeJS.ProcessEnv } = {}) {
  assertReviewContext(context);
  return spawn(executable, args, {
    cwd: context.repositoryRoot, detached: options.detached, stdio: options.stdio, windowsHide: true,
    env: { ...reviewEnvironment(), ...options.environment, SEMANTIC_FLOW_HOME: reviewHome() },
  });
}
