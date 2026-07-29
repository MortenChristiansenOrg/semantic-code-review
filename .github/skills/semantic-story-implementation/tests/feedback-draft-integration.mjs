import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.resolve(testDirectory, "..", "scripts");
const semanticCli = path.join(scripts, "semantic-review.mjs");
const feedbackCli = path.join(scripts, "review-feedback.mjs");
const repository = fs.mkdtempSync(
  path.join(os.tmpdir(), "semantic-review-feedback-draft-"),
);

function run(command, args) {
  return execFileSync(command, args, {
    cwd: repository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function git(...args) {
  return run("git", args);
}

function semantic(...args) {
  return run(process.execPath, [semanticCli, ...args]);
}

function feedback(...args) {
  return run(process.execPath, [feedbackCli, ...args]);
}

function feedbackAsync(...args) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [feedbackCli, ...args],
      { cwd: repository, encoding: "utf8" },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    );
  });
}

function expectFeedbackFailure(...args) {
  try {
    feedback(...args);
  } catch {
    return;
  }
  throw new Error(`Expected feedback command to fail: ${args.join(" ")}`);
}

try {
  git("init", "-b", "main");
  git("config", "user.name", "Draft Feedback Test");
  git("config", "user.email", "draft@example.invalid");
  fs.writeFileSync(path.join(repository, "base.txt"), "base\n");
  git("add", "base.txt");
  git("commit", "-m", "Initial");
  semantic(
    "init",
    "--review-id",
    "draft-feedback",
    "--title",
    "Draft feedback",
    "--summary",
    "Exercise draft editing and routing.",
    "--target-branch",
    "main",
    "--requirement-id",
    "story",
    "--requirement-title",
    "Story",
    "--requirement-summary",
    "Implement a stage.",
    "--source-kind",
    "local",
    "--source-reference",
    "test",
    "--criterion",
    "works=The stage works.",
  );
  semantic(
    "stage",
    "begin",
    "--id",
    "implementation",
    "--title",
    "Implementation",
    "--summary",
    "Implement the stage.",
    "--rationale",
    "Provide a feedback target.",
    "--requirement-ref",
    "story#works",
  );
  fs.writeFileSync(path.join(repository, "change.txt"), "change\n");
  git("add", "change.txt");
  git("commit", "-m", "Implement");
  semantic("stage", "finish", "--id", "implementation", "--commit", "HEAD");
  semantic(
    "stage",
    "begin",
    "--id",
    "follow-up",
    "--title",
    "Follow-up",
    "--summary",
    "Add a second resolution target.",
    "--rationale",
    "Exercise stage assignment validation.",
    "--depends-on",
    "implementation",
    "--requirement-ref",
    "story#works",
  );
  fs.writeFileSync(path.join(repository, "follow-up.txt"), "follow-up\n");
  git("add", "follow-up.txt");
  git("commit", "-m", "Follow up");
  semantic("stage", "finish", "--id", "follow-up", "--commit", "HEAD");
  feedback("approve-stack", "--branch", "review/no-comments");
  if (git("rev-parse", "review/no-comments") !== git("rev-parse", "HEAD")) {
    throw new Error("A no-comment review could not approve the stack.");
  }
  feedback("init");
  feedback("batch", "create", "--id", "empty", "--title", "Empty");
  feedback("batch", "delete", "--id", "empty");
  if (
    fs.existsSync(
      path.join(repository, ".semantic-review-feedback", "batches", "empty.json"),
    )
  ) {
    throw new Error("Empty draft batch was not deleted.");
  }
  feedback("batch", "create", "--id", "review", "--title", "Review");
  await Promise.all([
    feedbackAsync(
      "comment",
      "add",
      "--batch",
      "review",
      "--id",
      "concurrent-one",
      "--body",
      "First concurrent comment",
      "--target-kind",
      "stage",
      "--label",
      "Implementation stage",
      "--stage",
      "implementation",
    ),
    feedbackAsync(
      "comment",
      "add",
      "--batch",
      "review",
      "--id",
      "concurrent-two",
      "--body",
      "Second concurrent comment",
      "--target-kind",
      "stage",
      "--label",
      "Implementation stage",
      "--stage",
      "implementation",
    ),
  ]);
  const concurrentBatch = JSON.parse(
    fs.readFileSync(
      path.join(repository, ".semantic-review-feedback", "batches", "review.json"),
      "utf8",
    ),
  );
  if (
    !concurrentBatch.items.includes("concurrent-one") ||
    !concurrentBatch.items.includes("concurrent-two")
  ) {
    throw new Error("Concurrent feedback mutations lost an item.");
  }
  feedback("comment", "delete", "--id", "concurrent-one");
  feedback("comment", "delete", "--id", "concurrent-two");
  feedback(
    "comment",
    "add",
    "--batch",
    "review",
    "--id",
    "editable",
    "--body",
    "Original body",
    "--target-kind",
    "criterion",
    "--label",
    "Story criterion",
    "--requirement",
    "story",
    "--criterion",
    "works",
  );
  feedback(
    "comment",
    "edit",
    "--id",
    "editable",
    "--body",
    "Updated body",
  );
  feedback(
    "comment",
    "assign",
    "--id",
    "editable",
    "--stage",
    "implementation",
  );
  feedback(
    "comment",
    "add",
    "--batch",
    "review",
    "--id",
    "deleted",
    "--body",
    "Delete me",
    "--target-kind",
    "stage",
    "--label",
    "Implementation stage",
    "--stage",
    "implementation",
  );
  feedback("comment", "delete", "--id", "deleted");
  feedback("batch", "submit", "--id", "review");
  const implementationCommit = JSON.parse(
    fs.readFileSync(
      path.join(
        repository,
        ".semantic-review",
        "stages",
        "implementation.json",
      ),
      "utf8",
    ),
  ).change.commit;
  const followUpCommit = JSON.parse(
    fs.readFileSync(
      path.join(repository, ".semantic-review", "stages", "follow-up.json"),
      "utf8",
    ),
  ).change.commit;
  expectFeedbackFailure(
    "comment",
    "resolve",
    "--id",
    "editable",
    "--summary",
    "Wrong stage.",
    "--stage",
    "follow-up",
    "--previous",
    implementationCommit,
    "--rewritten",
    followUpCommit,
  );
  const groups = JSON.parse(feedback("next", "--json"));
  if (
    groups.length !== 1 ||
    groups[0].stageId !== "implementation" ||
    groups[0].items[0].body !== "Updated body" ||
    fs.existsSync(
      path.join(
        repository,
        ".semantic-review-feedback",
        "items",
        "deleted.json",
      ),
    )
  ) {
    throw new Error("Draft editing, deletion, or routing failed.");
  }
  console.log("Semantic review draft feedback workflow passed.");
} finally {
  fs.rmSync(repository, { recursive: true, force: true });
}
