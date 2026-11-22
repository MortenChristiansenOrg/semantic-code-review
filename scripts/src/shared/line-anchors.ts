// Where the line a line thread was written about is in its stage's current
// diff. A stage's head commit changes at every fold and restack, also when the
// stage's content stays the same, so the head says nothing about one line. The
// line is followed through Git's diff from the snapshot the thread is anchored
// to; the stored anchor itself never changes.
import { diffTree } from "./diff-settings.js";
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
  /** The file at the anchor's path as the stage shows it now, if any, with its
   * path in the review's earlier stages when that differs (see `shownStageFiles`). */
  file?: { previousPath?: string };
}

/**
 * The path a stored line target names. A line target names a line by the
 * file's path in its stage on both sides; its side says which revision counts
 * the line. Earlier versions named a removed line of a file the stage renames
 * by the file's previous path. While such a target's stage head is the anchored
 * one, and no file of the stage at that path has removed lines, it names the
 * file renamed from that path.
 */
export function storedLineTargetPath(
  target: { path: string; side: "old" | "new"; stageHead: string },
  stage: { headRevision: string; files: readonly { path: string; kind?: unknown; previousPath?: string }[] },
): string {
  if (target.side !== "old" || target.stageHead !== stage.headRevision) return target.path;
  if (stage.files.some((file) => file.path === target.path && file.kind !== "added")) return target.path;
  return stage.files.find((file) => file.previousPath === target.path)?.path ?? target.path;
}

/** Runs Git with standard input and variables on top of the CLI's Git
 * environment; null when it fails. */
export type LineAnchorGit = (args: string[], input: string, env?: NodeJS.ProcessEnv) => string | null;

/** Results kept by input, for callers that locate the same anchors again. */
export type LineAnchorCache = Map<string, number | null>;

const defaultGit = (root: string): LineAnchorGit => (args, input, env) => gitRaw(args, { cwd: root, input, env, allowFailure: true });

