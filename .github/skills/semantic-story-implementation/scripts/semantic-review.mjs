#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse, parseTree, printParseErrorCode } from "jsonc-parser";

const MANIFEST_SCHEMA =
  "https://semantic-code-review.dev/schemas/v0.1/manifest.schema.json";
const REQUIREMENT_SCHEMA =
  "https://semantic-code-review.dev/schemas/v0.1/requirement.schema.json";
const STAGE_SCHEMA =
  "https://semantic-code-review.dev/schemas/v0.1/stage.schema.json";
const WORK_STAGE_SCHEMA =
  "https://semantic-code-review.dev/skills/semantic-story-implementation/v0.1/work-stage.schema.json";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(scriptDirectory, "..");
const defaultSchemaDirectory = path.resolve(
  skillDirectory,
  "..",
  "..",
  "..",
  "standard",
  "v0.1",
  "schema",
);
const schemaDirectory =
  process.env.SEMANTIC_REVIEW_SCHEMA_DIR ?? defaultSchemaDirectory;
const workStageSchemaPath = path.join(
  skillDirectory,
  "references",
  "work-stage.schema.json",
);

const HELP = `Semantic review artifact CLI

Usage:
  semantic-review.mjs init [options]
  semantic-review.mjs requirement add [options]
  semantic-review.mjs stage begin [options]
  semantic-review.mjs stage set [options]
  semantic-review.mjs stage record [options]
  semantic-review.mjs stage validation [options]
  semantic-review.mjs stage finish [options]
  semantic-review.mjs stage discard --id <stage-id>
  semantic-review.mjs refresh [--base <revision>] --stage <id>=<revision> [...]
  semantic-review.mjs repair
  semantic-review.mjs validate [--schema-only] [--publish]

Common repeated options:
  --criterion <id>=<text>
  --requirement-ref <requirement-id>#<criterion-id>
  --depends-on <stage-id>
  --stage <stage-id>=<revision>   (refresh only)

Run from the target Git repository.`;

function fail(message) {
  throw new Error(message);
}

function parseArguments(values) {
  const positionals = [];
  const options = new Map();

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }

    const separator = value.indexOf("=");
    let name;
    let optionValue;
    if (separator > 2) {
      name = value.slice(2, separator);
      optionValue = value.slice(separator + 1);
    } else {
      name = value.slice(2);
      const next = values[index + 1];
      if (next === undefined || next.startsWith("--")) {
        optionValue = true;
      } else {
        optionValue = next;
        index += 1;
      }
    }

    const existing = options.get(name) ?? [];
    existing.push(optionValue);
    options.set(name, existing);
  }

  return { positionals, options };
}

function option(options, name, { required = false, defaultValue } = {}) {
  const values = options.get(name);
  if (!values || values.length === 0) {
    if (required) {
      fail(`Missing required option --${name}.`);
    }
    return defaultValue;
  }
  if (values.length !== 1) {
    fail(`Option --${name} may only be specified once.`);
  }
  if (values[0] === true) {
    fail(`Option --${name} requires a value.`);
  }
  return values[0];
}

function repeatedOption(options, name) {
  return (options.get(name) ?? []).map((value) => {
    if (value === true) {
      fail(`Option --${name} requires a value.`);
    }
    return value;
  });
}

function flag(options, name) {
  const values = options.get(name);
  if (!values) {
    return false;
  }
  if (values.length !== 1 || values[0] !== true) {
    fail(`Option --${name} is a flag and does not take a value.`);
  }
  return true;
}

function assertKnownOptions(options, allowed) {
  for (const name of options.keys()) {
    if (!allowed.has(name)) {
      fail(`Unknown option --${name}.`);
    }
  }
}

function splitPair(value, label) {
  const separator = value.indexOf("=");
  if (separator < 1 || separator === value.length - 1) {
    fail(`${label} must use <id>=<value>.`);
  }
  return [value.slice(0, separator), value.slice(separator + 1)];
}

function git(args, { cwd, allowFailure = false, encoding = "utf8" } = {}) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (allowFailure) {
      return null;
    }
    const detail = error.stderr?.toString().trim();
    fail(`git ${args.join(" ")} failed${detail ? `: ${detail}` : "."}`);
  }
}

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

