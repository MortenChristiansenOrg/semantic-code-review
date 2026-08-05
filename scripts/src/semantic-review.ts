#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  commandOptionNames,
  renderCliHelp,
  semanticReviewApi,
} from "./command-api.js";
import {
  assertKnownOptions,
  flag,
  option,
  parseArguments,
  repeatedOption,
  splitPair,
} from "./shared/arguments.js";
import { fail } from "./shared/errors.js";
import { git, gitRaw } from "./shared/git.js";
import { listJsonFiles, readJson, writeJson } from "./shared/json.js";

const MANIFEST_SCHEMA =
  "https://semantic-code-review.dev/schemas/v0.1/manifest.schema.json";
const REQUIREMENT_SCHEMA =
  "https://semantic-code-review.dev/schemas/v0.1/requirement.schema.json";
const STAGE_SCHEMA =
  "https://semantic-code-review.dev/schemas/v0.1/stage.schema.json";
const WORK_STAGE_SCHEMA =
  "https://semantic-code-review.dev/skills/semantic-flow/v0.1/work-stage.schema.json";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(scriptDirectory, "..");
const defaultSchemaDirectory = path.resolve(
  skillDirectory,
  "references",
  "schema",
);
const schemaDirectory =
  process.env.SEMANTIC_REVIEW_SCHEMA_DIR ?? defaultSchemaDirectory;
const workStageSchemaPath = path.join(
  skillDirectory,
  "references",
  "work-stage.schema.json",
);

const HELP = renderCliHelp(semanticReviewApi);

function repositoryRoot() {
  const root = git(["rev-parse", "--show-toplevel"], { cwd: process.cwd() });
  if (!root) {
    fail("Run this command inside a Git repository.");
  }
  return path.resolve(root);
}

function pathsFor(root) {
  const artifact = path.join(root, ".semantic-review");
  return {
    root,
    artifact,
    manifest: path.join(artifact, "manifest.json"),
    requirements: path.join(artifact, "requirements"),
    stages: path.join(artifact, "stages"),
    work: path.join(artifact, ".work"),
    workStages: path.join(artifact, ".work", "stages"),
  };
}

function formatPath(value) {
  return value.split(path.sep).join("/");
}

function schemaValidator() {
  const required = [
    "common.schema.json",
    "manifest.schema.json",
    "requirement.schema.json",
    "stage.schema.json",
  ];
  for (const file of required) {
    if (!fs.existsSync(path.join(schemaDirectory, file))) {
      fail(
        `Schema ${file} was not found in ${schemaDirectory}. Rebuild the semantic-flow skill or set SEMANTIC_REVIEW_SCHEMA_DIR.`,
      );
    }
  }

  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
    validateFormats: true,
  });
  addFormats(ajv);

  for (const file of required) {
    ajv.addSchema(readJson(path.join(schemaDirectory, file)));
  }
  ajv.addSchema(readJson(workStageSchemaPath));
  return ajv;
}

