/** Narrowing helpers for small, schema-less JSON values such as process
 * markers, review records and command output. Documents with a schema go
 * through schema-validation.ts instead. */

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** The string at key, or undefined when absent or not a string. */
export function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

/** The finite number at key, or undefined when absent or not a number. */
export function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

/** The boolean at key, or undefined when absent or not a boolean. */
export function booleanField(value: unknown, key: string): boolean | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "boolean" ? field : undefined;
}

/** Error code of a thrown Node.js system error, if any. */
export function errorCode(error: unknown): string | undefined {
  return stringField(error, "code");
}

/** A thrown value's message, whether or not it is an Error. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Exit status attached to an execFileSync failure, if any. */
export function exitStatus(error: unknown): number | undefined {
  return numberField(error, "status");
}

/** Captured output stream (stdout or stderr) attached to an execFileSync failure, if any. */
export function capturedOutput(error: unknown, stream: "stdout" | "stderr"): string | Buffer | undefined {
  if (!isRecord(error)) return undefined;
  const output = error[stream];
  return typeof output === "string" || Buffer.isBuffer(output) ? output : undefined;
}

/** A thrown Node.js system error, or undefined for any other thrown value. */
export function systemError(error: unknown): NodeJS.ErrnoException | undefined {
  return error instanceof Error ? error : undefined;
}
