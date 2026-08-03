import fs from "node:fs";
import path from "node:path";
import {
  parse,
  parseTree,
  printParseErrorCode,
  type Node as JsonNode,
  type ParseError,
} from "jsonc-parser/lib/esm/main.js";
import { fail } from "./errors.js";

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

export function readJson(file: string): any {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    fail(`Cannot read ${file}: ${(error as Error).message}`);
  }

  if (text.charCodeAt(0) === 0xfeff) {
    fail(`${file}: UTF-8 byte-order marks are not allowed.`);
  }

  const parseErrors: ParseError[] = [];
  const value = parse(text, parseErrors, {
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (parseErrors.length > 0) {
    const details = parseErrors
      .map(
        (error) =>
          `${printParseErrorCode(error.error)} at character ${error.offset}`,
      )
      .join(", ");
    fail(`${file}: invalid JSON: ${details}.`);
  }

  const duplicateErrors: string[] = [];
  findDuplicateKeys(
    parseTree(text, [], {
      allowTrailingComma: false,
      disallowComments: true,
    }),
    file,
    duplicateErrors,
  );
  if (duplicateErrors.length > 0) {
    fail(duplicateErrors.join("\n"));
  }
  return value;
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
