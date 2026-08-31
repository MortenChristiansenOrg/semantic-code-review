#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  commandOptionNames,
  renderCliHelp,
  semanticFlowApi,
} from "./command-api.js";
import {
  assertKnownOptions,
  expandInputOptions,
  flag,
  option,
  parseArguments,
  type Options,
} from "./shared/arguments.js";
import { fail } from "./shared/errors.js";
import { git } from "./shared/git.js";
import { readJson } from "./shared/json.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(scriptDirectory, "..");
const semanticImplementationScript = path.join(
  scriptDirectory,
  "semantic-implementation.mjs",
);
const reviewFeedbackScript = path.join(
  scriptDirectory,
  "review-feedback.mjs",
);
const semanticViewScript = path.join(scriptDirectory, "semantic-view.mjs");
const HELP = renderCliHelp(semanticFlowApi);

interface ArtifactCandidate {
  worktree: string;
  implementationId: string;
  title: string;
  targetBranch: string;
  baseRevision: string;
  currentBranch: string | null;
  finalizedStageIds: string[];
  workingStageIds: string[];
  feedbackExists: boolean;
}

interface Inspection {
  repositoryRoot: string;
  candidates: ArtifactCandidate[];
  selected: ArtifactCandidate | null;
}

interface PendingFeedbackStage {
  stageId: string;
  stageBranch: string;
  threads: Array<{
    id: string;
    stale: boolean;
    comments: Array<{ author: string; body: string }>;
    target: { label: string };
  }>;
}

function normalizedPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left: string, right: string): boolean {
  return normalizedPath(left) === normalizedPath(right);
}

function repositoryRoot(start: string): string {
  if (!fs.existsSync(start)) {
    fail(`Project path does not exist: ${start}.`);
  }
  const directory = fs.statSync(start).isDirectory()
    ? start
    : path.dirname(start);
  const root = git(["rev-parse", "--show-toplevel"], {
    cwd: directory,
    allowFailure: true,
  });
  if (!root) {
    fail(`No Git repository contains ${start}.`);
  }
  return path.resolve(root);
}

function worktreeRoots(root: string): string[] {
  const output = git(["worktree", "list", "--porcelain", "-z"], { cwd: root });
  return output
    .split("\0")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.resolve(line.slice("worktree ".length)));
}

function workingStageIds(root: string): string[] {
  const directory = path.join(
    root,
    ".semantic-review",
    ".work",
    "stages",
  );
  if (!fs.existsSync(directory)) {
    return [];
  }
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.basename(entry.name, ".json"))
    .sort();
}

function artifactCandidate(root: string): ArtifactCandidate | null {
  const manifestPath = path.join(
    root,
    ".semantic-review",
    "manifest.json",
  );
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  const manifest = readJson(manifestPath);
  return {
    worktree: root,
    implementationId: manifest.implementationId,
    title: manifest.title,
    targetBranch: manifest.targetBranch,
    baseRevision: manifest.baseRevision,
    currentBranch:
      git(["symbolic-ref", "--short", "HEAD"], {
        cwd: root,
        allowFailure: true,
      }) ?? null,
    finalizedStageIds: [...(manifest.stages ?? [])],
    workingStageIds: workingStageIds(root),
    feedbackExists: fs.existsSync(
      path.join(root, ".semantic-review-feedback", "manifest.json"),
    ),
  };
}

function inspect(options: Options): Inspection {
  assertKnownOptions(
    options,
    commandOptionNames(semanticFlowApi, "inspect"),
  );
  const project = option(options, "project");
  const implementationId = option(options, "implementation-id");
  const root = repositoryRoot(path.resolve(project ?? process.cwd()));
  const candidates = worktreeRoots(root)
    .map(artifactCandidate)
    .filter((candidate): candidate is ArtifactCandidate => candidate !== null)
    .sort((left, right) => left.worktree.localeCompare(right.worktree));
  const matching = implementationId
    ? candidates.filter((candidate) => candidate.implementationId === implementationId)
    : candidates;
  const preferred = matching.find((candidate) =>
    samePath(candidate.worktree, root),
  );
  const selected = preferred ?? (matching.length === 1 ? matching[0] : null);
  return { repositoryRoot: root, candidates, selected };
}

