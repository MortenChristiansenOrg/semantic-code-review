import fs from "node:fs";
import path from "node:path";
import { fail } from "./errors.js";
import { parseJson, withoutByteOrderMark } from "./json.js";
import { errorMessage, isRecord } from "./narrow.js";

export type OptionValue = string | true;
export type Options = Map<string, OptionValue[]>;

export interface ParsedArguments {
  positionals: string[];
  options: Options;
}

export interface OptionSettings {
  required?: boolean;
  defaultValue?: string;
}

function inputOptionName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

function inputOptionValues(name: string, value: unknown): OptionValue[] {
  const structuredOptions = new Set(["threads", "replies", "items"]);
  if (name === "attachments" && Array.isArray(value) && value.every((id) => typeof id === "string")) return value;
  if (value === true) {
    return [true];
  }
  if (typeof value === "string") {
    return [value];
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return [String(value)];
  }
  // A batch is one value, also when its items wrongly are strings or numbers.
  if (structuredOptions.has(name) && Array.isArray(value)) return [JSON.stringify(value)];
  if (Array.isArray(value) && value.length > 0) {
    if (value.every((item) => typeof item === "string")) {
      return value;
    }
    if (
      value.every(
        (item) => typeof item === "number" && Number.isFinite(item),
      )
    ) {
      return value.map(String);
    }
    fail(
      `Input option ${name} arrays may contain only strings or finite numbers.`,
    );
  }
  if (structuredOptions.has(name) && value && typeof value === "object") {
    return [JSON.stringify(value)];
  }
  fail(
    `Input option ${name} must be a string, finite number, true, or a non-empty array of strings or numbers.`,
  );
}

export function parseArguments(values: string[]): ParsedArguments {
  const positionals: string[] = [];
  const options: Options = new Map();

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }

    const separator = value.indexOf("=");
    let name: string;
    let optionValue: OptionValue;
    if (separator > 2) {
      name = value.slice(2, separator);
      optionValue = value.slice(separator + 1);
    } else {
      name = value.slice(2);
      const next = values[index + 1];
      if (next === undefined || next.startsWith("--")) {
        optionValue = true;
      } else {
        optionValue = next;
        index += 1;
      }
    }

    const existing = options.get(name) ?? [];
    existing.push(optionValue);
    options.set(name, existing);
  }

  return { positionals, options };
}

/** Reads the options of --input. Every key is checked against the command's
 * options before any value is converted, so a wrong key is never reported as a wrong value. */
export function expandInputOptions(
  options: Options,
  cwd: string,
  allowedFor: (kind: string | undefined) => ReadonlySet<string>,
): Options {
  const input = option(options, "input");
  if (!input) {
    return options;
  }

  const file = input === "-" ? "standard input" : path.resolve(cwd, input);
  let value: unknown;
  try {
    value = parseJson(withoutByteOrderMark(
      input === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(file, "utf8"),
    ));
  } catch (error) {
    fail(`Could not read JSON input ${file}: ${errorMessage(error)}`);
  }
  if (!isRecord(value)) {
    fail(`JSON input ${file} must contain one object.`);
  }

  const expanded: Options = new Map(options);
  expanded.delete("input");
  const keys = Object.keys(value);
  for (const name of keys.map(inputOptionName)) {
    if (name === "input" || name === "help") {
      fail(`JSON input may not set --${name}.`);
    }
  }
  const given = options.get("kind")?.[0];
  const allowed = allowedFor(typeof given === "string" ? given : inputKind(value));
  assertKnownKeys(keys, allowed, `JSON input ${file}`, inputOptionName);
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = inputOptionName(rawName);
    if (!options.has(name) && expanded.has(name)) {
      fail(`JSON input ${file}: Duplicate input option ${name}.`);
    }
    if (options.has(name)) {
      fail(
        `Option --${name} is set both on the command line and in ${file}.`,
      );
    }
    expanded.set(name, inputOptionValues(name, rawValue));
  }
  return expanded;
}

export function option(options: Options, name: string, settings: OptionSettings & { required: true }): string;
export function option(options: Options, name: string, settings: OptionSettings & { defaultValue: string }): string;
export function option(options: Options, name: string, settings?: OptionSettings): string | undefined;
export function option(
  options: Options,
  name: string,
  { required = false, defaultValue }: OptionSettings = {},
): string | undefined {
  const values = options.get(name);
  if (!values?.length) {
    if (required) {
      fail(`Missing required option --${name}.`);
    }
    return defaultValue;
  }
  if (values.length !== 1) {
    fail(`Option --${name} may only be specified once.`);
  }
  if (values[0] === true) {
    fail(`Option --${name} requires a value.`);
  }
  return values[0];
}

export function repeatedOption(options: Options, name: string): string[] {
  return (options.get(name) ?? []).map((value) => {
    if (value === true) {
      fail(`Option --${name} requires a value.`);
    }
    return value;
  });
}

export function flag(options: Options, name: string): boolean {
  const values = options.get(name);
  if (!values) {
    return false;
  }
  if (values.length !== 1 || values[0] !== true) {
    fail(`Option --${name} is a flag and does not take a value.`);
  }
  return true;
}

export function assertKnownOptions(
  options: Options,
  allowed: ReadonlySet<string>,
): void {
  for (const name of options.keys()) {
    if (!allowed.has(name)) {
      const valid = [...allowed].map((option) => `--${option}`).join(", ");
      fail(`Unknown option --${name}. Valid options: ${valid || "none"}.`);
    }
  }
}

/** Reports every key of a JSON object that names none of the allowed options.
 * optionName maps a key to the option it names, where other spellings are accepted. */
export function assertKnownKeys(
  keys: readonly string[],
  allowed: ReadonlySet<string>,
  where: string,
  optionName: (key: string) => string = (key) => key,
): void {
  const unknown = keys.filter((key) => !allowed.has(optionName(key)));
  if (!unknown.length) return;
  const named = unknown.map((key) => JSON.stringify(key)).join(", ");
  fail(`${where}: Unknown key${unknown.length > 1 ? "s" : ""} ${named}. Valid keys: ${[...allowed].join(", ") || "none"}.`);
}

export function splitPair(value: string, label: string): [string, string] {
  const separator = value.indexOf("=");
  if (separator < 1 || separator === value.length - 1) {
    fail(`${label} must use <id>=<value>.`);
  }
  return [value.slice(0, separator), value.slice(separator + 1)];
}

/** Converts a structured batch item using the same names and values as --input. */
export function objectOptions(value: unknown, allowed: ReadonlySet<string>, where: string): Options {
  if (!isRecord(value)) fail(`${where}: must be an object.`);
  assertKnownKeys(Object.keys(value), allowed, where, inputOptionName);
  const result: Options = new Map();
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = inputOptionName(rawName);
    if (result.has(name)) fail(`${where}: Duplicate input option ${name}.`);
    inBatchItem(where, () => result.set(name, inputOptionValues(name, rawValue)));
  }
  return result;
}

/** The `kind` of JSON input or a batch item, read before its values are converted. */
export function inputKind(input: Record<string, unknown>): string | undefined {
  const key = Object.keys(input).find((candidate) => inputOptionName(candidate) === "kind");
  const value = key === undefined ? undefined : input[key];
  const single: unknown = Array.isArray(value) && value.length === 1 ? value[0] : value;
  return typeof single === "string" ? single : undefined;
}

/** Runs the work on one batch item, naming the item in what it reports. */
export function inBatchItem<T>(where: string, action: () => T): T {
  try {
    return action();
  } catch (error) {
    fail(`${where}: ${errorMessage(error)}`);
  }
}