function validateDocument(ajv, value, file) {
  const schemaId = value?.$schema;
  if (typeof schemaId !== "string") {
    fail(`${file}: missing string $schema.`);
  }
  const validator = ajv.getSchema(schemaId);
  if (!validator) {
    fail(`${file}: unsupported schema ${schemaId}.`);
  }
  if (!validator(value)) {
    const errors = validator.errors
      .map(
        (error) =>
          `${file}${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
      )
      .join("\n");
    fail(errors);
  }
}

function loadArtifact(paths, { includeWork = true } = {}) {
  if (!fs.existsSync(paths.manifest)) {
    fail(`No semantic review manifest exists at ${paths.manifest}.`);
  }

  const manifest = readJson(paths.manifest);
  const requirements = new Map();
  for (const id of manifest.requirements ?? []) {
    const file = path.join(paths.requirements, `${id}.json`);
    if (!fs.existsSync(file)) {
      fail(`Manifest requirement ${id} is missing ${file}.`);
    }
    requirements.set(id, readJson(file));
  }

  const stages = new Map();
  for (const id of manifest.stages ?? []) {
    const file = path.join(paths.stages, `${id}.json`);
    if (!fs.existsSync(file)) {
      fail(`Manifest stage ${id} is missing ${file}.`);
    }
    stages.set(id, readJson(file));
  }

  const workStages = new Map();
  if (includeWork) {
    for (const file of listJsonFiles(paths.workStages)) {
      const stage = readJson(file);
      const filenameId = path.basename(file, ".json");
      if (stage.id !== filenameId) {
        fail(
          `Working stage file ${formatPath(path.relative(paths.artifact, file))} has internal ID ${stage.id}.`,
        );
      }
      if (workStages.has(stage.id)) {
        fail(`Working stage ${stage.id} is defined more than once.`);
      }
      workStages.set(stage.id, stage);
    }
  }

  return { manifest, requirements, stages, workStages };
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return [...duplicates];
}

function reachable(dependencies, start, target, visited = new Set()) {
  if (start === target) {
    return true;
  }
  if (visited.has(start)) {
    return false;
  }
  visited.add(start);
  for (const next of dependencies.get(start) ?? []) {
    if (reachable(dependencies, next, target, visited)) {
      return true;
    }
  }
  return false;
}

function commitObject(root, revision) {
  const commit = git(["rev-parse", "--verify", `${revision}^{commit}`], {
    cwd: root,
  });
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    fail(`Revision ${revision} did not resolve to a full SHA-1 commit ID.`);
  }
  return commit;
}

function assertCleanWorkingTree(root, action) {
  const status = git(
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: root },
  );
  if (status) {
    fail(
      `${action} requires a clean worktree. Commit, stash, or remove these changes first:\n${status}`,
    );
  }
}

function commitParents(root, commit) {
  const output = git(["show", "-s", "--format=%P", commit], { cwd: root });
  return output ? output.split(/\s+/) : [];
}

function branchCommit(root, branch) {
  return commitObject(root, `refs/heads/${branch}`);
}

function currentBranch(root) {
  return git(["symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd: root,
    allowFailure: true,
  });
}

function checkedOutBranches(root) {
  const output = git(["worktree", "list", "--porcelain"], { cwd: root });
  return new Set(
    output
      .split(/\r?\n/)
      .filter((line) => line.startsWith("branch refs/heads/"))
      .map((line) => line.slice("branch refs/heads/".length)),
  );
}

function isAncestor(root, ancestor, descendant) {
  return git(["merge-base", ancestor, descendant], {
    cwd: root,
    allowFailure: true,
  }) === ancestor;
}

function assertLinearRange(root, base, head, label) {
  if (!isAncestor(root, base, head)) {
    fail(`${label} head ${head} must descend from ${base}.`);
  }
  const merges = git(["rev-list", "--merges", `${base}..${head}`], {
    cwd: root,
  });
  if (merges) {
    fail(`${label} must not contain merge commits.`);
  }
}

function stageBranchName(manifest, index, id) {
  return `${manifest.branchPrefix}/${String(index + 1).padStart(2, "0")}-${id}`;
}

function changedFiles(root, parent, commit) {
  const result = spawnSync(
    "git",
    ["diff", "--name-status", "-z", "--find-renames=50%", parent, commit],
    {
      cwd: root,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    fail(
      `Cannot derive changed files: ${result.stderr.toString("utf8").trim()}`,
    );
  }

  const fields = result.stdout
    .toString("utf8")
    .split("\0")
    .filter((field) => field.length > 0);
  const files = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index];
    index += 1;
    const code = status[0];

    if (code === "R") {
      const previousPath = fields[index];
      const currentPath = fields[index + 1];
      if (!previousPath || !currentPath) {
        fail(`Malformed Git rename record for commit ${commit}.`);
      }
      files.push({
        path: currentPath,
        kind: "renamed",
        previousPath,
      });
      index += 2;
      continue;
    }

    const currentPath = fields[index];
    if (!currentPath) {
      fail(`Malformed Git change record for commit ${commit}.`);
    }
    const kinds = {
      A: "added",
      M: "modified",
      D: "deleted",
    };
    const kind = kinds[code];
    if (!kind) {
      fail(
        `Git status ${status} for ${currentPath} is unsupported by format 0.1.`,
      );
    }
    files.push({ path: currentPath, kind });
    index += 1;
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  if (files.length === 0) {
    fail(`Stage head ${commit} has no changes relative to ${parent}.`);
  }
  for (const file of files) {
    if (
      file.path === ".semantic-review" ||
      file.path.startsWith(".semantic-review/") ||
      file.previousPath === ".semantic-review" ||
      file.previousPath?.startsWith(".semantic-review/")
    ) {
      fail(`Stage head ${commit} contains semantic review artifact files.`);
    }
  }
  return files;
}

function sameChanges(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateSemantic(paths, artifact, { validateGit = true } = {}) {
  const errors = [];
  const { manifest, requirements, stages, workStages } = artifact;

  const requirementFiles = listJsonFiles(paths.requirements).map((file) =>
    path.basename(file, ".json"),
  );
  const stageFiles = listJsonFiles(paths.stages).map((file) =>
    path.basename(file, ".json"),
  );
  for (const id of requirementFiles) {
    if (!manifest.requirements.includes(id)) {
      errors.push(`Unlisted requirement file requirements/${id}.json.`);
    }
  }
  for (const id of stageFiles) {
    if (!manifest.stages.includes(id)) {
      errors.push(`Unlisted stage file stages/${id}.json.`);
    }
  }

  const criterionIds = new Map();
  for (const [id, requirement] of requirements) {
    if (requirement.id !== id) {
      errors.push(`Requirement ${id} has internal ID ${requirement.id}.`);
    }
    const criteria = requirement.acceptanceCriteria.map((item) => item.id);
    for (const duplicate of duplicateValues(criteria)) {
      errors.push(`Requirement ${id} repeats criterion ID ${duplicate}.`);
    }
    criterionIds.set(id, new Set(criteria));
  }

  const dependencies = new Map();
  const seenStages = new Set();
  const branches = new Set();
  const heads = new Set();
  const localCollections = [
    "decisions",
    "assumptions",
    "alternatives",
    "failedAttempts",
    "risks",
    "validation",
    "openQuestions",
  ];

  for (const id of manifest.stages) {
    const stage = stages.get(id);
    if (stage.id !== id) {
      errors.push(`Stage ${id} has internal ID ${stage.id}.`);
    }
    dependencies.set(id, stage.dependsOn);
    for (const dependency of stage.dependsOn) {
      if (!stages.has(dependency)) {
        errors.push(`Stage ${id} depends on missing stage ${dependency}.`);
      } else if (!seenStages.has(dependency)) {
        errors.push(`Stage ${id} depends on later stage ${dependency}.`);
      }
    }
    for (const reference of stage.requirementRefs) {
      const [requirementId, criterionId] = reference.split("#", 2);
      if (!criterionIds.get(requirementId)?.has(criterionId)) {
        errors.push(`Stage ${id} has unresolved requirement ref ${reference}.`);
      }
    }
    for (const collection of localCollections) {
      const ids = stage[collection].map((item) => item.id);
      for (const duplicate of duplicateValues(ids)) {
        errors.push(`Stage ${id} repeats ${collection} ID ${duplicate}.`);
      }
    }
    const changedPaths = stage.change.files.map((item) => item.path);
    for (const duplicate of duplicateValues(changedPaths)) {
      errors.push(`Stage ${id} repeats changed path ${duplicate}.`);
    }
    const expectedBranch = stageBranchName(
      manifest,
      manifest.stages.indexOf(id),
      id,
    );
    if (stage.change.branch !== expectedBranch) {
      errors.push(
        `Stage ${id} branch ${stage.change.branch} should be ${expectedBranch}.`,
      );
    }
    if (branches.has(stage.change.branch)) {
      errors.push(`Stage ${id} repeats branch ${stage.change.branch}.`);
    }
    if (heads.has(stage.change.headRevision)) {
      errors.push(`Stage ${id} repeats head ${stage.change.headRevision}.`);
    }
    branches.add(stage.change.branch);
    heads.add(stage.change.headRevision);
    seenStages.add(id);
  }

  for (const [id, directDependencies] of dependencies) {
    for (const dependency of directDependencies) {
      for (const other of directDependencies) {
        if (
          dependency !== other &&
          reachable(dependencies, other, dependency)
        ) {
          errors.push(
            `Stage ${id} redundantly lists transitive dependency ${dependency}.`,
          );
        }
      }
    }
  }

  for (const [id, stage] of workStages) {
    if (stages.has(id)) {
      errors.push(`Stage ${id} exists as both working and canonical data.`);
    }
    for (const dependency of stage.dependsOn) {
      if (!stages.has(dependency)) {
        errors.push(
          `Working stage ${id} depends on missing finalized stage ${dependency}.`,
        );
      }
    }
    for (const dependency of stage.dependsOn) {
      for (const other of stage.dependsOn) {
        if (
          dependency !== other &&
          reachable(dependencies, other, dependency)
        ) {
          errors.push(
            `Working stage ${id} redundantly lists transitive dependency ${dependency}.`,
          );
        }
      }
    }
    for (const reference of stage.requirementRefs) {
      const [requirementId, criterionId] = reference.split("#", 2);
      if (!criterionIds.get(requirementId)?.has(criterionId)) {
        errors.push(
          `Working stage ${id} has unresolved requirement ref ${reference}.`,
        );
      }
    }
    for (const collection of localCollections) {
      const ids = stage[collection].map((item) => item.id);
      for (const duplicate of duplicateValues(ids)) {
        errors.push(
          `Working stage ${id} repeats ${collection} ID ${duplicate}.`,
        );
      }
      const expectedBranch = stageBranchName(manifest, manifest.stages.length, id);
      if (stage.branch !== expectedBranch) {
        errors.push(
          `Working stage ${id} branch ${stage.branch} should be ${expectedBranch}.`,
        );
      }
    }
  }
  if (workStages.size > 1) {
    errors.push("Only one working stage may exist at a time.");
  }

  if (errors.length > 0) {
    fail(errors.join("\n"));
  }

  if (!validateGit) {
    return;
  }

  const base = commitObject(paths.root, manifest.baseRevision);
  let expectedBaseBranch = manifest.targetBranch;
  let expectedParent = base;
  for (const [index, id] of manifest.stages.entries()) {
    const stage = stages.get(id);
    const { branch, baseBranch, baseRevision, headRevision } = stage.change;
    if (branch !== stageBranchName(manifest, index, id)) {
      fail(`Stage ${id} branch ${branch} does not follow the stack convention.`);
    }
    if (baseBranch !== expectedBaseBranch) {
      fail(
        `Stage ${id} base branch ${baseBranch} should be ${expectedBaseBranch}.`,
      );
    }
    if (baseRevision !== expectedParent) {
      fail(
        `Stage ${id} base revision ${baseRevision} should be ${expectedParent}.`,
      );
    }
    const branchHead = branchCommit(paths.root, branch);
    const head = commitObject(paths.root, headRevision);
    if (branchHead !== head) {
      fail(
        `Stage ${id} branch ${branch} moved from ${head} to ${branchHead}; run restack --from ${id}.`,
      );
    }
    assertLinearRange(paths.root, expectedParent, head, `Stage ${id}`);
    const actualFiles = changedFiles(paths.root, expectedParent, head);
    if (!sameChanges(stage.change.files, actualFiles)) {
      fail(
        `Stage ${id} file inventory is stale.\nExpected: ${JSON.stringify(actualFiles)}\nActual:   ${JSON.stringify(stage.change.files)}`,
      );
    }
    expectedBaseBranch = branch;
    expectedParent = head;
  }
}

function validateArtifact(
  paths,
  {
    schemaOnly = false,
    publish = false,
    quiet = false,
    validateGit = true,
  } = {},
) {
  const ajv = schemaValidator();
  const artifact = loadArtifact(paths);

  validateDocument(ajv, artifact.manifest, paths.manifest);
  for (const [id, requirement] of artifact.requirements) {
    validateDocument(
      ajv,
      requirement,
      path.join(paths.requirements, `${id}.json`),
    );
  }
  for (const [id, stage] of artifact.stages) {
    validateDocument(ajv, stage, path.join(paths.stages, `${id}.json`));
  }
  for (const [id, stage] of artifact.workStages) {
    validateDocument(ajv, stage, path.join(paths.workStages, `${id}.json`));
  }

  if (!schemaOnly) {
    validateSemantic(paths, artifact, { validateGit });
  }

  if (publish) {
    if (artifact.manifest.stages.length === 0) {
      fail("Publication validation requires at least one finalized stage.");
    }
    if (artifact.workStages.size > 0) {
      fail(
        `Publication validation found unfinished stages: ${[...artifact.workStages.keys()].join(", ")}.`,
      );
    }
  }

  if (!quiet) {
    const mode = schemaOnly ? "schema" : publish ? "publication" : "full";
    console.log(
      `Semantic review ${mode} validation passed: ${artifact.requirements.size} requirement(s), ${artifact.stages.size} finalized stage(s), ${artifact.workStages.size} working stage(s).`,
    );
  }
  return artifact;
}

function ensureArtifactExcluded(root) {
  const exclude = git(["rev-parse", "--git-path", "info/exclude"], {
    cwd: root,
  });
  const resolvedExclude = path.isAbsolute(exclude)
    ? exclude
    : path.resolve(root, exclude);
  fs.mkdirSync(path.dirname(resolvedExclude), { recursive: true });
  const existing = fs.existsSync(resolvedExclude)
    ? fs.readFileSync(resolvedExclude, "utf8")
    : "";
  const lines = existing.split(/\r?\n/);
  if (!lines.includes(".semantic-review/")) {
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(
      resolvedExclude,
      `${prefix}.semantic-review/\n`,
      "utf8",
    );
  }
}

function requirementFromOptions(options) {
  const criteria = repeatedOption(options, "criterion").map((value) => {
    const [id, text] = splitPair(value, "--criterion");
    return { id, text };
  });
  if (criteria.length === 0) {
    fail("At least one --criterion <id>=<text> is required.");
  }

  const source: Record<string, unknown> = {
    kind: option(options, "source-kind", { required: true }),
    reference: option(options, "source-reference", { required: true }),
  };
  const sourceUrl = option(options, "source-url");
  if (sourceUrl) {
    source.url = sourceUrl;
  }

  return {
    $schema: REQUIREMENT_SCHEMA,
    id: option(options, "requirement-id", { required: true }),
    title: option(options, "requirement-title", { required: true }),
    summary: option(options, "requirement-summary", { required: true }),
    source,
    acceptanceCriteria: criteria,
  };
}

function initialize(paths, options) {
  assertKnownOptions(options, commandOptionNames(semanticReviewApi, "init"));
  if (fs.existsSync(paths.manifest)) {
    fail(`A semantic review already exists at ${paths.manifest}.`);
  }
  if (
    fs.existsSync(paths.artifact) &&
    fs.readdirSync(paths.artifact).length > 0
  ) {
    fail(
      `${paths.artifact} already contains files but has no manifest. Inspect or remove it before initialization.`,
    );
  }
  assertCleanWorkingTree(paths.root, "Initialization");

  const requirement = requirementFromOptions(options);
  const reviewId = option(options, "review-id", { required: true });
  const targetBranch = option(options, "target-branch", { required: true });
  git(["check-ref-format", "--branch", targetBranch], { cwd: paths.root });
  const targetHead = branchCommit(paths.root, targetBranch);
  const baseRevision = commitObject(
    paths.root,
    option(options, "base-revision", { defaultValue: targetBranch }),
  );
  if (baseRevision !== targetHead) {
    fail(
      `Base revision ${baseRevision} must equal target branch ${targetBranch} head ${targetHead}.`,
    );
  }
  const branchPrefix = option(options, "branch-prefix", {
    defaultValue: `semantic-review/${reviewId}`,
  });
  git(["check-ref-format", "--branch", `${branchPrefix}/01-probe`], {
    cwd: paths.root,
  });
  const manifest = {
    $schema: MANIFEST_SCHEMA,
    formatVersion: "0.1",
    reviewId,
    title: option(options, "title", { required: true }),
    summary: option(options, "summary", { required: true }),
    baseRevision,
    targetBranch,
    branchPrefix,
    requirements: [requirement.id],
    stages: [],
  };

  ensureArtifactExcluded(paths.root);
  try {
    writeJson(
      path.join(paths.requirements, `${requirement.id}.json`),
      requirement,
    );
    writeJson(paths.manifest, manifest);
    validateArtifact(paths, { quiet: true });
  } catch (error) {
    fs.rmSync(paths.artifact, { recursive: true, force: true });
    throw error;
  }
  console.log(`Initialized semantic review ${manifest.reviewId}.`);
}

function addRequirement(paths, options) {
  assertKnownOptions(
    options,
    commandOptionNames(semanticReviewApi, "requirement add"),
  );
  const artifact = validateArtifact(paths, { quiet: true });
  const requirement = requirementFromOptions(options);
  if (artifact.requirements.has(requirement.id)) {
    fail(`Requirement ${requirement.id} already exists.`);
  }

  const file = path.join(paths.requirements, `${requirement.id}.json`);
  const oldManifest = structuredClone(artifact.manifest);
  artifact.manifest.requirements.push(requirement.id);
  try {
    writeJson(file, requirement);
    writeJson(paths.manifest, artifact.manifest);
    validateArtifact(paths, { quiet: true });
  } catch (error) {
    fs.rmSync(file, { force: true });
    writeJson(paths.manifest, oldManifest);
    throw error;
  }
  console.log(`Added requirement ${requirement.id}.`);
}

function beginStage(paths, options) {
  assertKnownOptions(
    options,
    commandOptionNames(semanticReviewApi, "stage begin"),
  );
  const artifact = validateArtifact(paths, { quiet: true });
  assertCleanWorkingTree(paths.root, "Beginning a stage");
  if (artifact.workStages.size > 0) {
    fail(
      `Finish the current working stage before beginning another: ${[...artifact.workStages.keys()].join(", ")}.`,
    );
  }

  const id = option(options, "id", { required: true });
  if (artifact.stages.has(id)) {
    fail(`Stage ${id} is already finalized.`);
  }
  const file = path.join(paths.workStages, `${id}.json`);
  if (fs.existsSync(file)) {
    fail(`Working stage ${id} already exists.`);
  }

  const branch = stageBranchName(artifact.manifest, artifact.manifest.stages.length, id);
  git(["check-ref-format", "--branch", branch], { cwd: paths.root });
  const existingBranch = git(["rev-parse", "--verify", `refs/heads/${branch}`], {
    cwd: paths.root,
    allowFailure: true,
  });
  if (existingBranch) {
    fail(`Stage branch ${branch} already exists at ${existingBranch}.`);
  }
  const previousId = artifact.manifest.stages.at(-1);
  const parent = previousId
    ? artifact.stages.get(previousId).change.headRevision
    : artifact.manifest.baseRevision;
  const head = commitObject(paths.root, "HEAD");
  if (head !== parent) {
    fail(
      `Beginning ${id} requires HEAD at stack tip ${parent}, but HEAD is ${head}.`,
    );
  }

  const stage = {
    $schema: WORK_STAGE_SCHEMA,
    id,
    title: option(options, "title", { required: true }),
    summary: option(options, "summary", { required: true }),
    branch,
    dependsOn: repeatedOption(options, "depends-on"),
    requirementRefs: repeatedOption(options, "requirement-ref"),
    rationale: option(options, "rationale", { required: true }),
    decisions: [],
    assumptions: [],
    alternatives: [],
    failedAttempts: [],
    risks: [],
    validation: [],
    openQuestions: [],
  };
  if (stage.requirementRefs.length === 0) {
    fail("At least one --requirement-ref is required.");
  }

  const originalBranch = currentBranch(paths.root);
  git(["switch", "-c", branch, parent], { cwd: paths.root });
  try {
    writeJson(file, stage);
    validateArtifact(paths, { quiet: true });
  } catch (error) {
    fs.rmSync(file, { force: true });
    if (originalBranch) {
      git(["switch", originalBranch], { cwd: paths.root });
    } else {
      git(["switch", "--detach", parent], { cwd: paths.root });
    }
    git(["branch", "-D", branch], { cwd: paths.root });
    throw error;
  }
  console.log(`Began working stage ${id} on ${branch}.`);
}

function workingStage(paths, id) {
  const file = path.join(paths.workStages, `${id}.json`);
  if (!fs.existsSync(file)) {
    fail(`Working stage ${id} does not exist.`);
  }
  return { file, stage: readJson(file) };
}

function updateWorkingStage(paths, id, update) {
  validateArtifact(paths, { quiet: true, validateGit: false });
  const { file, stage } = workingStage(paths, id);
  const oldStage = structuredClone(stage);
  update(stage);
  try {
    writeJson(file, stage);
    validateArtifact(paths, { quiet: true, validateGit: false });
  } catch (error) {
    writeJson(file, oldStage);
    throw error;
  }
}

function updateStageContext(paths, id, finalized, update) {
  if (!finalized) {
    updateWorkingStage(paths, id, update);
    return;
  }

  const artifact = validateArtifact(paths, { quiet: true });
  const stage = artifact.stages.get(id);
  if (!stage) {
    fail(`Finalized stage ${id} does not exist.`);
  }
  const file = path.join(paths.stages, `${id}.json`);
  const oldStage = structuredClone(stage);
  update(stage);
  try {
    writeJson(file, stage);
    validateArtifact(paths, { quiet: true });
  } catch (error) {
    writeJson(file, oldStage);
    throw error;
  }
}

function setStage(paths, options) {
  assertKnownOptions(
    options,
    commandOptionNames(semanticReviewApi, "stage set"),
  );
  const id = option(options, "id", { required: true });
  const title = option(options, "title");
  const summary = option(options, "summary");
  const rationale = option(options, "rationale");
  const hasDependencies = options.has("depends-on");
  const hasRequirementRefs = options.has("requirement-ref");
  if (
    title === undefined &&
    summary === undefined &&
    rationale === undefined &&
    !hasDependencies &&
    !hasRequirementRefs
  ) {
    fail("stage set requires at least one field to update.");
  }

  updateWorkingStage(paths, id, (stage) => {
    if (title !== undefined) stage.title = title;
    if (summary !== undefined) stage.summary = summary;
    if (rationale !== undefined) stage.rationale = rationale;
    if (hasDependencies) stage.dependsOn = repeatedOption(options, "depends-on");
    if (hasRequirementRefs) {
      stage.requirementRefs = repeatedOption(options, "requirement-ref");
    }
  });
  console.log(`Updated working stage ${id}.`);
}

function itemForKind(kind, options) {
  const id = option(options, "item-id", { required: true });
  switch (kind) {
    case "decision":
      return {
        collection: "decisions",
        value: {
          id,
          category: option(options, "category", { required: true }),
          summary: option(options, "summary", { required: true }),
          rationale: option(options, "rationale", { required: true }),
        },
        allowed: ["category", "summary", "rationale"],
      };
    case "assumption":
      return {
        collection: "assumptions",
        value: {
          id,
          statement: option(options, "statement", { required: true }),
          riskIfWrong: option(options, "risk-if-wrong", { required: true }),
        },
        allowed: ["statement", "risk-if-wrong"],
      };
    case "alternative":
      return {
        collection: "alternatives",
        value: {
          id,
          approach: option(options, "approach", { required: true }),
          reasonRejected: option(options, "reason-rejected", { required: true }),
        },
        allowed: ["approach", "reason-rejected"],
      };
    case "failed-attempt":
      return {
        collection: "failedAttempts",
        value: {
          id,
          approach: option(options, "approach", { required: true }),
          outcome: option(options, "outcome", { required: true }),
          lesson: option(options, "lesson", { required: true }),
        },
        allowed: ["approach", "outcome", "lesson"],
      };
    case "risk": {
      const value: Record<string, unknown> = {
        id,
        summary: option(options, "summary", { required: true }),
      };
      const mitigation = option(options, "mitigation");
      if (mitigation !== undefined) value.mitigation = mitigation;
      return {
        collection: "risks",
        value,
        allowed: ["summary", "mitigation"],
      };
    }
    case "question":
      return {
        collection: "openQuestions",
        value: {
          id,
          question: option(options, "question", { required: true }),
        },
        allowed: ["question"],
      };
    default:
      fail(
        `Unsupported record kind ${kind}. Use decision, assumption, alternative, failed-attempt, risk, or question.`,
      );
  }
}

function recordStageItem(paths, options) {
  assertKnownOptions(
    options,
    commandOptionNames(semanticReviewApi, "stage record"),
  );
  const stageId = option(options, "stage", { required: true });
  const kind = option(options, "kind", { required: true });
  const item = itemForKind(kind, options);
  const replace = flag(options, "replace");
  const finalized = flag(options, "finalized");
  assertKnownOptions(
    options,
    new Set([
      "stage",
      "kind",
      "item-id",
      "replace",
      "finalized",
      ...item.allowed,
    ]),
  );

  updateStageContext(paths, stageId, finalized, (stage) => {
    const index = stage[item.collection].findIndex(
      (existing) => existing.id === item.value.id,
    );
    if (index >= 0 && !replace) {
      fail(
        `Working stage ${stageId} already has ${item.collection} item ${item.value.id}.`,
      );
    }
    if (index < 0 && replace) {
      fail(
        `Working stage ${stageId} has no ${item.collection} item ${item.value.id} to replace.`,
      );
    }
    if (index >= 0) {
      stage[item.collection][index] = item.value;
    } else {
      stage[item.collection].push(item.value);
    }
  });
  console.log(
    `${replace ? "Replaced" : "Recorded"} ${kind} ${item.value.id} for ${finalized ? "finalized " : ""}${stageId}.`,
  );
}

function recordValidation(paths, options) {
  assertKnownOptions(
    options,
    commandOptionNames(semanticReviewApi, "stage validation"),
  );
  const stageId = option(options, "stage", { required: true });
  const replace = flag(options, "replace");
  const finalized = flag(options, "finalized");
  const value: Record<string, unknown> = {
    id: option(options, "item-id", { required: true }),
    type: option(options, "type", { required: true }),
    status: option(options, "status", { required: true }),
    summary: option(options, "summary", { required: true }),
  };
  const command = option(options, "command");
  if (command !== undefined) {
    value.command = command;
  }

  updateStageContext(paths, stageId, finalized, (stage) => {
    const index = stage.validation.findIndex(
      (existing) => existing.id === value.id,
    );
    if (index >= 0 && !replace) {
      fail(
        `Working stage ${stageId} already has validation item ${value.id}.`,
      );
    }
    if (index < 0 && replace) {
      fail(
        `Working stage ${stageId} has no validation item ${value.id} to replace.`,
      );
    }
    if (index >= 0) {
      stage.validation[index] = value;
    } else {
      stage.validation.push(value);
    }
  });
  console.log(
    `${replace ? "Replaced" : "Recorded"} validation ${value.id} for ${finalized ? "finalized " : ""}${stageId}.`,
  );
}

function canonicalStage(
  workStage,
  baseBranch,
  baseRevision,
  headRevision,
  files,
) {
  return {
    $schema: STAGE_SCHEMA,
    id: workStage.id,
    title: workStage.title,
    summary: workStage.summary,
    dependsOn: workStage.dependsOn,
    requirementRefs: workStage.requirementRefs,
    change: {
      branch: workStage.branch,
      baseBranch,
      baseRevision,
      headRevision,
      files,
    },
    rationale: workStage.rationale,
    decisions: workStage.decisions,
    assumptions: workStage.assumptions,
    alternatives: workStage.alternatives,
    failedAttempts: workStage.failedAttempts,
    risks: workStage.risks,
    validation: workStage.validation,
    openQuestions: workStage.openQuestions,
  };
}

function finishStage(paths, options) {
  assertKnownOptions(
    options,
    commandOptionNames(semanticReviewApi, "stage finish"),
  );
  const artifact = validateArtifact(paths, { quiet: true });
  assertCleanWorkingTree(paths.root, "Finalizing a stage");
  const id = option(options, "id", { required: true });
  const { file: workFile, stage: workStage } = workingStage(paths, id);
  if (artifact.stages.has(id)) {
    fail(`Stage ${id} is already finalized.`);
  }

  const branch = currentBranch(paths.root);
  if (branch !== workStage.branch) {
    fail(
      `Finalizing ${id} requires checked-out stage branch ${workStage.branch}, not ${branch ?? "detached HEAD"}.`,
    );
  }
  const headRevision = branchCommit(paths.root, workStage.branch);
  if (commitObject(paths.root, "HEAD") !== headRevision) {
    fail(`HEAD does not match stage branch ${workStage.branch}.`);
  }
  const previousId = artifact.manifest.stages.at(-1);
  const baseBranch = previousId
    ? artifact.stages.get(previousId).change.branch
    : artifact.manifest.targetBranch;
  const baseRevision = previousId
    ? artifact.stages.get(previousId).change.headRevision
    : artifact.manifest.baseRevision;
  assertLinearRange(paths.root, baseRevision, headRevision, `Stage ${id}`);
  const files = changedFiles(paths.root, baseRevision, headRevision);
  const stage = canonicalStage(
    workStage,
    baseBranch,
    baseRevision,
    headRevision,
    files,
  );
  const stageFile = path.join(paths.stages, `${id}.json`);
  const oldManifest = structuredClone(artifact.manifest);
  artifact.manifest.stages.push(id);

  try {
    writeJson(stageFile, stage);
    writeJson(paths.manifest, artifact.manifest);
    fs.rmSync(workFile);
    validateArtifact(paths, { quiet: true });
  } catch (error) {
    fs.rmSync(stageFile, { force: true });
    writeJson(paths.manifest, oldManifest);
    writeJson(workFile, workStage);
    throw error;
  }
  console.log(`Finalized stage ${id} on ${workStage.branch} at ${headRevision}.`);
}

function discardStage(paths, options) {
  assertKnownOptions(
    options,
    commandOptionNames(semanticReviewApi, "stage discard"),
  );
  const id = option(options, "id", { required: true });
  validateArtifact(paths, { quiet: true, validateGit: false });
  const { file } = workingStage(paths, id);
  fs.rmSync(file);
  validateArtifact(paths, { quiet: true, validateGit: false });
  console.log(`Discarded working stage ${id}.`);
}

function commitMetadata(root, commit) {
  return {
    authorName: git(["show", "-s", "--format=%an", commit], { cwd: root }),
    authorEmail: git(["show", "-s", "--format=%ae", commit], { cwd: root }),
    authorDate: git(["show", "-s", "--format=%aI", commit], { cwd: root }),
    message: gitRaw(["show", "-s", "--format=%B", commit], {
      cwd: root,
    }),
  };
}

function applyCommitPatch({
  root,
  indexFile,
  baseTree,
  patchParent,
  patchCommit,
  metadataCommit,
  newParent,
}) {
  fs.rmSync(indexFile, { force: true });
  const env = { GIT_INDEX_FILE: indexFile };
  gitRaw(["read-tree", baseTree], { cwd: root, env });
  const patch = gitRaw(
    [
      "diff",
      "--binary",
      "--full-index",
      "--find-renames=50%",
      patchParent,
      patchCommit,
      "--",
    ],
    { cwd: root, encoding: "buffer" },
  );
  if (patch.length === 0) {
    fail(`Commit ${patchCommit} has no patch to apply.`);
  }
  gitRaw(["apply", "--cached", "--3way", "--whitespace=nowarn", "-"], {
    cwd: root,
    env,
    input: patch,
    encoding: "buffer",
  });
  const tree = gitRaw(["write-tree"], { cwd: root, env });
  const metadata = commitMetadata(root, metadataCommit);
  return gitRaw(["commit-tree", tree, "-p", newParent], {
    cwd: root,
    input: metadata.message,
    env: {
      GIT_AUTHOR_NAME: metadata.authorName,
      GIT_AUTHOR_EMAIL: metadata.authorEmail,
      GIT_AUTHOR_DATE: metadata.authorDate,
    },
  });
}

function commitsInRange(root, base, head, label) {
  assertLinearRange(root, base, head, label);
  const output = git(["rev-list", "--reverse", `${base}..${head}`], {
    cwd: root,
  });
  return output ? output.split(/\r?\n/) : [];
}

function replayRange(root, indexFile, oldBase, oldHead, newBase, label) {
  const commits = commitsInRange(root, oldBase, oldHead, label);
  if (commits.length === 0) {
    fail(`${label} has no commits to replay.`);
  }
  let newParent = newBase;
  for (const commit of commits) {
    const parents = commitParents(root, commit);
    if (parents.length !== 1) {
      fail(`${label} commit ${commit} must have exactly one parent.`);
    }
    newParent = applyCommitPatch({
      root,
      indexFile,
      baseTree: newParent,
      patchParent: parents[0],
      patchCommit: commit,
      metadataCommit: commit,
      newParent,
    });
  }
  return newParent;
}

function updateRefsAtomically(root, updates) {
  if (updates.length === 0) return;
  const commands = [
    "start",
    ...updates.map(
      ({ branch, next, previous }) =>
        `update refs/heads/${branch} ${next} ${previous}`,
    ),
    "prepare",
    "commit",
    "",
  ].join("\n");
  gitRaw(["update-ref", "--stdin"], { cwd: root, input: commands });
}

function restack(paths, options) {
  assertKnownOptions(options, commandOptionNames(semanticReviewApi, "restack"));
  assertCleanWorkingTree(paths.root, "Restacking");
  const artifact = validateArtifact(paths, {
    schemaOnly: true,
    quiet: true,
  });
  if (artifact.workStages.size > 0) {
    fail("Restacking requires every stage to be finalized.");
  }

  const fromId = option(options, "from");
  const baseOption = option(options, "base");
  if (!fromId && !baseOption) {
    fail("restack requires --from <stage-id> or --base <revision>.");
  }
  const fromIndex = fromId
    ? artifact.manifest.stages.indexOf(fromId)
    : artifact.manifest.stages.length;
  if (fromId && fromIndex < 0) {
    fail(`Stage ${fromId} does not exist.`);
  }
  const startIndex = baseOption ? 0 : fromIndex;
  const newBase = baseOption
    ? commitObject(paths.root, baseOption)
    : artifact.manifest.baseRevision;
  if (baseOption) {
    const targetHead = branchCommit(paths.root, artifact.manifest.targetBranch);
    if (newBase !== targetHead) {
      fail(
        `New base ${newBase} must equal target branch ${artifact.manifest.targetBranch} head ${targetHead}.`,
      );
    }
  }

  const indexFile = path.join(
    os.tmpdir(),
    `semantic-review-restack-${process.pid}-${Date.now()}.index`,
  );
  const plans = [];
  let parentBranch = artifact.manifest.targetBranch;
  let parentHead = newBase;

  try {
    for (const [index, id] of artifact.manifest.stages.entries()) {
      const stage = artifact.stages.get(id);
      const actualHead = branchCommit(paths.root, stage.change.branch);
      if (index < startIndex) {
        if (actualHead !== stage.change.headRevision) {
          fail(
            `Stage ${id} moved before the requested restack range; start from ${id}.`,
          );
        }
        parentBranch = stage.change.branch;
        parentHead = actualHead;
        continue;
      }

      let nextHead;
      if (isAncestor(paths.root, parentHead, actualHead)) {
        assertLinearRange(paths.root, parentHead, actualHead, `Stage ${id}`);
        nextHead = actualHead;
      } else {
        nextHead = replayRange(
          paths.root,
          indexFile,
          stage.change.baseRevision,
          actualHead,
          parentHead,
          `Stage ${id}`,
        );
      }
      plans.push({
        id,
        stage,
        file: path.join(paths.stages, `${id}.json`),
        branch: stage.change.branch,
        previousHead: actualHead,
        nextHead,
        baseBranch: parentBranch,
        baseRevision: parentHead,
      });
      parentBranch = stage.change.branch;
      parentHead = nextHead;
    }

    const refUpdates = plans
      .filter(({ previousHead, nextHead }) => previousHead !== nextHead)
      .map(({ branch, previousHead, nextHead }) => ({
        branch,
        previous: previousHead,
        next: nextHead,
      }));
    const checkedOut = checkedOutBranches(paths.root);
    const checkedOutUpdates = refUpdates
      .map(({ branch }) => branch)
      .filter((branch) => checkedOut.has(branch));
    if (checkedOutUpdates.length > 0) {
      fail(
        `Cannot move branch(es) checked out in a worktree: ${checkedOutUpdates.join(", ")}.`,
      );
    }
    if (
      baseOption &&
      branchCommit(paths.root, artifact.manifest.targetBranch) !== newBase
    ) {
      fail(
        `Target branch ${artifact.manifest.targetBranch} moved during restacking; retry from its new head.`,
      );
    }
    updateRefsAtomically(paths.root, refUpdates);

    const oldManifest = structuredClone(artifact.manifest);
    const backups = new Map(
      plans.map(({ file, stage }) => [file, structuredClone(stage)]),
    );
    artifact.manifest.baseRevision = newBase;
    try {
      for (const plan of plans) {
        plan.stage.change = {
          branch: plan.branch,
          baseBranch: plan.baseBranch,
          baseRevision: plan.baseRevision,
          headRevision: plan.nextHead,
          files: changedFiles(
            paths.root,
            plan.baseRevision,
            plan.nextHead,
          ),
        };
        writeJson(plan.file, plan.stage);
      }
      writeJson(paths.manifest, artifact.manifest);
      validateArtifact(paths, { quiet: true });
    } catch (error) {
      updateRefsAtomically(
        paths.root,
        refUpdates.map(({ branch, previous, next }) => ({
          branch,
          previous: next,
          next: previous,
        })),
      );
      for (const [file, value] of backups) {
        writeJson(file, value);
      }
      writeJson(paths.manifest, oldManifest);
      throw error;
    }

    console.log(
      `Restacked ${plans.length} stage branch(es)${baseOption ? ` onto ${newBase}` : ` from ${fromId}`}:`,
    );
    for (const plan of plans) {
      console.log(
        `  ${plan.branch}: ${plan.previousHead} -> ${plan.nextHead} (base ${plan.baseBranch})`,
      );
    }
  } finally {
    fs.rmSync(indexFile, { force: true });
  }
}

function repairArtifact(paths, options) {
  assertKnownOptions(options, commandOptionNames(semanticReviewApi, "repair"));
  if (!fs.existsSync(paths.manifest)) {
    fail(`No semantic review manifest exists at ${paths.manifest}.`);
  }
  const manifest = readJson(paths.manifest);
  const actions = [];
  const ambiguous = [];

  for (const file of listJsonFiles(paths.requirements)) {
    const id = path.basename(file, ".json");
    if (!manifest.requirements.includes(id)) {
      actions.push({ kind: "delete", file });
    }
  }

  for (const file of listJsonFiles(paths.stages)) {
    const id = path.basename(file, ".json");
    if (!manifest.stages.includes(id)) {
      const workFile = path.join(paths.workStages, `${id}.json`);
      if (fs.existsSync(workFile)) {
        actions.push({ kind: "delete", file });
      } else {
        ambiguous.push(formatPath(path.relative(paths.artifact, file)));
      }
    }
  }

  for (const id of manifest.stages) {
    const stageFile = path.join(paths.stages, `${id}.json`);
    const workFile = path.join(paths.workStages, `${id}.json`);
    if (!fs.existsSync(stageFile)) {
      ambiguous.push(formatPath(path.relative(paths.artifact, stageFile)));
    } else if (fs.existsSync(workFile)) {
      actions.push({ kind: "delete", file: workFile });
    }
  }

  for (const id of manifest.requirements) {
    const requirementFile = path.join(paths.requirements, `${id}.json`);
    if (!fs.existsSync(requirementFile)) {
      ambiguous.push(
        formatPath(path.relative(paths.artifact, requirementFile)),
      );
    }
  }

  if (ambiguous.length > 0) {
    fail(
      `Repair is ambiguous for: ${ambiguous.join(", ")}. Restore these files from source control or the interrupted process before retrying.`,
    );
  }
  if (actions.length === 0) {
    validateArtifact(paths, { quiet: true, validateGit: false });
    console.log("No interrupted artifact mutation was found.");
    return;
  }

  const backups = new Map(
    actions.map(({ file }) => [file, fs.readFileSync(file)]),
  );
  try {
    for (const action of actions) {
      fs.rmSync(action.file);
    }
    validateArtifact(paths, { quiet: true, validateGit: false });
  } catch (error) {
    for (const [file, contents] of backups) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents);
    }
    throw error;
  }
  console.log(`Repaired ${actions.length} interrupted artifact write(s).`);
}

function changedPathNames(root, from, to) {
  const output = git(["diff", "--name-only", from, to, "--"], { cwd: root });
  return output ? output.split(/\r?\n/).filter(Boolean) : [];
}

function lastStageHead(artifact) {
  const lastStageId = artifact.manifest.stages.at(-1);
  if (!lastStageId) {
    fail("The review has no finalized stages.");
  }
  return artifact.stages.get(lastStageId).change.headRevision;
}

function metadataBranch(artifact) {
  return `${artifact.manifest.branchPrefix}/metadata`;
}

function buildMetadataCommit(paths, parent, message) {
  const indexFile = path.join(
    os.tmpdir(),
    `semantic-review-publish-${process.pid}-${Date.now()}.index`,
  );
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    gitRaw(["read-tree", parent], { cwd: paths.root, env });
    gitRaw(["add", "-f", "--", ".semantic-review"], {
      cwd: paths.root,
      env,
    });
    const tree = gitRaw(["write-tree"], { cwd: paths.root, env });
    const commit = gitRaw(["commit-tree", tree, "-p", parent], {
      cwd: paths.root,
      input: `${message}\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>\n`,
    });
    return { commit, tree };
  } finally {
    fs.rmSync(indexFile, { force: true });
  }
}

function publishArtifact(paths, options) {
  assertKnownOptions(options, commandOptionNames(semanticReviewApi, "publish"));
  const artifact = validateArtifact(paths, { publish: true, quiet: true });
  assertCleanWorkingTree(paths.root, "Artifact publication");
  const stageTip = lastStageHead(artifact);
  const branch = metadataBranch(artifact);
  git(["check-ref-format", "--branch", branch], { cwd: paths.root });
  const message = option(options, "message", {
    defaultValue: `Publish ${artifact.manifest.reviewId} semantic review`,
  });
  const publication = buildMetadataCommit(paths, stageTip, message);
  const existing = git(["rev-parse", "--verify", `refs/heads/${branch}`], {
    cwd: paths.root,
    allowFailure: true,
  });
  if (existing) {
    const existingTree = git(["show", "-s", "--format=%T", existing], {
      cwd: paths.root,
    });
    const parents = commitParents(paths.root, existing);
    if (parents.length === 1 && parents[0] === stageTip && existingTree === publication.tree) {
      console.log(`Semantic review metadata is already published on ${branch}.`);
      return;
    }
    const pathsChanged = parents.length === 1
      ? changedPathNames(paths.root, parents[0], existing)
      : [];
    if (
      pathsChanged.length === 0 ||
      !pathsChanged.every(
        (file) =>
          file === ".semantic-review" ||
          file.startsWith(".semantic-review/"),
      )
    ) {
      fail(
        `Metadata branch ${branch} contains changes outside .semantic-review; refusing to move it.`,
      );
    }
    if (checkedOutBranches(paths.root).has(branch)) {
      fail(`Cannot update metadata branch ${branch} while it is checked out.`);
    }
  }
  git(
    [
      "update-ref",
      `refs/heads/${branch}`,
      publication.commit,
      existing ?? "0000000000000000000000000000000000000000",
    ],
    { cwd: paths.root },
  );
  console.log(
    `Published semantic review metadata on ${branch} at ${publication.commit}.`,
  );
}

function prepareStack(paths, options) {
  assertKnownOptions(
    options,
    commandOptionNames(semanticReviewApi, "prepare-stack"),
  );
  const json = flag(options, "json");
  const artifact = validateArtifact(paths, { publish: true, quiet: true });
  const entries = artifact.manifest.stages.map((id, index) => {
    const stage = artifact.stages.get(id);
    return {
      position: index + 1,
      stageId: id,
      branch: stage.change.branch,
      baseBranch: stage.change.baseBranch,
      headRevision: stage.change.headRevision,
    };
  });
  const result = {
    targetBranch: artifact.manifest.targetBranch,
    branchPrefix: artifact.manifest.branchPrefix,
    metadataBranch: metadataBranch(artifact),
    finalHeadRevision: lastStageHead(artifact),
    stages: entries,
  };
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Local stage stack ready (${entries.length} stage(s)):`);
  for (const entry of entries) {
    console.log(
      `  ${entry.position}. ${entry.branch} -> ${entry.baseBranch} (${entry.headRevision})`,
    );
  }
  console.log(`Final cumulative head: ${result.finalHeadRevision}`);
}

function prepareBranch(paths, options) {
  assertKnownOptions(
    options,
    commandOptionNames(semanticReviewApi, "prepare-branch"),
  );
  const branch = option(options, "branch", { required: true });
  const artifact = validateArtifact(paths, { publish: true, quiet: true });
  assertCleanWorkingTree(paths.root, "Single-branch preparation");
  git(["check-ref-format", "--branch", branch], { cwd: paths.root });
  const head = lastStageHead(artifact);
  const existing = git(["rev-parse", "--verify", `refs/heads/${branch}`], {
    cwd: paths.root,
    allowFailure: true,
  });
  if (existing && existing !== head) {
    fail(
      `Branch ${branch} already points to ${existing}; refusing to move it to ${head}.`,
    );
  }
  if (!existing) {
    git(["branch", branch, head], { cwd: paths.root });
  }
  console.log(
    `Prepared local cumulative branch ${branch} at ${head}; base is ${artifact.manifest.targetBranch}.`,
  );
}

function archiveReview(paths, options) {
  assertKnownOptions(options, commandOptionNames(semanticReviewApi, "archive"));
  const artifact = validateArtifact(paths, { publish: true, quiet: true });
  assertCleanWorkingTree(paths.root, "Review archival");
  const publicationBranch = metadataBranch(artifact);
  if (
    !git(["rev-parse", "--verify", `refs/heads/${publicationBranch}`], {
      cwd: paths.root,
      allowFailure: true,
    })
  ) {
    fail(`Archive requires published metadata branch ${publicationBranch}.`);
  }

  const destinationOption = option(options, "destination", {
    defaultValue: `.semantic-review-history/${artifact.manifest.reviewId}/.semantic-review`,
  });
  if (
    path.isAbsolute(destinationOption) ||
    destinationOption.split(/[\\/]/).includes("..")
  ) {
    fail("Archive destination must be a repository-relative path without '..'.");
  }
  const destination = path.resolve(paths.root, destinationOption);
  if (
    destination === paths.root ||
    !destination.startsWith(`${paths.root}${path.sep}`) ||
    path.basename(destination) !== ".semantic-review"
  ) {
    fail("Archive destination must end in .semantic-review inside the repository.");
  }
  if (fs.existsSync(destination)) {
    fail(`Archive destination already exists: ${destinationOption}.`);
  }

  const message = option(options, "message", {
    defaultValue: `Archive ${artifact.manifest.reviewId} semantic review`,
  });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.renameSync(paths.artifact, destination);
  try {
    const relativeDestination = formatPath(
      path.relative(paths.root, destination),
    );
    git(["add", "-f", "--", relativeDestination], { cwd: paths.root });
    const staged = git(["diff", "--cached", "--name-only"], {
      cwd: paths.root,
    })
      .split(/\r?\n/)
      .filter(Boolean);
    if (
      staged.length === 0 ||
      !staged.every(
        (file) =>
          file.startsWith(`${relativeDestination}/`),
      )
    ) {
      fail("Archival staged files outside the active and destination artifacts.");
    }
    git(
      [
        "commit",
        "-m",
        message,
        "-m",
        "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>",
      ],
      { cwd: paths.root },
    );
    console.log(
      `Archived ${artifact.manifest.reviewId} at ${relativeDestination}.`,
    );
  } catch (error) {
    git(["reset", "--", destinationOption], {
      cwd: paths.root,
      allowFailure: true,
    });
    if (!fs.existsSync(paths.artifact) && fs.existsSync(destination)) {
      fs.renameSync(destination, paths.artifact);
    }
    throw error;
  }
}

function dispatch(paths, positionals, options) {
  const [command, subcommand, ...extra] = positionals;
  if (extra.length > 0) {
    fail(`Unexpected positional arguments: ${extra.join(" ")}.`);
  }
  if (!command || command === "help" || flag(options, "help")) {
    console.log(HELP);
    return;
  }

  if (command === "init" && subcommand === undefined) {
    initialize(paths, options);
    return;
  }
  if (command === "requirement" && subcommand === "add") {
    addRequirement(paths, options);
    return;
  }
  if (command === "stage" && subcommand === "begin") {
    beginStage(paths, options);
    return;
  }
  if (command === "stage" && subcommand === "set") {
    setStage(paths, options);
    return;
  }
  if (command === "stage" && subcommand === "record") {
    recordStageItem(paths, options);
    return;
  }
  if (command === "stage" && subcommand === "validation") {
    recordValidation(paths, options);
    return;
  }
  if (command === "stage" && subcommand === "finish") {
    finishStage(paths, options);
    return;
  }
  if (command === "stage" && subcommand === "discard") {
    discardStage(paths, options);
    return;
  }
  if (command === "restack" && subcommand === undefined) {
    restack(paths, options);
    return;
  }
  if (command === "repair" && subcommand === undefined) {
    repairArtifact(paths, options);
    return;
  }
  if (command === "publish" && subcommand === undefined) {
    publishArtifact(paths, options);
    return;
  }
  if (command === "prepare-stack" && subcommand === undefined) {
    prepareStack(paths, options);
    return;
  }
  if (command === "prepare-branch" && subcommand === undefined) {
    prepareBranch(paths, options);
    return;
  }
  if (command === "archive" && subcommand === undefined) {
    archiveReview(paths, options);
    return;
  }
  if (command === "validate" && subcommand === undefined) {
    assertKnownOptions(
      options,
      commandOptionNames(semanticReviewApi, "validate"),
    );
    if (options.has("schema-only") && options.has("publish")) {
      fail("--schema-only and --publish cannot be combined.");
    }
    validateArtifact(paths, {
      schemaOnly: flag(options, "schema-only"),
      publish: flag(options, "publish"),
    });
    return;
  }
  fail(`Unknown command: ${positionals.join(" ")}.\n\n${HELP}`);
}

try {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.options.has("help") && parsed.positionals.length === 0) {
    console.log(HELP);
    process.exit(0);
  }
  const root = repositoryRoot();
  dispatch(pathsFor(root), parsed.positionals, parsed.options);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
