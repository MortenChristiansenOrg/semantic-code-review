import fs from "node:fs";
import path from "node:path";
// Bundles use the package's ESM build (see the alias in build-skill.ts). The
// build and release tools run this file through tsx and load the CommonJS entry:
// the package does not mark its ESM build as ESM, so Node.js loads it only through
// module syntax detection, which Node.js 22 releases before 22.7 lack.
import * as jsonc from "jsonc-parser";
import type { Node as JsonNode, ParseError } from "jsonc-parser";
import { fail } from "./errors.js";
import { errorCode, errorMessage } from "./narrow.js";

function findDuplicateKeys(
  node: JsonNode | undefined,
  file: string,
  errors: string[],
): void {
  if (!node) {
    return;
  }
  if (node.type === "object") {
    const keys = new Set<unknown>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value;
      if (keys.has(key)) {
        errors.push(`${file}: duplicate object key "${key}".`);
      }
      keys.add(key);
      findDuplicateKeys(property.children?.[1], file, errors);
    }
    return;
  }
  for (const child of node.children ?? []) {
    findDuplicateKeys(child, file, errors);
  }
}

export function readJson(file: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    fail(`Cannot read ${file}: ${errorMessage(error)}`);
  }
  return parseJsonDocument(text, file);
}

/** Parses the text of a stored JSON document, which label names in errors.
 * Byte-order marks, comments, trailing commas and duplicate keys are rejected.
 * The result is unvalidated: validate it against its schema before use. */
export function parseJsonDocument(text: string, label: string): unknown {
  if (text.charCodeAt(0) === 0xfeff) {
    fail(`${label}: UTF-8 byte-order marks are not allowed.`);
  }

  // jsonc-parser checks the syntax and finds duplicate keys. It builds objects
  // by assignment, which drops "__proto__" keys, so the value comes from the
  // native parser: schema validation must see every property.
  const parseErrors: ParseError[] = [];
  const tree = jsonc.parseTree(text, parseErrors, {
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (parseErrors.length > 0) {
    const details = parseErrors
      .map(
        (error) =>
          `${jsonc.printParseErrorCode(error.error)} at character ${error.offset}`,
      )
      .join(", ");
    fail(`${label}: invalid JSON: ${details}.`);
  }

  const duplicateErrors: string[] = [];
  findDuplicateKeys(tree, label, duplicateErrors);
  if (duplicateErrors.length > 0) {
    fail(duplicateErrors.join("\n"));
  }
  try {
    return parseJson(text);
  } catch (error) {
    fail(`${label}: invalid JSON: ${errorMessage(error)}.`);
  }
}

/** The bytes writeJson stores for value. */
export function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, jsonBytes(value));
  replaceFile(temporary, file);
}

/** How long a replacement waits for readers of the destination on Windows. */
export const REPLACE_WAIT_MS = 2000;
const SHARING_VIOLATIONS = ["EPERM", "EACCES", "EBUSY"];

/** Moves source over destination, as `fs.renameSync` does. Windows refuses to
 * replace a file while another process has it open, which readers of review data
 * do briefly, so there the move is retried until the readers are done. */
export function replaceFile(source: string, destination: string): void {
  const deadline = performance.now() + REPLACE_WAIT_MS;
  for (let pause = 5; ; pause = Math.min(pause * 2, 100)) {
    try { fs.renameSync(source, destination); return; }
    catch (error) {
      const remaining = deadline - performance.now();
      if (process.platform !== "win32" || !SHARING_VIOLATIONS.includes(errorCode(error) ?? "") || remaining <= 0) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(pause, remaining));
    }
  }
}

export function listJsonFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) {
    return [];
  }
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

/** Parses JSON text from a file, Git object or another process. The result is
 * unvalidated: narrow it or validate it against its schema before use. */
export function parseJson(text: string): unknown {
  return JSON.parse(text);
}
