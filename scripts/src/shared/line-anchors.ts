// Where the line a line thread was written about is in its stage's current
// diff. A stage's head commit changes at every fold and restack, also when the
// stage's content stays the same, so the head says nothing about one line. The
// line is followed through Git's diff from the snapshot the thread is anchored
// to; the stored anchor itself never changes.
import { gitRaw } from "./git.js";

/** The immutable anchor of a line thread. */
export interface LineAnchor {
  /** The stage head the thread was written on. */
  stageHead: string;
  path: string;
  side: "old" | "new";
  line: number;
}

/** A line anchor and what its stage holds now. */
export interface LineAnchorInput {
  anchor: LineAnchor;
  /** The stage's current diff range. */
  stage: { baseRevision: string; headRevision: string };
  /** The file at the anchor's path in the stage's current inventory, if any. */
  file?: { kind?: string; previousPath?: string };
}

/** Runs Git with standard input; null when it fails. */
export type LineAnchorGit = (args: string[], input: string) => string | null;

/** Results kept by input, for callers that locate the same anchors again. */
export type LineAnchorCache = Map<string, number | null>;

const defaultGit = (root: string): LineAnchorGit => (args, input) => gitRaw(args, { cwd: root, input, allowFailure: true });

interface Hunk { oldStart: number; oldCount: number; newStart: number; newCount: number }
interface Section { oldPath: string; newPath: string; binary: boolean; hunks: Hunk[] }

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ALGORITHMS = new Set(["myers", "minimal", "patience", "histogram", "default"]);

/** Git's C-style quoted path, unquoted; the prefix `a/` or `b/` removed. */
function patchPath(value: string): string {
  // Git ends a path with a space in it with a tab; an unquoted path has no tab.
  let text = value.replace(/\r$/, "").split("\t", 1)[0];
  if (text === "/dev/null") return "";
  if (text.startsWith("\"") && text.endsWith("\"")) text = unquote(text.slice(1, -1));
  return text.replace(/^[ab]\//, "");
}

function unquote(text: string): string {
  const bytes: number[] = [];
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, "\"": 34, "\\": 92 };
  for (let index = 0; index < text.length;) {
    if (text[index] !== "\\") {
      // Git leaves non-ASCII characters as they are; keep each whole.
      const char = String.fromCodePoint(text.codePointAt(index) ?? 0);
      bytes.push(...Buffer.from(char, "utf8"));
      index += char.length;
      continue;
    }
    const next = text[index + 1] ?? "";
    if (/[0-7]/.test(next)) { bytes.push(parseInt(text.slice(index + 1, index + 4), 8)); index += 4; }
    else { bytes.push(escapes[next] ?? next.charCodeAt(0)); index += 2; }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** The two equal paths of a `diff --git a/x b/x` line; renames and changes
 * without a patch name their paths in other lines. */
function headerPath(rest: string): string {
  if (rest.startsWith("\"")) return patchPath(/^"(?:[^"\\]|\\.)*"/.exec(rest)?.[0] ?? rest);
  return patchPath(rest.slice(0, (rest.length - 1) / 2));
}

/** Splits `diff-tree --stdin --always -p -U0` output into one list of file
 * sections per input line, in input order. */
function parseBlocks(output: string): Section[][] {
  const blocks: Section[][] = [];
  const lines = output.split("\n");
  let section: Section | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/\r$/, "");
    if (OBJECT_ID.test(line)) { blocks.push([]); section = null; continue; }
    const block = blocks.at(-1);
    if (!block) continue;
    if (line.startsWith("diff --git ")) {
      const path = headerPath(line.slice(11));
      section = { oldPath: path, newPath: path, binary: false, hunks: [] };
      block.push(section);
      continue;
    }
    if (!section) continue;
    if (line.startsWith("--- ")) section.oldPath = patchPath(line.slice(4));
    else if (line.startsWith("+++ ")) section.newPath = patchPath(line.slice(4));
    else if (line.startsWith("rename from ")) section.oldPath = patchPath(line.slice(12));
    else if (line.startsWith("rename to ")) section.newPath = patchPath(line.slice(10));
    else if (line.startsWith("new file mode ")) section.oldPath = "";
    else if (line.startsWith("deleted file mode ")) section.newPath = "";
    else if (line.startsWith("Binary files ")) section.binary = true;
    else {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!match) continue;
      const hunk = { oldStart: +match[1], oldCount: +(match[2] ?? 1), newStart: +match[3], newCount: +(match[4] ?? 1) };
      section.hunks.push(hunk);
      // Skip the hunk's own lines, which can look like headers.
      let remaining = hunk.oldCount + hunk.newCount;
      while (remaining > 0 && index + 1 < lines.length) {
        if (!lines[++index].startsWith("\\")) remaining--;
      }
      while (index + 1 < lines.length && lines[index + 1].startsWith("\\")) index++;
    }
  }
  return blocks;
}