interface Hunk { oldStart: number; oldCount: number; newStart: number; newCount: number }
/** One file's part of a patch; a path is empty on the side where the file does not exist. */
export interface Section { oldPath: string; newPath: string; oldBlob: string; newBlob: string; binary: boolean; hunks: Hunk[] }

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Git's C-style quoted path, unquoted; the prefix `a/` or `b/` removed. */
function patchPath(value: string, prefixed = true): string {
  // Git ends a path with a space in it with a tab; an unquoted path has no tab.
  let text = value.replace(/\r$/, "").split("\t", 1)[0];
  if (text === "/dev/null") return "";
  if (text.startsWith("\"") && text.endsWith("\"")) text = unquote(text.slice(1, -1));
  return prefixed ? text.replace(/^[ab]\//, "") : text;
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
 * sections per input line, in input order; without `headed`, the output of a
 * single diff into one list. */
function parseBlocks(output: string, headed = true): Section[][] {
  const blocks: Section[][] = headed ? [] : [[]];
  const lines = output.split("\n");
  let section: Section | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/\r$/, "");
    if (headed && OBJECT_ID.test(line)) { blocks.push([]); section = null; continue; }
    const block = blocks.at(-1);
    if (!block) continue;
    if (line.startsWith("diff --git ")) {
      const path = headerPath(line.slice(11));
      section = { oldPath: path, newPath: path, oldBlob: "", newBlob: "", binary: false, hunks: [] };
      block.push(section);
      continue;
    }
    if (!section) continue;
    if (line.startsWith("--- ")) section.oldPath = patchPath(line.slice(4));
    else if (line.startsWith("+++ ")) section.newPath = patchPath(line.slice(4));
    // Rename lines name paths without a prefix.
    else if (line.startsWith("rename from ")) section.oldPath = patchPath(line.slice(12), false);
    else if (line.startsWith("rename to ")) section.newPath = patchPath(line.slice(10), false);
    else if (line.startsWith("new file mode ")) section.oldPath = "";
    else if (line.startsWith("deleted file mode ")) section.newPath = "";
    else if (line.startsWith("Binary files ")) section.binary = true;
    else if (line.startsWith("index ")) [section.oldBlob = "", section.newBlob = ""] = line.slice(6).split(" ", 1)[0].split("..");
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

/** The file sections of a `-p -U0` patch with the settings of diff-settings.ts. */
export function patchSections(patch: string): Section[] {
  return parseBlocks(patch, false)[0];
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
 * head, the old side at its first parent, since a stage holds one commit on its
 * base. A file's old side is the same there as at the head of the last stage
 * that changed it, where the review compares it. */
const anchoredName = (anchor: LineAnchor) => anchor.side === "new" ? `${anchor.stageHead}^{commit}` : `${anchor.stageHead}^1`;

/**
 * The row of each anchored line in its stage's current diff: the line number
 * on the anchor's side where the same line still stands, unchanged, at the same
 * path, and the current diff shows it on that side. Null when there is no such
 * row: the line changed or was removed, the file moved or left the stage, the
 * file's diff shows no lines, or the line is no longer shown on that side.
 *
 * While the stage head is the anchored one, the line is where it was written.
 * Otherwise the line is followed by diffs of one path at a time, so each result
 * depends only on its own input, as the viewer's diff shows lines (see
 * diff-settings.ts). The removed lines of a file the
 * stage renames are not followed. Superseded heads stay reachable as parents of
 * the artifact snapshot; one that cannot be read leaves its line without a row.
 * Inputs without a cached result are read together, with two Git processes.
 */
export function locateLineAnchors(
  root: string,
  inputs: readonly LineAnchorInput[],
  { runGit = defaultGit(root), cache }: { runGit?: LineAnchorGit; cache?: LineAnchorCache } = {},
): (number | null)[] {
  const keys = inputs.map((input) => JSON.stringify([input.anchor.stageHead, input.anchor.path, input.anchor.side, input.anchor.line,
    input.stage.baseRevision, input.stage.headRevision, input.file?.previousPath ?? null]));
  const results: (number | null)[] = inputs.map(() => null);
  const pending: number[] = [];
  inputs.forEach((input, index) => {
    if (!input.file) return;
    // A thread is written on a row of the stage's diff at its head.
    if (input.anchor.stageHead === input.stage.headRevision) { results[index] = input.anchor.line; return; }
    if (input.anchor.side === "old" && input.file?.previousPath) return;
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
  // Replacement refs would name another parent than the diff below reads.
  const resolvedOutput = runGit(["--no-replace-objects", "cat-file", "--batch-check=%(objectname) %(objecttype)"], `${names.join("\n")}\n`);
  if (resolvedOutput === null) return indexes.map(() => undefined);
  const resolved = new Map<string, string>();
  resolvedOutput.split("\n").forEach((line, index) => {
    const [id, type] = line.trim().split(" ");
    if (type === "commit" && OBJECT_ID.test(id) && names[index]) resolved.set(names[index], id);
  });
  // Each pair is diffed once; diff-tree reads a commit and then its parent.
  const pairs: string[] = [], paths = new Set<string>();
  const pairIndex = (from: string, to: string) => {
    const pair = `${to} ${from}`;
    const index = pairs.indexOf(pair);
    return index < 0 ? pairs.push(pair) - 1 : index;
  };
  const plans = indexes.map((index) => {
    const { anchor, stage, file } = inputs[index];
    const from = resolved.get(anchoredName(anchor));
    if (!from) return null;
    paths.add(anchor.path);
    if (file?.previousPath) paths.add(file.previousPath);
    const to = anchor.side === "new" ? stage.headRevision : stage.baseRevision;
    return { current: pairIndex(stage.baseRevision, stage.headRevision), anchored: from === to ? null : pairIndex(from, to) };
  });
  // Without rename detection, a path's diff does not depend on the other paths.
  const command = diffTree(["--stdin", "--always", "-p", "-U0", "--no-renames", "--full-index", "--", ...paths],
    { objectIdLength: inputs[indexes[0]].stage.headRevision.length });
  const output = pairs.length ? runGit(command.args, `${pairs.join("\n")}\n`, command.env) : "";
  const parsedBlocks = output === null ? null : parseBlocks(output);
  const blocks = parsedBlocks && parsedBlocks.length === pairs.length ? parsedBlocks : null;
  return indexes.map((index, position) => {
    const plan = plans[position];
    if (!plan) return null;
    if (!blocks) return undefined;
    const { anchor, file } = inputs[index];
    const shown = shownSection(blocks[plan.current], anchor.path, file?.previousPath);
    // An added file has no old side, a deleted one no new side.
    if (!shown || !(anchor.side === "new" ? shown.newPath : shown.oldPath)) return null;
    const line = plan.anchored === null ? anchor.line : followLine(blocks[plan.anchored], anchor.path, anchor.line);
    if (line === null || anchor.side === "new") return line;
    // Old rows are the lines the stage removes.
    return shown.hunks.some((hunk) => line >= hunk.oldStart && line < hunk.oldStart + hunk.oldCount) ? line : null;
  });
}

/** The section of the stage's current diff for the file at `filePath`, while
 * it shows lines: a text change, or for a file renamed from `previousPath`,
 * changed content. */
function shownSection(sections: Section[], filePath: string, previousPath: string | undefined): Section | null {
  const own = sections.filter((item) => item.oldPath === filePath || item.newPath === filePath);
  // A change of file type shows as a removal and an addition.
  if (own.length !== 1 || own[0].binary || !own[0].hunks.length) return null;
  if (!previousPath) return own[0];
  const source = sections.find((item) => item.oldPath === previousPath && !item.newPath);
  return source && source.oldBlob === own[0].newBlob ? null : own[0];
}
