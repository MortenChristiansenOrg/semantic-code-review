import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
export const scriptsDirectory = path.resolve(
  testDirectory,
  "..",
  "..",
  "..",
  "skills",
  "semantic-flow",
  "scripts",
);
export const semanticCli = path.join(
  scriptsDirectory,
  "semantic-review.mjs",
);
export const feedbackCli = path.join(
  scriptsDirectory,
  "review-feedback.mjs",
);

function commandFailure(command, args, result) {
  return [
    `${command} ${args.join(" ")} failed with exit code ${result.status}.`,
    result.stdout,
    result.stderr,
  ]
    .filter(Boolean)
    .join("\n");
}

export function createRepository(t, prefix = "semantic-flow-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  function result(command, args) {
    return spawnSync(command, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  function run(command, args) {
    const execution = result(command, args);
    assert.equal(
      execution.status,
      0,
      commandFailure(command, args, execution),
    );
    return execution.stdout.trim();
  }

  function expectFailure(expected, command, args) {
    const execution = result(command, args);
    assert.notEqual(
      execution.status,
      0,
      `Expected command to fail: ${command} ${args.join(" ")}`,
    );
    assert.match(
      `${execution.stdout}\n${execution.stderr}`,
      expected instanceof RegExp
        ? expected
        : new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    return execution;
  }

  const repository = {
    root,
    run,
    result,
    git: (...args) => run("git", args),
    semantic: (...args) => run(process.execPath, [semanticCli, ...args]),
    feedback: (...args) => run(process.execPath, [feedbackCli, ...args]),
    expectSemanticFailure: (expected, ...args) =>
      expectFailure(expected, process.execPath, [semanticCli, ...args]),
    expectFeedbackFailure: (expected, ...args) =>
      expectFailure(expected, process.execPath, [feedbackCli, ...args]),
    feedbackAsync: (...args) =>
      new Promise((resolve, reject) => {
        execFile(
          process.execPath,
          [feedbackCli, ...args],
          { cwd: root, encoding: "utf8" },
          (error, stdout, stderr) => {
            if (error) {
              reject(
                new Error(
                  commandFailure(process.execPath, [feedbackCli, ...args], {
                    status: error.code,
                    stdout,
                    stderr,
                  }),
                ),
              );
              return;
            }
            resolve(stdout.trim());
          },
        );
      }),
    path: (...parts) => path.join(root, ...parts),
    write(relativePath, contents) {
      const file = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents, "utf8");
    },
    read(relativePath) {
      return fs.readFileSync(path.join(root, relativePath), "utf8");
    },
    readJson(relativePath) {
      return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
    },
    exists(relativePath) {
      return fs.existsSync(path.join(root, relativePath));
    },
    remove(relativePath) {
      fs.rmSync(path.join(root, relativePath), {
        recursive: true,
        force: true,
      });
    },
    commitFile(relativePath, contents, message) {
      repository.write(relativePath, contents);
      repository.git("add", relativePath);
      repository.git("commit", "-m", message);
      return repository.git("rev-parse", "HEAD");
    },
  };

  repository.git("init", "-b", "main");
  repository.git("config", "user.name", "Semantic Flow Test");
  repository.git("config", "user.email", "semantic-flow@example.invalid");
  repository.commitFile("README.md", "Test repository\n", "Initial");
  return repository;
}

export function initializeReview(
  repository,
  {
    reviewId = "test-review",
    title = "Test review",
    summary = "Exercise the semantic flow scripts.",
    targetBranch = "main",
    requirementId = "story",
    requirementTitle = "Test story",
    requirementSummary = "Implement the requested behavior.",
    sourceKind = "local",
    sourceReference = "test-story",
    sourceUrl,
    criteria = [["works", "The implementation works."]],
  } = {},
) {
  const args = [
    "init",
    "--review-id",
    reviewId,
    "--title",
    title,
    "--summary",
    summary,
    "--target-branch",
    targetBranch,
    "--requirement-id",
    requirementId,
    "--requirement-title",
    requirementTitle,
    "--requirement-summary",
    requirementSummary,
    "--source-kind",
    sourceKind,
    "--source-reference",
    sourceReference,
  ];
  if (sourceUrl) args.push("--source-url", sourceUrl);
  for (const [id, text] of criteria) {
    args.push("--criterion", `${id}=${text}`);
  }
  return repository.semantic(...args);
}

export function beginStage(
  repository,
  {
    id = "implementation",
    title = "Implement behavior",
    summary = "Add the implementation.",
    rationale = "Keep the change independently reviewable.",
    dependencies = [],
    requirementRefs = ["story#works"],
  } = {},
) {
  const args = [
    "stage",
    "begin",
    "--id",
    id,
    "--title",
    title,
    "--summary",
    summary,
    "--rationale",
    rationale,
  ];
  for (const dependency of dependencies) {
    args.push("--depends-on", dependency);
  }
  for (const requirementRef of requirementRefs) {
    args.push("--requirement-ref", requirementRef);
  }
  return repository.semantic(...args);
}

export function finalizeStage(
  repository,
  {
    id = "implementation",
    file = `${id}.txt`,
    contents = `${id}\n`,
    message = `Implement ${id}`,
  } = {},
) {
  const commit = repository.commitFile(file, contents, message);
  repository.semantic("stage", "finish", "--id", id);
  return commit;
}

export function createReviewWithStages(t, stageIds = ["implementation"]) {
  const repository = createRepository(t);
  initializeReview(repository);
  const commits = new Map();
  for (const [index, id] of stageIds.entries()) {
    beginStage(repository, {
      id,
      dependencies: index === 0 ? [] : [stageIds[index - 1]],
    });
    commits.set(id, finalizeStage(repository, { id }));
  }
  return { repository, commits };
}
