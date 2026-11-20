// Narrowing helpers for values the page receives without a guaranteed shape,
// such as the saved review state and stored preferences.
import type { ApiFailure } from "../../scripts/src/shared/viewer-protocol";

export type UnknownRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export const isString = (value: unknown): value is string => typeof value === "string";
export const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
export const isNumber = (value: unknown): value is number => typeof value === "number";

/** A guard that also accepts undefined. */
export function optional<T>(guard: (value: unknown) => value is T): (value: unknown) => value is T | undefined {
  return (value): value is T | undefined => value === undefined || guard(value);
}

/** A guard for one of the given string values. */
export function oneOf<const T extends string>(...values: readonly T[]): (value: unknown) => value is T {
  return (value): value is T => values.some((item) => item === value);
}

/** A guard for an array whose items all pass `guard`. */
export function arrayOf<T>(guard: (value: unknown) => value is T): (value: unknown) => value is T[] {
  return (value): value is T[] => Array.isArray(value) && value.every(guard);
}

/** A thrown value's message, whether or not it is an Error. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The failure a response body reports; nothing for a success body, which a
 * failed HTTP status may still carry. */
export function failureOf(body: { ok: true } | ApiFailure): Partial<ApiFailure> {
  return body.ok ? {} : body;
}
