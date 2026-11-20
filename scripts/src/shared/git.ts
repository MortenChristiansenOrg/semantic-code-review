import { execFileSync, spawnSync } from "node:child_process";
import process from "node:process";
import { fail } from "./errors.js";
import { processFailureDetail, SUBPROCESS_MAX_BUFFER } from "./subprocess.js";

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
    env: {
      ...process.env,
      ...env,
    },
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
