import { constants as bufferConstants } from "node:buffer";
import { capturedOutput, errorCode, isRecord, stringField } from "./narrow.js";

/**
 * Shared limits and failure reporting for synchronous subprocesses.
 *
 * Node buffers captured output of `spawnSync`/`execFileSync` up to
 * `maxBuffer` (1 MiB by default) and kills the child once it is exceeded.
 * Stage patches and other Git output can be far larger, so helpers whose
 * output scales with repository content use this generous ceiling instead.
 * It is capped at the longest string the runtime can create, so text output
 * that fits the buffer can also be decoded.
 */
export const SUBPROCESS_MAX_BUFFER = Math.min(512 * 1024 * 1024, bufferConstants.MAX_STRING_LENGTH);

/**
 * Describes why a synchronous subprocess failed: the spawn error (such as
 * ENOBUFS or ETIMEDOUT), the terminating signal and the captured stderr.
 * Accepts both a `spawnSync` result and an error thrown by `execFileSync`.
 */
export function processFailureDetail(failure: unknown): string {
  const thrown = failure instanceof Error;
  const error = thrown
    ? failure
    : isRecord(failure) && failure.error instanceof Error
      ? failure.error
      : undefined;
  const code = errorCode(error);
  const reasons: string[] = [];
  if (code === "ENOBUFS") {
    reasons.push("output exceeded the maximum buffer size (ENOBUFS)");
  } else if (error && (code || !thrown)) {
    // A thrown non-zero exit only says "Command failed"; stderr explains it.
    reasons.push(error.message);
  }
  const signal = stringField(failure, "signal");
  if (signal && code !== "ENOBUFS") {
    reasons.push(`terminated by signal ${signal}`);
  }
  const stderr = capturedOutput(failure, "stderr")?.toString().trim();
  if (stderr) {
    reasons.push(stderr);
  }
  return reasons.join("; ");
}