/** The line a line of `filePath` became, or null when the diff changed or
 * removed it or the file. Without a section the file is unchanged. */
function followLine(sections: Section[], filePath: string, line: number): number | null {
  const section = sections.find((item) => item.oldPath === filePath || item.newPath === filePath);
  if (!section) return line;
  if (section.oldPath !== filePath || section.newPath !== filePath || section.binary) return null;
  let shift = 0;
  for (const hunk of section.hunks) {
    if (hunk.oldCount === 0) {
      // Lines inserted after `oldStart`.
      if (hunk.oldStart < line) shift += hunk.newCount;
    } else if (line >= hunk.oldStart && line < hunk.oldStart + hunk.oldCount) {
      return null;
    } else if (hunk.oldStart + hunk.oldCount <= line) {
      shift += hunk.newCount - hunk.oldCount;
    }
  }
  return line + shift;
}

/** The anchored snapshot's revision for a side: the new side at the anchored
 * head, the old side at its first parent, since a stage holds one commit on its base. */
const anchoredName = (anchor: LineAnchor) => anchor.side === "new" ? `${anchor.stageHead}^{commit}` : `${anchor.stageHead}^1`;

/** Whether the stage's current diff can show a row on the anchor's side. */
function sideShown({ anchor, file }: LineAnchorInput): boolean {
  if (!file) return false;
  return anchor.side === "new" ? file.kind !== "deleted" : file.kind !== "added";
}

/** Where the anchor's side of the file is read: a renamed file's old side,
 * stored under its new path like its other rows, at its previous path. */
const sidePath = ({ anchor, file }: LineAnchorInput) => anchor.side === "old" ? file?.previousPath ?? anchor.path : anchor.path;

/**
 * The row of each anchored line in its stage's current diff: the line number
 * on the anchor's side where the same line still stands, unchanged, at the same
 * path, and the current diff shows it on that side. Null when there is no such
 * row: the line changed or was removed, the file moved or left the stage, the
 * file's diff shows no lines, or the line is no longer shown on that side.
 *
 * Each result depends only on its own input. Diffs follow the viewer's: text
 * conversion and the configured diff algorithm apply, and the stage's diff
 * detects renames as its inventory does. Superseded heads stay reachable as
 * parents of the artifact snapshot; one that cannot be read leaves its line
 * without a row. Inputs without a cached result are read together, with at
 * most four Git processes.
 */
export function locateLineAnchors(
  root: string,
  inputs: readonly LineAnchorInput[],
  { runGit = defaultGit(root), cache }: { runGit?: LineAnchorGit; cache?: LineAnchorCache } = {},
): (number | null)[] {
  const keys = inputs.map((input) => JSON.stringify([input.anchor.stageHead, input.anchor.path, input.anchor.side, input.anchor.line,
    input.stage.baseRevision, input.stage.headRevision, input.file?.kind ?? null, input.file?.previousPath ?? null]));
  const results: (number | null)[] = inputs.map(() => null);
  const pending: number[] = [];
  inputs.forEach((input, index) => {
    if (!sideShown(input)) return;
    const cached = cache?.get(keys[index]);
    if (cached !== undefined) results[index] = cached;
    else pending.push(index);
  });
  if (!pending.length) return results;
  const located = locate(inputs, pending, runGit);
  pending.forEach((index, position) => {
    const result = located[position];
    results[index] = result ?? null;
    // A Git failure is not kept, so a later read can still answer.
    if (result !== undefined) cache?.set(keys[index], result);
  });
  return results;
}

