import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fromBufferPromise } from "yauzl";
import { parseVersion, RELEASE_REPOSITORY } from "./release-version.js";
import { parseJson } from "./json.js";
import { isRecord, stringField, type JsonRecord } from "./narrow.js";

/** The oldest Node.js major version the skill supports. Releases record it, and
 * `engines` in package.json, CI and the documentation state the same version. */
export const MINIMUM_NODE_MAJOR = 22;

export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
export interface ReleaseMetadata {
  version: string;
  sourceCommit: string;
  repository: typeof RELEASE_REPOSITORY;
  minimumNodeMajor: number;
  files: Record<string, string>;
}
export const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

export function safeRelativePath(name: string): boolean {
  return name.length > 0 && name.split("/").every((part) =>
    /^[a-zA-Z0-9_.-]+$/.test(part) && part !== "." && part !== ".." &&
    !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part));
}

export function skillFiles(root: string, prefix = ""): string[] {
  return fs.readdirSync(path.join(root, prefix)).sort().flatMap((name) => {
    const relative = prefix ? `${prefix}/${name}` : name;
    if (!safeRelativePath(relative)) throw new Error(`Unsupported skill path: ${relative}.`);
    const stat = fs.lstatSync(path.join(root, relative));
    if (stat.isDirectory()) return skillFiles(root, relative);
    if (!stat.isFile()) throw new Error(`Skill contains a link or special file: ${relative}.`);
    return [relative];
  });
}

function requiredFiles(files: Map<string, Buffer>): void {
  const required = ["SKILL.md", "VERSION", "RELEASE.json", "THIRD-PARTY-NOTICES.txt",
    "scripts/API.d.ts", "scripts/API.full.d.ts",
    "scripts/semantic-flow.mjs",
    ...["shared", "implementation", "stages", "history", "feedback", "workflow"].map((name) => `scripts/api/${name}.d.ts`),
    ...["index.html", "app.js", "styles.css", "favicon.svg"].map((name) => `viewer/${name}`),
    ...["common", "manifest", "specification", "stage"].map((name) => `references/schema/${name}.schema.json`),
    ...["common", "manifest", "thread"].map((name) => `references/feedback-schema/${name}.schema.json`),
    "references/work-stage.schema.json", "references/stage-organization.schema.json"];
  for (const match of (files.get("SKILL.md")?.toString() ?? "").matchAll(/`(commands\/[^`]+\.md)`/g)) required.push(match[1]);
  // Releases before viewer access control have no start script. A page that names
  // one anywhere needs it: requiring it too often only refuses a broken archive.
  if (/boot\.js/i.test(files.get("viewer/index.html")?.toString() ?? "")) required.push("viewer/boot.js");
  for (const name of required) if (!files.has(name)) throw new Error(`Release is missing ${name}.`);
}

function requiredFile(files: Map<string, Buffer>, name: string): Buffer {
  const bytes = files.get(name);
  if (!bytes) throw new Error(`Release is missing ${name}.`);
  return bytes;
}

export function validateDistribution(files: Map<string, Buffer>, expectedVersion: string, runtimeMajor = Number(process.versions.node.split(".")[0])): ReleaseMetadata {
  requiredFiles(files);
  const parsed = parseJson(requiredFile(files, "RELEASE.json").toString());
  const metadata: JsonRecord = isRecord(parsed) ? parsed : {};
  const { version, repository, minimumNodeMajor, files: checksums } = metadata;
  parseVersion(typeof version === "string" ? version : String(version));
  const sourceCommit = stringField(metadata, "sourceCommit");
  if (version !== expectedVersion || requiredFile(files, "VERSION").toString().trim() !== expectedVersion ||
      repository !== RELEASE_REPOSITORY || sourceCommit === undefined || !/^[a-f0-9]{40}$/.test(sourceCommit)) {
    throw new Error("Release version, repository, or source commit does not match its metadata.");
  }
  if (typeof minimumNodeMajor !== "number" || !Number.isSafeInteger(minimumNodeMajor) || minimumNodeMajor < 20 || runtimeMajor < minimumNodeMajor) {
    throw new Error(`This release requires Node.js ${String(minimumNodeMajor)} or newer.`);
  }
  if (!isRecord(checksums) || Object.keys(checksums).length !== files.size - 1) throw new Error("Invalid release file manifest.");
  // Entries become own properties even for names such as __proto__.
  const verified = Object.fromEntries([...files].filter(([name]) => name !== "RELEASE.json").map(([name, bytes]): [string, string] => {
    const digest = sha256(bytes);
    if (!Object.hasOwn(checksums, name) || checksums[name] !== digest) throw new Error(`Release file checksum mismatch: ${name}.`);
    return [name, digest];
  }));
  return { version: expectedVersion, sourceCommit, repository, minimumNodeMajor, files: verified };
}

/** Validate the complete ZIP before creating any files. Only regular files are accepted. */
export async function unpackDistribution(archive: Buffer, destination: string, version: string): Promise<ReleaseMetadata> {
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error("Release archive is too large.");
  const zip = await fromBufferPromise(archive, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true });
  const files = new Map<string, Buffer>(), names = new Set<string>();
  let total = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      const name = entry.fileName;
      const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (!name.startsWith("semantic-flow/") || !safeRelativePath(name) ||
          (mode !== 0 && mode !== 0o100000) || entry.isEncrypted()) throw new Error(`Unsafe archive entry: ${name}.`);
      const relative = name.slice("semantic-flow/".length);
      if (names.has(relative.toLowerCase())) throw new Error(`Duplicate archive entry: ${name}.`);
      names.add(relative.toLowerCase());
      total += entry.uncompressedSize;
      if (total > MAX_EXPANDED_BYTES || names.size > 10000) throw new Error("Expanded release is too large.");
      const stream = await zip.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk);
      files.set(relative, Buffer.concat(chunks));
    }
  } finally { zip.close(); }
  const metadata = validateDistribution(files, version);
  // The caller supplies a new staging directory; never extract over existing data.
  fs.mkdirSync(destination);
  try {
    for (const [name, bytes] of files) {
      const file = path.join(destination, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o644 });
    }
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
  return metadata;
}