function findDuplicateKeys(node, file, errors) {
  if (!node) {
    return;
  }
  if (node.type === "object") {
    const keys = new Set();
    for (const property of node.children ?? []) {
      const keyNode = property.children?.[0];
      const key = keyNode?.value;
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

function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    fail(`Cannot read ${file}: ${error.message}`);
  }

  if (text.charCodeAt(0) === 0xfeff) {
    fail(`${file}: UTF-8 byte-order marks are not allowed.`);
  }

  const parseErrors = [];
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

  const duplicateErrors = [];
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

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
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
        `Schema ${file} was not found in ${schemaDirectory}. Set SEMANTIC_REVIEW_SCHEMA_DIR when the skill is installed separately.`,
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

function listJsonFiles(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(directory, entry.name))
    .sort();
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
    fail(`Stage commit ${commit} has no changes relative to ${parent}.`);
  }
  for (const file of files) {
    if (
      file.path === ".semantic-review" ||
      file.path.startsWith(".semantic-review/") ||
      file.previousPath === ".semantic-review" ||
      file.previousPath?.startsWith(".semantic-review/")
    ) {
      fail(`Stage commit ${commit} contains semantic review artifact files.`);
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
  const commits = new Set();
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
    if (commits.has(stage.change.commit)) {
      errors.push(`Stage ${id} repeats commit ${stage.change.commit}.`);
    }
    commits.add(stage.change.commit);
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
  let expectedParent = base;
  for (const id of manifest.stages) {
    const stage = stages.get(id);
    const commit = commitObject(paths.root, stage.change.commit);
    const parents = commitParents(paths.root, commit);
    if (parents.length !== 1) {
      fail(`Stage ${id} commit ${commit} must have exactly one parent.`);
    }
    if (parents[0] !== expectedParent) {
      fail(
        `Stage ${id} commit ${commit} must directly follow ${expectedParent}, but follows ${parents[0]}.`,
      );
    }
    const actualFiles = changedFiles(paths.root, expectedParent, commit);
    if (!sameChanges(stage.change.files, actualFiles)) {
      fail(
        `Stage ${id} file inventory is stale.\nExpected: ${JSON.stringify(actualFiles)}\nActual:   ${JSON.stringify(stage.change.files)}`,
      );
    }
    expectedParent = commit;
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

  const source = {
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
  assertKnownOptions(
    options,
    new Set([
      "review-id",
      "title",
      "summary",
      "base-revision",
      "target-branch",
      "requirement-id",
      "requirement-title",
      "requirement-summary",
      "source-kind",
      "source-reference",
      "source-url",
      "criterion",
    ]),
  );
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
  const baseRevision = commitObject(
    paths.root,
    option(options, "base-revision", { defaultValue: "HEAD" }),
  );
  const manifest = {
    $schema: MANIFEST_SCHEMA,
    formatVersion: "0.1",
    reviewId: option(options, "review-id", { required: true }),
    title: option(options, "title", { required: true }),
    summary: option(options, "summary", { required: true }),
    baseRevision,
    targetBranch: option(options, "target-branch", { required: true }),
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
    new Set([
      "requirement-id",
      "requirement-title",
      "requirement-summary",
      "source-kind",
      "source-reference",
      "source-url",
      "criterion",
    ]),
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
    new Set([
      "id",
      "title",
      "summary",
      "rationale",
      "depends-on",
      "requirement-ref",
    ]),
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

  const stage = {
    $schema: WORK_STAGE_SCHEMA,
    id,
    title: option(options, "title", { required: true }),
    summary: option(options, "summary", { required: true }),
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

  writeJson(file, stage);
  try {
    validateArtifact(paths, { quiet: true });
  } catch (error) {
    fs.rmSync(file, { force: true });
    throw error;
  }
  console.log(`Began working stage ${id}.`);
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
    new Set([
      "id",
      "title",
      "summary",
      "rationale",
      "depends-on",
      "requirement-ref",
    ]),
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
      const value = {
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
    new Set([
      "stage",
      "item-id",
      "type",
      "status",
      "summary",
      "command",
      "replace",
      "finalized",
    ]),
  );
  const stageId = option(options, "stage", { required: true });
  const replace = flag(options, "replace");
  const finalized = flag(options, "finalized");
  const value = {
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

function canonicalStage(workStage, commit, files) {
  return {
    $schema: STAGE_SCHEMA,
    id: workStage.id,
    title: workStage.title,
    summary: workStage.summary,
    dependsOn: workStage.dependsOn,
    requirementRefs: workStage.requirementRefs,
    change: {
      commit,
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
  assertKnownOptions(options, new Set(["id", "commit"]));
  const artifact = validateArtifact(paths, { quiet: true });
  assertCleanWorkingTree(paths.root, "Finalizing a stage");
  const id = option(options, "id", { required: true });
  const { file: workFile, stage: workStage } = workingStage(paths, id);
  if (artifact.stages.has(id)) {
    fail(`Stage ${id} is already finalized.`);
  }

  const commit = commitObject(
    paths.root,
    option(options, "commit", { defaultValue: "HEAD" }),
  );
  const previousId = artifact.manifest.stages.at(-1);
  const parent = previousId
    ? artifact.stages.get(previousId).change.commit
    : artifact.manifest.baseRevision;
  const parents = commitParents(paths.root, commit);
  if (parents.length !== 1 || parents[0] !== parent) {
    fail(`Commit ${commit} must directly follow ${parent}.`);
  }
  const files = changedFiles(paths.root, parent, commit);
  const stage = canonicalStage(workStage, commit, files);
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
  console.log(`Finalized stage ${id} at ${commit}.`);
}

function discardStage(paths, options) {
  assertKnownOptions(options, new Set(["id"]));
  const id = option(options, "id", { required: true });
  validateArtifact(paths, { quiet: true, validateGit: false });
  const { file } = workingStage(paths, id);
  fs.rmSync(file);
  validateArtifact(paths, { quiet: true, validateGit: false });
  console.log(`Discarded working stage ${id}.`);
}

function refreshStages(paths, options) {
  assertKnownOptions(options, new Set(["base", "stage"]));
  const baseRevision = option(options, "base");
  const bindings = new Map(
    repeatedOption(options, "stage").map((value) =>
      splitPair(value, "--stage"),
    ),
  );
  if (bindings.size === 0 && baseRevision === undefined) {
    fail(
      "refresh requires --base <revision> or at least one --stage <id>=<revision>.",
    );
  }

  const artifact = validateArtifact(paths, {
    schemaOnly: true,
    quiet: true,
  });
  for (const id of bindings.keys()) {
    if (!artifact.stages.has(id)) {
      fail(`Cannot refresh unknown finalized stage ${id}.`);
    }
  }

  const backups = new Map();
  const oldManifest = structuredClone(artifact.manifest);
  const newBase = baseRevision
    ? commitObject(paths.root, baseRevision)
    : artifact.manifest.baseRevision;
  artifact.manifest.baseRevision = newBase;
  let parent = newBase;
  try {
    for (const id of artifact.manifest.stages) {
      const stage = artifact.stages.get(id);
      const file = path.join(paths.stages, `${id}.json`);
      backups.set(file, structuredClone(stage));
      const commit = commitObject(
        paths.root,
        bindings.get(id) ?? stage.change.commit,
      );
      const parents = commitParents(paths.root, commit);
      if (parents.length !== 1 || parents[0] !== parent) {
        fail(`Stage ${id} commit ${commit} must directly follow ${parent}.`);
      }
      stage.change = {
        commit,
        files: changedFiles(paths.root, parent, commit),
      };
      writeJson(file, stage);
      parent = commit;
    }
    writeJson(paths.manifest, artifact.manifest);
    validateArtifact(paths, { quiet: true });
  } catch (error) {
    for (const [file, value] of backups) {
      writeJson(file, value);
    }
    writeJson(paths.manifest, oldManifest);
    throw error;
  }
  console.log(
    `Refreshed ${bindings.size} stage binding(s)${baseRevision ? ` on base ${newBase}` : ""}.`,
  );
}

function repairArtifact(paths, options) {
  assertKnownOptions(options, new Set());
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
  if (command === "refresh" && subcommand === undefined) {
    refreshStages(paths, options);
    return;
  }
  if (command === "repair" && subcommand === undefined) {
    repairArtifact(paths, options);
    return;
  }
  if (command === "validate" && subcommand === undefined) {
    assertKnownOptions(options, new Set(["schema-only", "publish"]));
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