/** Locates the inputs at `indexes`; undefined where Git could not answer. */
function locate(inputs: readonly LineAnchorInput[], indexes: readonly number[], runGit: LineAnchorGit): (number | null | undefined)[] {
  const names = [...new Set(indexes.map((index) => anchoredName(inputs[index].anchor)))];
  const resolvedOutput = runGit(["cat-file", "--batch-check=%(objectname) %(objecttype)"], `${names.join("\n")}\n`);
  if (resolvedOutput === null) return indexes.map(() => undefined);
  const resolved = new Map<string, string>();
  resolvedOutput.split("\n").forEach((line, index) => {
    const [id, type] = line.trim().split(" ");
    if (type === "commit" && OBJECT_ID.test(id) && names[index]) resolved.set(names[index], id);
  });
  // The viewer's diff reads the configured algorithm; plumbing does not.
  const config = runGit(["config", "--get-regexp", "^diff\\.(algorithm|indentheuristic)$"], "") ?? "";
  const options: string[] = [];
  for (const line of config.split("\n")) {
    const [key, value = ""] = line.trim().split(/\s+/, 2);
    if (key === "diff.algorithm" && ALGORITHMS.has(value.toLowerCase())) options.push(`--diff-algorithm=${value.toLowerCase()}`);
    if (key === "diff.indentheuristic" && /^(false|no|off|0)$/i.test(value)) options.push("--no-indent-heuristic");
  }
  // Each pair is diffed once; diff-tree reads a commit and then its parent.
  const diff = (pairs: string[], paths: Set<string>, renames: string) => pairs.length ? runGit([
    "-c", "core.quotePath=false", "--literal-pathspecs", "diff-tree", "--stdin", "--always", "-p", "-U0", renames, "--textconv",
    "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", ...options, "--", ...paths,
  ], `${pairs.join("\n")}\n`) : "";
  const pairIndex = (pairs: string[], from: string, to: string) => {
    const pair = `${to} ${from}`;
    const index = pairs.indexOf(pair);
    return index < 0 ? pairs.push(pair) - 1 : index;
  };
  // The stage's current diff, with renames as its inventory has them.
  const currentPairs: string[] = [], currentPaths = new Set<string>();
  // The anchored side against the same side now, file by file: without
  // rename detection, no other file changes what a path's diff shows.
  const anchoredPairs: string[] = [], anchoredPaths = new Set<string>();
  const plans = indexes.map((index) => {
    const { anchor, stage, file } = inputs[index];
    const from = resolved.get(anchoredName(anchor));
    if (!from) return null;
    currentPaths.add(anchor.path);
    if (file?.previousPath) currentPaths.add(file.previousPath);
    const to = anchor.side === "new" ? stage.headRevision : stage.baseRevision;
    if (from !== to) anchoredPaths.add(sidePath(inputs[index]));
    return {
      current: pairIndex(currentPairs, stage.baseRevision, stage.headRevision),
      anchored: from === to ? null : pairIndex(anchoredPairs, from, to),
    };
  });
  const parsed = (output: string | null, pairs: string[]) => {
    const blocks = output === null ? null : parseBlocks(output);
    return blocks && blocks.length === pairs.length ? blocks : null;
  };
  const current = parsed(diff(currentPairs, currentPaths, "--find-renames=50%"), currentPairs);
  const anchored = parsed(diff(anchoredPairs, anchoredPaths, "--no-renames"), anchoredPairs);
  return indexes.map((index, position) => {
    const plan = plans[position];
    if (!plan) return null;
    if (!current || (plan.anchored !== null && !anchored)) return undefined;
    const { anchor, file } = inputs[index];
    // The file as the stage's current diff shows it, paired as its inventory pairs it.
    const section = current[plan.current].find((item) => anchor.side === "old" && !item.newPath ? item.oldPath === anchor.path : item.newPath === anchor.path);
    const expectedOldPath = file?.kind === "added" ? "" : file?.previousPath ?? anchor.path;
    if (!section || section.binary || !section.hunks.length || section.oldPath !== expectedOldPath) return null;
    const line = plan.anchored === null || !anchored ? anchor.line : followLine(anchored[plan.anchored], sidePath(inputs[index]), anchor.line);
    if (line === null || anchor.side === "new") return line;
    // Old rows are the lines the stage removes.
    return section.hunks.some((hunk) => line >= hunk.oldStart && line < hunk.oldStart + hunk.oldCount) ? line : null;
  });
}