function printInspection(inspection: Inspection, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(inspection, null, 2));
    return;
  }
  if (inspection.candidates.length === 0) {
    console.log(
      `No active semantic implementation found in ${inspection.repositoryRoot} or its linked worktrees.`,
    );
    return;
  }
  for (const candidate of inspection.candidates) {
    const marker =
      inspection.selected &&
      samePath(candidate.worktree, inspection.selected.worktree)
        ? "*"
        : "-";
    console.log(
      `${marker} ${candidate.implementationId}: ${candidate.title}\n  worktree: ${candidate.worktree}\n  target: ${candidate.targetBranch}\n  branch: ${candidate.currentBranch ?? "(detached)"}`,
    );
  }
}

function resolveSingle(
  options: Options,
  command: string,
): ArtifactCandidate {
  const selectionOptions: Options = new Map(options);
  selectionOptions.delete("publish");
  assertKnownOptions(
    options,
    commandOptionNames(semanticFlowApi, command),
  );
  const inspection = inspect(selectionOptions);
  if (inspection.selected) {
    return inspection.selected;
  }
  const implementationId = option(selectionOptions, "implementation-id");
  if (inspection.candidates.length === 0) {
    fail(
      `No active semantic implementation found in ${inspection.repositoryRoot} or its linked worktrees.`,
    );
  }
  if (implementationId) {
    fail(`No active semantic implementation has implementation ID ${implementationId}.`);
  }
  const choices = inspection.candidates
    .map(
      (candidate) =>
        `${candidate.worktree} (${candidate.implementationId}: ${candidate.title})`,
    )
    .join("\n");
  fail(
    `Several linked worktrees contain semantic implementations. Select one with --project or --implementation-id:\n${choices}`,
  );
}

function execute(
  executable: string,
  args: string[],
  cwd: string,
  inherit = true,
): number {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    fail(
      `Could not run ${executable}: ${result.error.message}`,
    );
  }
  return result.status ?? 1;
}

