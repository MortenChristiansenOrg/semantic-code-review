import { execFileSync, spawnSync } from "node:child_process";
import process from "node:process";
import { fail } from "./errors.js";
import { processFailureDetail, SUBPROCESS_MAX_BUFFER } from "./subprocess.js";

/** Git's repository-local variables (`git rev-parse --local-env-vars`, plus the
 * numbered config pairs and the namespace). Git sets them for hooks and for
 * `git rebase --exec`; inherited, they would point the CLI's commands at another
 * repository, worktree or index than the one the CLI selected. */
const REPOSITORY_LOCAL_GIT_VARIABLE = /^GIT_(ALTERNATE_OBJECT_DIRECTORIES|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|OBJECT_DIRECTORY|DIR|WORK_TREE|IMPLICIT_WORK_TREE|GRAFT_FILE|INDEX_FILE|NO_REPLACE_OBJECTS|REPLACE_REF_BASE|PREFIX|SHALLOW_FILE|COMMON_DIR|NAMESPACE)$/i;

/** This process's environment without Git's repository-local variables, with
 * the variables the CLI sets for one command, such as a temporary index, on top. */
export function gitEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (REPOSITORY_LOCAL_GIT_VARIABLE.test(key)) delete env[key];
  }
  return { ...env, ...overrides };
}

/** Removes Git's repository-local variables from this process, so every child
 * process, Git or not, acts on the repository the CLI selects. */
export function isolateGitEnvironment(): void {
  for (const key of Object.keys(process.env)) {
    if (REPOSITORY_LOCAL_GIT_VARIABLE.test(key)) delete process.env[key];
  }
}

export interface GitOptions {
  cwd?: string;
  allowFailure?: boolean;
  encoding?: BufferEncoding | "buffer";
}

export interface GitRawOptions extends GitOptions {
  input?: string | Uint8Array;
  env?: NodeJS.ProcessEnv;
}

/** Options for text output, which is returned trimmed. */
type Text<O extends GitOptions> = O & { encoding?: BufferEncoding };
/** Options for raw byte output. */
type Bytes<O extends GitOptions> = O & { encoding: "buffer" };
/** With allowFailure, a failing command returns null instead of failing. */
type Tolerant<O extends GitOptions> = O & { allowFailure: true };
/** Without allowFailure, a failing command fails, so the result is never null. */
type Strict<O extends GitOptions> = O & { allowFailure?: false };

export function git(args: string[], options: Tolerant<Bytes<GitOptions>>): Buffer | null;
export function git(args: string[], options: Strict<Bytes<GitOptions>>): Buffer;
export function git(args: string[], options: Tolerant<Text<GitOptions>>): string | null;
export function git(args: string[], options?: Strict<Text<GitOptions>>): string;
export function git(args: string[], options: GitOptions): string | Buffer | null;
export function git(
  args: string[],
  {
    cwd,
    allowFailure = false,
    encoding = "utf8",
  }: GitOptions = {},
): string | Buffer | null {
  try {
    const output = execFileSync("git", args, {
      cwd,
      env: gitEnvironment(),
      encoding,
      windowsHide: true,
      maxBuffer: SUBPROCESS_MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return typeof output === "string" ? output.trim() : output;
  } catch (error) {
    if (allowFailure) {
      return null;
    }
    const detail = processFailureDetail(error);
    fail(`git ${args.join(" ")} failed${detail ? `: ${detail}` : "."}`);
  }
}

export function gitRaw(args: string[], options: Tolerant<Bytes<GitRawOptions>>): Buffer | null;
export function gitRaw(args: string[], options: Strict<Bytes<GitRawOptions>>): Buffer;
export function gitRaw(args: string[], options: Tolerant<Text<GitRawOptions>>): string | null;
export function gitRaw(args: string[], options?: Strict<Text<GitRawOptions>>): string;
export function gitRaw(args: string[], options: GitRawOptions): string | Buffer | null;
export function gitRaw(
  args: string[],
  {
    cwd,
    input,
    env = {},
    allowFailure = false,
    encoding = "utf8",
  }: GitRawOptions = {},
): string | Buffer | null {
  const result = spawnSync("git", args, {
    cwd,
    // With buffer output, Node cannot encode a string input itself.
    input: typeof input === "string" ? Buffer.from(input, "utf8") : input,
    encoding,
    windowsHide: true,
    maxBuffer: SUBPROCESS_MAX_BUFFER,
    env: gitEnvironment(env),
    stdio: ["pipe", "pipe", "pipe"],
  });
  // A child that exits before Node kills it on overflow reports status 0
  // together with ENOBUFS and truncated output.
  if (result.error || result.status !== 0) {
    if (allowFailure) {
      return null;
    }
    const detail = processFailureDetail(result);
    fail(`git ${args.join(" ")} failed${detail ? `: ${detail}` : "."}`);
  }
  return typeof result.stdout === "string"
    ? result.stdout.trim()
    : result.stdout;
}
