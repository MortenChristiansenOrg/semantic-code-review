// Git settings and a stage that show whether a diff of the CLI or the viewer
// agrees with the stage inventory whatever the user's Git configuration.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { beginStage, createRepository, initializeImplementation, organizeStage } from "./repository.mjs";

/** Settings that would change what a porcelain diff lists or prints, grouped
 * by what they would hide or break. `env` holds variables to set too. */
export const HOSTILE_GIT = {
  submodules: { config: { "diff.ignoreSubmodules": "all", "submodule.sub.ignore": "all", "diff.submodule": "log" } },
  renames: { config: { "diff.renameLimit": "1", "diff.renames": "false" } },
  format: {
    config: {
      "diff.noprefix": "true",
      "diff.mnemonicPrefix": "true",
      "diff.srcPrefix": "old/",
      "diff.dstPrefix": "new/",
      "diff.context": "0",
      "diff.interHunkContext": "100",
      "diff.algorithm": "histogram",
      "diff.indentHeuristic": "false",
      "diff.suppressBlankEmpty": "true",
      "diff.orderFile": "missing-order-file",
      "diff.external": "missing-external-diff",
      "diff.relative": "true",
      "color.ui": "always",
      "color.diff": "always",
      "core.quotePath": "true",
    },
    env: { GIT_DIFF_OPTS: "--unified=0" },
  },
};

/** Runs `run` with a group of HOSTILE_GIT set in the repository at `root` and
 * in this process's environment, which child processes inherit. */
export async function withHostileGit(root, group, run) {
  const git = (...args) => fs.existsSync(root) && execFileSync("git", args, { cwd: root, stdio: "ignore" });
  const { config, env = {} } = HOSTILE_GIT[group];
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(config)) git("config", key, value);
  Object.assign(process.env, env);
  try {
    return await run();
  } finally {
    for (const key of Object.keys(config)) git("config", "--unset-all", key);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}


/** Forty lines ending in a blank line and a last line, so a change at the end
 * shows an empty context line. */
export const fileLines = (name) => `${Array.from({ length: 38 }, (_, index) => `${name} line ${index}`).join("\n")}\n\nend\n`;

/** Commits a submodule (a gitlink and a .gitmodules entry that ignores it) and
 * two files of fileLines; Git compares gitlinks without the submodule's
 * objects, so none is cloned. Returns the commit. */
export function commitSubmoduleAndFiles(repository) {
  repository.git("config", "core.autocrlf", "false");
  fs.writeFileSync(repository.path(".gitmodules"), '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n\tignore = all\n');
  fs.writeFileSync(repository.path("first.txt"), fileLines("first"));
  fs.writeFileSync(repository.path("second.txt"), fileLines("second"));
  repository.git("add", ".gitmodules", "first.txt", "second.txt");
  repository.git("update-index", "--add", "--cacheinfo", `160000,${repository.git("rev-parse", "HEAD")},sub`);
  repository.git("commit", "-m", "Add submodule and files");
  return repository.git("rev-parse", "HEAD");
}

/** Commits an update of the submodule and renames of both files: the first
 * with a line appended, the second also with its first line changed. */
export function commitSubmoduleUpdateAndRenames(repository) {
  repository.git("update-index", "--cacheinfo", `160000,${repository.git("rev-parse", "HEAD")},sub`);
  for (const [from, to] of [["first.txt", "renamed-first.txt"], ["second.txt", "renamed-second.txt"]]) {
    repository.git("mv", from, to);
    let contents = `${fs.readFileSync(repository.path(to), "utf8")}edited\n`;
    if (to === "renamed-second.txt") contents = contents.replace("second line 0\n", "changed\n");
    fs.writeFileSync(repository.path(to), contents);
    repository.git("add", to);
  }
  repository.git("commit", "-m", "Update submodule and rename files");
  return repository.git("rev-parse", "HEAD");
}

/** The inventory of the stage commitSubmoduleUpdateAndRenames makes. */
export const UPDATE_AND_RENAMES = [
  { path: "renamed-first.txt", kind: "renamed", previousPath: "first.txt" },
  { path: "renamed-second.txt", kind: "renamed", previousPath: "second.txt" },
  { path: "sub", kind: "modified" },
];

/** A finished one-stage implementation whose stage is commitSubmoduleUpdateAndRenames. */
export function submoduleAndRenamesStage(t) {
  const repository = createRepository(t);
  commitSubmoduleAndFiles(repository);
  initializeImplementation(repository);
  beginStage(repository);
  commitSubmoduleUpdateAndRenames(repository);
  organizeStage(repository, { nodes: [{ id: "implementation-change", description: "Update the submodule and rename the files.",
    changes: UPDATE_AND_RENAMES.map(({ path }) => ({ path, classification: "behavior" })) }] });
  repository.semantic("stage", "finish");
  return repository;
}
