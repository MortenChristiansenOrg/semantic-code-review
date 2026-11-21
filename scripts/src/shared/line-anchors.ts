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

/** A stage's current diff range. */
export interface CurrentRange {
  baseRevision: string;
  headRevision: string;
}

/** Runs Git with standard input; null when it fails. */
export type LineAnchorGit = (args: string[], input: string) => string | null;

const defaultGit = (root: string): LineAnchorGit => (args, input) => gitRaw(args, { cwd: root, input, allowFailure: true });

interface Hunk { oldStart: number; oldCount: number; newStart: number; newCount: number }
interface Section { oldPath: string; newPath: string; binary: boolean; hunks: Hunk[] }

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

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
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char !== "\\") { bytes.push(...Buffer.from(char, "utf8")); continue; }
    const next = text[++index];
    if (/[0-7]/.test(next)) { bytes.push(parseInt(text.slice(index, index + 3), 8)); index += 2; }
    else bytes.push(escapes[next] ?? next.charCodeAt(0));
  }
  return Buffer.from(bytes).toString("utf8");
}

/** The two equal paths of a `diff --git a/x b/x` line; renames and changes
 * without a patch name their paths in other lines. */
function headerPath(rest: string): string {
  if (rest.startsWith("\"")) {
    const end = /^"(?:[^"\\]|\\.)*"/.exec(rest)?.[0] ?? rest;
    return patchPath(end);
  }
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

/** The line a line of `path` became, or null when the diff changed it, moved
 * the file, or cannot show it. Without a section the file is unchanged. */
function followLine(sections: Section[] | undefined, filePath: string, line: number): number | null {
  const section = sections?.find((item) => item.oldPath === filePath || item.newPath === filePath);
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

/**
 * The row of each anchored line in its stage's current diff: the line number
 * on the anchor's side where the same line still stands, unchanged, at the same
 * path, and the current diff shows it on that side. Null when there is no such
 * row: the line changed or was removed, the file moved or left the stage, or the
 * line is no longer shown on that side.
 *
 * The new side is read at the anchored stage head, and the old side at its first
 * parent, since a stage holds one commit on its base. Superseded heads stay
 * reachable as parents of the artifact snapshot; one that cannot be read leaves
 * its line without a row. Runs Git twice in all, and not at all without anchors.
 */
export function locateLineAnchors(
  root: string,
  anchors: readonly { anchor: LineAnchor; stage: CurrentRange; previousPath?: string }[],
  runGit: LineAnchorGit = defaultGit(root),
): (number | null)[] {
  if (!anchors.length) return [];
  const results: (number | null)[] = anchors.map(() => null);
  // Resolve each anchored snapshot to a commit; a missing one has no row.
  const names = [...new Set(anchors.map(({ anchor }) => anchor.side === "new" ? `${anchor.stageHead}^{commit}` : `${anchor.stageHead}^1`))];
  const resolvedOutput = runGit(["cat-file", "--batch-check=%(objectname) %(objecttype)"], `${names.join("\n")}\n`);
  if (resolvedOutput === null) return results;
  const resolved = new Map<string, string>();
  resolvedOutput.split("\n").forEach((line, index) => {
    const [id, type] = line.trim().split(" ");
    if (type === "commit" && OBJECT_ID.test(id) && names[index]) resolved.set(names[index], id);
  });
  // One diff per pair of commits: each stage's current diff, and each anchored
  // side against the same side now.
  const pairs: string[] = [];
  const pairIndex = (from: string, to: string) => {
    // diff-tree reads a commit and then its parent.
    const pair = `${to} ${from}`;
    let index = pairs.indexOf(pair);
    if (index < 0) index = pairs.push(pair) - 1;
    return index;
  };
  const paths = new Set<string>();
  const plans = anchors.map(({ anchor, stage, previousPath }) => {
    const from = resolved.get(anchor.side === "new" ? `${anchor.stageHead}^{commit}` : `${anchor.stageHead}^1`);
    if (!from) return null;
    paths.add(anchor.path);
    // A renamed file's old rows are read from its old path.
    if (previousPath) paths.add(previousPath);
    const to = anchor.side === "new" ? stage.headRevision : stage.baseRevision;
    return { from, to, current: pairIndex(stage.baseRevision, stage.headRevision), anchored: from === to ? null : pairIndex(from, to) };
  });
  if (!pairs.length) return results;
  const output = runGit([
    "-c", "core.quotePath=false", "--literal-pathspecs", "diff-tree", "--stdin", "--always", "-p", "-U0", "--find-renames=50%",
    "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "--", ...paths,
  ], `${pairs.join("\n")}\n`);
  const blocks = output === null ? null : parseBlocks(output);
  if (!blocks || blocks.length !== pairs.length) return results;
  anchors.forEach(({ anchor }, index) => {
    const plan = plans[index];
    if (!plan) return;
    // The file as the stage's current diff shows it.
    const current = blocks[plan.current].find((section) => section.newPath === anchor.path || (!section.newPath && section.oldPath === anchor.path));
    if (!current || current.binary) return;
    if (anchor.side === "new") {
      if (!current.newPath) return;
      results[index] = plan.anchored === null ? anchor.line : followLine(blocks[plan.anchored], anchor.path, anchor.line);
      return;
    }
    // Old rows are the lines the stage removes, read from the file's old path.
    if (!current.oldPath || !paths.has(current.oldPath)) return;
    const line = plan.anchored === null ? anchor.line : followLine(blocks[plan.anchored], current.oldPath, anchor.line);
    const removed = line !== null && current.hunks.some((hunk) => line >= hunk.oldStart && line < hunk.oldStart + hunk.oldCount);
    results[index] = removed ? line : null;
  });
  return results;
}