function executeCapture(
  executable: string,
  args: string[],
  cwd: string,
): { passed: boolean; output: string } {
  const result = executeCaptureStreams(executable, args, cwd);
  return {
    passed: result.passed,
    output: [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
  };
}

function executeCaptureStreams(
  executable: string,
  args: string[],
  cwd: string,
): { passed: boolean; stdout: string; stderr: string } {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    return { passed: false, stdout: "", stderr: result.error.message };
  }
  return {
    passed: result.status === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function validate(options: Options): void {
  const candidate = resolveSingle(options, "validate");
  const publish = flag(options, "publish");
  let failed = false;

  console.log(`Artifact: ${candidate.worktree}`);
  failed =
    execute(
      process.execPath,
      [
        semanticImplementationScript,
        "validate",
        ...(publish ? ["--publish"] : []),
      ],
      candidate.worktree,
    ) !== 0;

  if (candidate.feedbackExists) {
    failed =
      execute(
        process.execPath,
        [
          reviewFeedbackScript,
          "validate",
          ...(publish ? ["--require-resolved"] : []),
        ],
        candidate.worktree,
      ) !== 0 || failed;
  }

  if (failed) {
    fail("Semantic flow validation failed.");
  }
}

function countStatuses(
  values: Array<{ status?: string }>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const status = value.status ?? "missing";
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function status(options: Options): void {
  const candidate = resolveSingle(options, "status");
  const artifact = path.join(candidate.worktree, ".semantic-review");
  const manifest = readJson(path.join(artifact, "manifest.json"));
  const requirements = (manifest.requirements ?? []).map((id) =>
    readJson(path.join(artifact, "requirements", `${id}.json`)),
  );
  const finalizedStages = (manifest.stages ?? []).map((id) =>
    readJson(path.join(artifact, "stages", `${id}.json`)),
  );
  const workingStages = candidate.workingStageIds.map((id) =>
    readJson(path.join(artifact, ".work", "stages", `${id}.json`)),
  );
  const allCriteria = requirements.flatMap((specification) =>
    (specification.acceptanceCriteria ?? []).map(
      (criterion) => `${specification.id}#${criterion.id}`,
    ),
  );
  const finalizedCoverage = new Set(
    finalizedStages.flatMap((stage) => stage.specificationRefs ?? []),
  );
  const workingCoverage = new Set(
    workingStages.flatMap((stage) => stage.specificationRefs ?? []),
  );
  const validations = [...finalizedStages, ...workingStages].flatMap(
    (stage) => stage.validation ?? [],
  );

  const feedbackRoot = path.join(
    candidate.worktree,
    ".semantic-review-feedback",
  );
  let feedback = {
    exists: false,
    threads: {},
  };
  if (candidate.feedbackExists) {
    const feedbackManifest = readJson(
      path.join(feedbackRoot, "manifest.json"),
    );
    const threads = (feedbackManifest.threads ?? []).map((id) =>
      readJson(path.join(feedbackRoot, "threads", `${id}.json`)),
    );
    feedback = {
      exists: true,
      threads: countStatuses(threads),
    };
  }

  const artifactValidation = executeCapture(
    process.execPath,
    [semanticImplementationScript, "validate"],
    candidate.worktree,
  );
  const feedbackValidation = candidate.feedbackExists
    ? executeCapture(
        process.execPath,
        [reviewFeedbackScript, "validate"],
        candidate.worktree,
      )
    : null;
  const metadataBranch = `${manifest.branchPrefix}/metadata`;
  const metadataPublished = Boolean(
    git(["show-ref", "--verify", `refs/heads/${metadataBranch}`], {
      cwd: candidate.worktree,
      allowFailure: true,
    }),
  );

  const result = {
    artifact: candidate,
    criteria: {
      total: allCriteria.length,
      covered: allCriteria.filter((criterion) =>
        finalizedCoverage.has(criterion),
      ).length,
      inProgress: allCriteria.filter(
        (criterion) =>
          !finalizedCoverage.has(criterion) &&
          workingCoverage.has(criterion),
      ),
      missing: allCriteria.filter(
        (criterion) =>
          !finalizedCoverage.has(criterion) &&
          !workingCoverage.has(criterion),
      ),
    },
    evidence: countStatuses(validations),
    feedback,
    metadata: {
      branch: metadataBranch,
      branchExists: metadataPublished,
    },
    validation: {
      artifact: artifactValidation,
      feedback: feedbackValidation,
    },
  };

  if (flag(options, "json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${candidate.implementationId}: ${candidate.title}`);
  console.log(`Artifact: ${candidate.worktree}`);
  console.log(
    `Stages: ${candidate.finalizedStageIds.length} finalized, ${candidate.workingStageIds.length} working`,
  );
  console.log(
    `Criteria: ${result.criteria.covered}/${result.criteria.total} covered`,
  );
  console.log(`Evidence: ${JSON.stringify(result.evidence)}`);
  console.log(`Feedback: ${JSON.stringify(result.feedback)}`);
  console.log(
    `Metadata branch: ${metadataPublished ? metadataBranch : "absent"}`,
  );
  console.log(
    `Validation: artifact ${artifactValidation.passed ? "passed" : "failed"}, feedback ${
      feedbackValidation
        ? feedbackValidation.passed
          ? "passed"
          : "failed"
        : "absent"
    }`,
  );
  if (!artifactValidation.passed) {
    console.log(artifactValidation.output);
  }
  if (feedbackValidation && !feedbackValidation.passed) {
    console.log(feedbackValidation.output);
  }
}

function review(options: Options): void {
  const candidate = resolveSingle(options, "review");
  const status = execute(
    process.execPath,
    [semanticViewScript, "review", candidate.worktree],
    candidate.worktree,
  );
  if (status !== 0) {
    fail(`Semantic review viewer exited with code ${status}.`);
  }
}

function feedback(options: Options): void {
  const candidate = resolveSingle(options, "feedback");
  const json = flag(options, "json");
  const artifactValidation = executeCapture(
    process.execPath,
    [semanticImplementationScript, "validate"],
    candidate.worktree,
  );
  if (!artifactValidation.passed) {
    if (artifactValidation.output) console.error(artifactValidation.output);
    fail("Semantic implementation validation failed.");
  }

  const worktreeStatus =
    git(["status", "--short"], { cwd: candidate.worktree }) ?? "";
  const worktreeChanges = worktreeStatus
    ? worktreeStatus.split(/\r?\n/).filter(Boolean)
    : [];
  const feedbackRoot = path.join(
    candidate.worktree,
    ".semantic-review-feedback",
  );
  if (
    !candidate.feedbackExists &&
    fs.existsSync(feedbackRoot) &&
    fs.readdirSync(feedbackRoot).length > 0
  ) {
    fail(
      `Incomplete feedback state in ${feedbackRoot}: manifest.json is missing.`,
    );
  }
  let stages: PendingFeedbackStage[] = [];
  if (candidate.feedbackExists) {
    const pending = executeCaptureStreams(
      process.execPath,
      [reviewFeedbackScript, "next", "--json", "--compact"],
      candidate.worktree,
    );
    if (!pending.passed) {
      const output = [pending.stdout, pending.stderr]
        .filter(Boolean)
        .join("\n");
      if (output) console.error(output);
      fail("Feedback validation failed.");
    }
    if (pending.stderr) console.error(pending.stderr);
    try {
      stages = JSON.parse(pending.stdout);
    } catch {
      fail("Feedback command returned invalid JSON.");
    }
  }

  const result = {
    worktree: candidate.worktree,
    currentBranch: candidate.currentBranch,
    worktreeChanges,
    feedbackExists: candidate.feedbackExists,
    stages,
  };
  if (json) {
    console.log(JSON.stringify(result));
    return;
  }

  console.log(`Artifact: ${candidate.worktree}`);
  if (worktreeChanges.length) {
    console.log(`Worktree changes:\n${worktreeChanges.join("\n")}`);
  }
  if (!candidate.feedbackExists) {
    console.log("No feedback has been sent.");
    return;
  }
  if (!stages.length) {
    console.log("No feedback awaits an agent reply.");
    return;
  }
  for (const stage of stages) {
    console.log(`${stage.stageId} (${stage.stageBranch}):`);
    for (const thread of stage.threads) {
      console.log(
        `  ${thread.id} [${thread.target.label}]${thread.stale ? " (stale)" : ""}:`,
      );
      for (const comment of thread.comments) {
        console.log(`    ${comment.author}: ${comment.body}`);
      }
    }
  }
}

function schemaFormatVersion(relativePath: string): string {
  const schema = readJson(path.join(skillDirectory, relativePath));
  const version = schema?.properties?.formatVersion?.const;
  if (typeof version !== "string") {
    fail(`${relativePath} does not declare a formatVersion constant.`);
  }
  return version;
}

function installedCommit(): string | null {
  const root = git(["rev-parse", "--show-toplevel"], {
    cwd: skillDirectory,
    allowFailure: true,
  });
  if (!root) {
    return null;
  }
  const relative = path.relative(path.resolve(root), skillDirectory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return (
    git(["rev-parse", "HEAD"], {
      cwd: skillDirectory,
      allowFailure: true,
    }) ?? null
  );
}

function readVersion(root: string): string {
  const file = path.join(root, "VERSION");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "unversioned";
}

function version(options: Options): void {
  assertKnownOptions(
    options,
    commandOptionNames(semanticFlowApi, "version"),
  );
  const result = {
    skillVersion: readVersion(skillDirectory),
    artifactFormatVersion: schemaFormatVersion(
      path.join("references", "schema", "manifest.schema.json"),
    ),
    feedbackFormatVersion: schemaFormatVersion(
      path.join(
        "references",
        "feedback-schema",
        "manifest.schema.json",
      ),
    ),
    skillRoot: skillDirectory,
    sourceCommit: installedCommit(),
  };
  if (flag(options, "json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Skill version: ${result.skillVersion}`);
  console.log(`Artifact format: ${result.artifactFormatVersion}`);
  console.log(`Feedback format: ${result.feedbackFormatVersion}`);
  console.log(`Installed at: ${result.skillRoot}`);
  if (result.sourceCommit) {
    console.log(`Source commit: ${result.sourceCommit}`);
  }
}

function validateSourceRepository(root: string): void {
  const required = [
    path.join("skills", "semantic-flow", "SKILL.md"),
    path.join("scripts", "package.json"),
    path.join("scripts", "src", "build-skill.ts"),
    path.join("standard", "v0.1"),
  ];
  for (const relative of required) {
    if (!fs.existsSync(path.join(root, relative))) {
      fail(`Source repository is missing ${relative}: ${root}.`);
    }
  }
}

function requiredSkillFiles(root: string): string[] {
  const skill = fs.readFileSync(path.join(root, "SKILL.md"), "utf8");
  const commands = [...skill.matchAll(/`(commands\/[^`]+\.md)`/g)].map(
    (match) => match[1],
  );
  return [
    "SKILL.md",
    "VERSION",
    path.join("scripts", "API.d.ts"),
    path.join("scripts", "semantic-implementation.mjs"),
    path.join("scripts", "review-feedback.mjs"),
    path.join("scripts", "semantic-view.mjs"),
    path.join("scripts", "semantic-flow.mjs"),
    ...commands,
  ];
}

function verifySkill(root: string): string[] {
  const required = requiredSkillFiles(root);
  for (const relative of required) {
    if (!fs.existsSync(path.join(root, relative))) {
      fail(`Built skill is missing ${relative}: ${root}.`);
    }
  }
  return required;
}

function fileHash(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function compareSkillFiles(
  source: string,
  destination: string,
  files: string[],
): void {
  for (const relative of files) {
    if (
      fileHash(path.join(source, relative)) !==
      fileHash(path.join(destination, relative))
    ) {
      fail(`Installed skill does not match built file ${relative}.`);
    }
  }
}

function runRequired(
  executable: string,
  args: string[],
  cwd: string,
): void {
  const status = execute(executable, args, cwd);
  if (status !== 0) {
    fail(`${executable} ${args.join(" ")} exited with code ${status}.`);
  }
}

function npmInvocation(): { executable: string; args: string[] } {
  const configured = process.env.npm_execpath;
  if (configured && fs.existsSync(configured)) {
    return { executable: process.execPath, args: [configured] };
  }

  const pathEntries = (process.env.PATH ?? "").split(path.delimiter);
  const names =
    process.platform === "win32" ? ["npm.cmd", "npm.exe"] : ["npm"];
  for (const directory of pathEntries) {
    for (const name of names) {
      const executable = path.join(directory, name);
      if (!fs.existsSync(executable)) {
        continue;
      }
      if (process.platform !== "win32") {
        return { executable, args: [] };
      }
      const cli = path.join(
        path.dirname(executable),
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      );
      if (fs.existsSync(cli)) {
        return { executable: process.execPath, args: [cli] };
      }
    }
  }
  fail("npm was not found on PATH.");
}

function replaceInstalledSkill(
  builtSkill: string,
  installedSkill: string,
  requiredFiles: string[],
): void {
  const parent = path.dirname(installedSkill);
  const token = `${process.pid}-${Date.now()}`;
  const temporary = path.join(parent, `.semantic-flow-update-${token}`);
  const backup = path.join(parent, `.semantic-flow-backup-${token}`);

  fs.cpSync(builtSkill, temporary, { recursive: true });
  verifySkill(temporary);
  compareSkillFiles(builtSkill, temporary, requiredFiles);

  let installedMoved = false;
  try {
    fs.renameSync(installedSkill, backup);
    installedMoved = true;
    fs.renameSync(temporary, installedSkill);
    compareSkillFiles(builtSkill, installedSkill, requiredFiles);
    fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (installedMoved && fs.existsSync(backup)) {
      if (fs.existsSync(installedSkill)) {
        fs.rmSync(installedSkill, { recursive: true, force: true });
      }
      fs.renameSync(backup, installedSkill);
    }
    if (fs.existsSync(temporary)) {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
    throw error;
  }
}

function update(options: Options): void {
  assertKnownOptions(
    options,
    commandOptionNames(semanticFlowApi, "update"),
  );
  const sourceOption = option(options, "source");
  const useCurrentSource = flag(options, "use-current-source");
  const previousVersion = readVersion(skillDirectory);
  const targetRoot = repositoryRoot(process.cwd());
  const sourceRoot = repositoryRoot(
    sourceOption
      ? path.resolve(sourceOption)
      : path.join(path.dirname(targetRoot), "semantic-code-review"),
  );
  validateSourceRepository(sourceRoot);

  const branch = git(["symbolic-ref", "--short", "HEAD"], {
    cwd: sourceRoot,
    allowFailure: true,
  });
  const upstream = git(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    { cwd: sourceRoot, allowFailure: true },
  );
  const dirty = Boolean(git(["status", "--porcelain"], { cwd: sourceRoot }));

  if (!useCurrentSource) {
    const problems = [
      dirty ? "the source worktree is dirty" : null,
      !branch ? "the source checkout is detached" : null,
      !upstream ? "the source branch has no upstream" : null,
    ].filter(Boolean);
    if (problems.length > 0) {
      fail(
        `Cannot update source automatically because ${problems.join(
          ", ",
        )}. After explicit approval, rerun with --use-current-source.`,
      );
    }
    runRequired("git", ["pull", "--ff-only"], sourceRoot);
  }

  const sourceCommit = git(["rev-parse", "HEAD"], { cwd: sourceRoot });
  const scriptsRoot = path.join(sourceRoot, "scripts");
  const npm = npmInvocation();
  if (!fs.existsSync(path.join(scriptsRoot, "node_modules"))) {
    runRequired(
      npm.executable,
      [...npm.args, "ci", "--prefix", scriptsRoot],
      sourceRoot,
    );
  }
  runRequired(
    npm.executable,
    [...npm.args, "run", "build", "--prefix", scriptsRoot],
    sourceRoot,
  );

  const builtSkill = path.join(sourceRoot, "skills", "semantic-flow");
  const requiredFiles = verifySkill(builtSkill);

  if (!samePath(builtSkill, skillDirectory)) {
    replaceInstalledSkill(builtSkill, skillDirectory, requiredFiles);
  }

  const installedVersion = readVersion(skillDirectory);
  compareSkillFiles(builtSkill, skillDirectory, requiredFiles);
  console.log(`Updated semantic-flow ${previousVersion} -> ${installedVersion}.`);
  console.log(`Source: ${branch ?? "(detached)"} ${sourceCommit}`);
  console.log(`Installed at: ${skillDirectory}`);
}

function dispatch(positionals: string[], options: Options): void {
  const [command, ...extra] = positionals;
  if (extra.length > 0) {
    fail(`Unexpected positional arguments: ${extra.join(" ")}.`);
  }
  if (!command || command === "help" || flag(options, "help")) {
    console.log(HELP);
    return;
  }
  if (command === "inspect") {
    const json = flag(options, "json");
    printInspection(inspect(options), json);
    return;
  }
  if (command === "validate") {
    validate(options);
    return;
  }
  if (command === "status") {
    status(options);
    return;
  }
  if (command === "review") {
    review(options);
    return;
  }
  if (command === "feedback") {
    feedback(options);
    return;
  }
  if (command === "version") {
    version(options);
    return;
  }
  if (command === "update") {
    update(options);
    return;
  }
  fail(`Unknown command: ${positionals.join(" ")}.\n\n${HELP}`);
}

try {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.options.has("help") && parsed.positionals.length === 0) {
    assertKnownOptions(parsed.options, new Set(["help"]));
    flag(parsed.options, "help");
    console.log(HELP);
    process.exit(0);
  }
  dispatch(
    parsed.positionals,
    expandInputOptions(parsed.options, process.cwd()),
  );
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
