import { fail } from "./errors.js";

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
      fail(`Unknown option --${name}.`);
    }
  }
}

export function splitPair(value: string, label: string): [string, string] {
  const separator = value.indexOf("=");
  if (separator < 1 || separator === value.length - 1) {
    fail(`${label} must use <id>=<value>.`);
  }
  return [value.slice(0, separator), value.slice(separator + 1)];
}
