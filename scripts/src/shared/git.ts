import { execFileSync, spawnSync } from "node:child_process";
import process from "node:process";
import { fail } from "./errors.js";

export interface GitOptions {
  cwd?: string;
  allowFailure?: boolean;
  encoding?: BufferEncoding | "buffer";
}

export interface GitRawOptions extends GitOptions {
  input?: string | Uint8Array;
  env?: NodeJS.ProcessEnv;
}

export function git(
  args: string[],
  {
    cwd,
    allowFailure = false,
    encoding = "utf8",
  }: GitOptions = {},
): any {
  try {
    const output = execFileSync("git", args, {
      cwd,
      encoding,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return typeof output === "string" ? output.trim() : output;
  } catch (error) {
    if (allowFailure) {
      return null;
    }
    const detail = (error as NodeJS.ErrnoException & { stderr?: Buffer })
      .stderr?.toString()
      .trim();
    fail(`git ${args.join(" ")} failed${detail ? `: ${detail}` : "."}`);
  }
}

export function gitRaw(
  args: string[],
  {
    cwd,
    input,
    env = {},
    allowFailure = false,
    encoding = "utf8",
  }: GitRawOptions = {},
): any {
  const result = spawnSync("git", args, {
    cwd,
    input,
    encoding,
    env: {
      ...process.env,
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    if (allowFailure) {
      return null;
    }
    const detail = result.stderr?.toString().trim();
    fail(`git ${args.join(" ")} failed${detail ? `: ${detail}` : "."}`);
  }
  return typeof result.stdout === "string"
    ? result.stdout.trim()
    : result.stdout;
}
