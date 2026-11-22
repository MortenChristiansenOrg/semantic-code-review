/** The Git settings every diff of the CLI and the viewer runs with, so that the
 * files, change kinds, renames and patches they list and show agree with the
 * stage inventory (`changedFiles` in implementation.ts) whatever the user's Git
 * configuration.
 *
 * Diffs of two commits run plumbing `git diff-tree`, which reads none of the
 * porcelain diff settings: diff.renames, diff.ignoreSubmodules, diff.submodule,
 * diff.algorithm, diff.context, diff.interHunkContext, diff.orderFile,
 * diff.relative, diff.external, diff.noprefix, diff.mnemonicPrefix,
 * diff.srcPrefix, diff.dstPrefix and colour. Diffs plumbing cannot run (blobs,
 * files outside the repository, `git log -p`) run porcelain with an option for
 * each of those. Both pass options for what plumbing still reads too: submodule
 * ignore rules from .gitmodules or submodule.<name>.ignore, diff.renameLimit,
 * core.bigFileThreshold, diff.indentHeuristic, diff.suppressBlankEmpty, which
 * writes an empty context line without its leading space, replacement refs,
 * attributes, and the GIT_DIFF_OPTS variable, which overrides the context of
 * every patch. */

/** The empty tree of each object format, by the length of its IDs. */
const EMPTY_TREES: Record<number, string> = {
  40: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  64: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
};

/** Options before the Git command. Replacement refs would substitute other
 * objects for the compared commits. A file's attributes decide whether it is
 * binary, and a binary file's rename score counts the carriage returns a text
 * file's ignores, so attributes could turn a rename into an addition and a
 * deletion, or a patch into "Binary files differ". The user's attributes file
 * is not read (Git reads /dev/null as the null device on every platform), and
 * without attributes Git uses the "default" diff driver, whose binary setting
 * is restored to detection. A file larger than core.bigFileThreshold would be
 * binary too; the threshold is Git's default. Patch headers name non-ASCII
 * paths as they are. */
function globalOptions(literalPathspecs: boolean): string[] {
  return ["--no-replace-objects", ...(literalPathspecs ? ["--literal-pathspecs"] : []),
    "-c", "core.attributesFile=/dev/null", "-c", "diff.default.binary=auto", "-c", "core.bigFileThreshold=512m",
    "-c", "core.quotePath=false", "-c", "diff.suppressBlankEmpty=false"];
}

/** The environment a diff runs in, on top of the CLI's isolated Git
 * environment: attributes are read from the empty tree instead of the
 * worktree, index or attr.tree (Git 2.41 and later; older Git ignores
 * GIT_ATTR_SOURCE), and the system attributes file is not read.
 * $GIT_DIR/info/attributes cannot be turned off. */
function diffEnvironment(objectIdLength: number): NodeJS.ProcessEnv {
  // Node leaves out a variable whose value is undefined.
  return { GIT_ATTR_SOURCE: EMPTY_TREES[objectIdLength] ?? EMPTY_TREES[40], GIT_ATTR_NOSYSTEM: "1", GIT_DIFF_OPTS: undefined };
}

/** Options of every diff: submodule updates are never hidden, and no external
 * diff, text conversion or colour changes what Git prints. */
const DIFF_OPTIONS = ["--ignore-submodules=none", "--no-ext-diff", "--no-textconv", "--no-color"];

/** Rename detection of the stage inventory. 1000 is this project's rename
 * limit, Git's default since 2.33, instead of diff.renameLimit. */
export const FIND_RENAMES = ["--find-renames=50%", "-l1000"];

/** How patches are written: hunks are found with Git's default algorithm and
 * indent heuristic and merged only when they touch, so stored hunk selectors
 * and line anchors mean the same hunks and lines on every computer; headers
 * carry the standard prefixes, and a submodule shows as its commit IDs. */
const PATCH_FORMAT = ["--diff-algorithm=myers", "--indent-heuristic", "--inter-hunk-context=0", "--src-prefix=a/", "--dst-prefix=b/",
  "--submodule=short"];

/** A Git command and the variables to run it with, on top of the CLI's
 * isolated Git environment. */
export interface DiffCommand {
  args: string[];
  env: NodeJS.ProcessEnv;
}

interface DiffCommandOptions {
  /** The length of the repository's object IDs, which selects its empty tree. */
  objectIdLength?: number;
  /** Whether paths after "--" are literal paths rather than pathspecs. */
  literalPathspecs?: boolean;
}

/** `git diff-tree -r` with these settings followed by `options`, which name
 * the output format, rename detection and revisions. */
export function diffTree(options: readonly string[], { objectIdLength = 40, literalPathspecs = true }: DiffCommandOptions = {}): DiffCommand {
  return {
    args: [...globalOptions(literalPathspecs), "diff-tree", "-r", ...DIFF_OPTIONS, ...PATCH_FORMAT, ...options],
    env: diffEnvironment(objectIdLength),
  };
}

/** Porcelain `git diff` or `git log` with these settings followed by
 * `options`, for diffs plumbing cannot run. A missing diff.orderFile would
 * make porcelain fail; /dev/null orders nothing. */
export function porcelainDiff(command: "diff" | "log", options: readonly string[], { objectIdLength = 40, literalPathspecs = true }: DiffCommandOptions = {}): DiffCommand {
  return {
    args: [...globalOptions(literalPathspecs), command, ...DIFF_OPTIONS, ...PATCH_FORMAT, "-O/dev/null", ...options],
    env: diffEnvironment(objectIdLength),
  };
}
