// Git settings and a stage that show whether a diff of the CLI or the viewer
// agrees with the stage inventory whatever the user's Git configuration.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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
      "core.bigFileThreshold": "1",
    },
    env: { GIT_DIFF_OPTS: "--unified=0" },
  },
};

/** Runs `run` with a group of HOSTILE_GIT set in the repository at `root` and
 * in this process's environment, which child processes inherit; both are
 * restored afterwards. */
export async function withHostileGit(root, group, run) {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const { config, env = {} } = HOSTILE_GIT[group];
  const configFile = path.resolve(root, git("rev-parse", "--git-path", "config"));
  const previousConfig = fs.readFileSync(configFile);
  const previousEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(config)) git("config", key, value);
    Object.assign(process.env, env);
    return await run();
  } finally {
    fs.writeFileSync(configFile, previousConfig);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Forty lines ending in a blank line and a last line, so a change at the end
 * shows an empty context line. */
export const fileLines = (name) => `${Array.from({ length: 38 }, (_, index) => `${name} line ${index}`).join("\n")}\n\nend\n`;

/** Commits a submodule (a gitlink and a .gitmodules entry that ignores it) and
 * three files of fileLines; Git compares gitlinks without the submodule's
 * objects, so none is cloned. Returns the commit. */
export function commitSubmoduleAndFiles(repository) {
  repository.git("config", "core.autocrlf", "false");
  fs.writeFileSync(repository.path(".gitmodules"), '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n\tignore = all\n');
  fs.writeFileSync(repository.path("first.txt"), fileLines("first"));
  fs.writeFileSync(repository.path("second.txt"), fileLines("second"));
  fs.writeFileSync(repository.path("third.txt"), fileLines("third"));
  repository.git("add", ".gitmodules", "first.txt", "second.txt", "third.txt");
  repository.git("update-index", "--add", "--cacheinfo", `160000,${repository.git("rev-parse", "HEAD")},sub`);
  repository.git("commit", "-m", "Add submodule and files");
  return repository.git("rev-parse", "HEAD");
}

/** Commits an update of the submodule, renames of two files, the first with a
 * line appended, the second also with its first line changed, and a line
 * appended to the third. */
export function commitSubmoduleUpdateAndRenames(repository) {
  repository.git("update-index", "--cacheinfo", `160000,${repository.git("rev-parse", "HEAD")},sub`);
  for (const [from, to] of [["first.txt", "renamed-first.txt"], ["second.txt", "renamed-second.txt"]]) {
    repository.git("mv", from, to);
    let contents = `${fs.readFileSync(repository.path(to), "utf8")}edited\n`;
    if (to === "renamed-second.txt") contents = contents.replace("second line 0\n", "changed\n");
    fs.writeFileSync(repository.path(to), contents);
    repository.git("add", to);
  }
  fs.appendFileSync(repository.path("third.txt"), "edited\n");
  repository.git("add", "third.txt");
  repository.git("commit", "-m", "Update submodule and rename files");
  return repository.git("rev-parse", "HEAD");
}

/** The inventory of the stage commitSubmoduleUpdateAndRenames makes. */
export const UPDATE_AND_RENAMES = [
  { path: "renamed-first.txt", kind: "renamed", previousPath: "first.txt" },
  { path: "renamed-second.txt", kind: "renamed", previousPath: "second.txt" },
  { path: "sub", kind: "modified" },
  { path: "third.txt", kind: "modified" },
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
