import fs from "node:fs";
import path from "node:path";
// Bundles use the package's ESM build (see the alias in build-skill.ts). The
// build and release tools run this file through tsx and load the CommonJS entry:
// the package does not mark its ESM build as ESM, so Node.js 20 cannot load it.
import * as jsonc from "jsonc-parser";
import type { Node as JsonNode, ParseError } from "jsonc-parser";
import { fail } from "./errors.js";
import { errorMessage } from "./narrow.js";

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

  if (text.charCodeAt(0) === 0xfeff) {
    fail(`${file}: UTF-8 byte-order marks are not allowed.`);
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
    fail(`${file}: invalid JSON: ${details}.`);
  }

  const duplicateErrors: string[] = [];
  findDuplicateKeys(tree, file, duplicateErrors);
  if (duplicateErrors.length > 0) {
    fail(duplicateErrors.join("\n"));
  }
  try {
    return parseJson(text);
  } catch (error) {
    fail(`${file}: invalid JSON: ${errorMessage(error)}.`);
  }
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
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
