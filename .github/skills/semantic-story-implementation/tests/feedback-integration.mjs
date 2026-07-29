import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(testDirectory, "..");
const semanticCli = path.join(
  skillDirectory,
  "scripts",
  "semantic-review.mjs",
);
const feedbackCli = path.join(
  skillDirectory,
  "scripts",
  "review-feedback.mjs",
);
const repository = fs.mkdtempSync(
  path.join(os.tmpdir(), "semantic-review-feedback-"),
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

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repository, relativePath), "utf8"));
}

try {
  git("init", "-b", "main");
  git("config", "user.name", "Feedback Test");
  git("config", "user.email", "feedback@example.invalid");
  fs.writeFileSync(path.join(repository, "base.txt"), "base\n");
  git("add", "base.txt");
  git("commit", "-m", "Initial");

  semantic(
    "init",
    "--review-id",
    "feedback-test",
    "--title",
    "Feedback test",
    "--summary",
    "Exercise feedback state.",
    "--target-branch",
    "main",
    "--requirement-id",
    "story",
    "--requirement-title",
    "Story",
    "--requirement-summary",
    "Implement a change.",
    "--source-kind",
    "local",
    "--source-reference",
    "test",
    "--criterion",
    "works=The change works.",
  );
  semantic(
    "stage",
    "begin",
    "--id",
    "implementation",
    "--title",
    "Implement change",
    "--summary",
    "Add the implementation.",
    "--rationale",
    "Keep the test small.",
    "--requirement-ref",
    "story#works",
  );
  semantic(
    "stage",
    "record",
    "--stage",
    "implementation",
    "--kind",
    "decision",
    "--item-id",
    "plain-text",
    "--category",
    "engineering",
    "--summary",
    "Use a text file.",
    "--rationale",
    "It is sufficient for the workflow test.",
  );
  fs.writeFileSync(path.join(repository, "change.txt"), "first\n");
  git("add", "change.txt");
  git("commit", "-m", "Implement change");
  const originalCommit = git("rev-parse", "HEAD");
  semantic("stage", "finish", "--id", "implementation", "--commit", "HEAD");

  feedback("init");
  feedback(
    "batch",
    "create",
    "--id",
    "review-one",
    "--title",
    "Initial review",
  );
  feedback(
    "comment",
    "add",
    "--batch",
    "review-one",
    "--id",
    "decision-comment",
    "--body",
    "Explain why this remains text.",
    "--target-kind",
    "context",
    "--label",
    "Decision: Use a text file",
    "--stage",
    "implementation",
    "--collection",
    "decisions",
    "--item",
    "plain-text",
  );
  feedback(
    "comment",
    "add",
    "--batch",
    "review-one",
    "--id",
    "line-comment",
    "--body",
    "Use a more descriptive value.",
    "--target-kind",
    "line",
    "--label",
    "change.txt:1",
    "--stage",
    "implementation",
    "--path",
    "change.txt",
    "--side",
    "new",
    "--line",
    "1",
  );
  feedback("batch", "submit", "--id", "review-one");
  feedback("validate");

  fs.writeFileSync(path.join(repository, "change.txt"), "descriptive value\n");
  git("add", "change.txt");
  git("commit", "-m", "Address review feedback");
  const fixCommit = git("rev-parse", "HEAD");
  git("checkout", "--detach", `${originalCommit}^`);
  git("cherry-pick", "--no-commit", originalCommit);
  git("cherry-pick", "--no-commit", fixCommit);
  git("commit", "-C", originalCommit);
  const rewrittenCommit = git("rev-parse", "HEAD");
  semantic(
    "refresh",
    "--stage",
    `implementation=${rewrittenCommit}`,
  );

  for (const id of ["decision-comment", "line-comment"]) {
    feedback(
      "comment",
      "resolve",
      "--id",
      id,
      "--summary",
      "Updated the stage and documented the decision.",
      "--stage",
      "implementation",
      "--previous",
      originalCommit,
      "--rewritten",
      rewrittenCommit,
    );
  }
  feedback("comment", "approve", "--id", "decision-comment");
  feedback("batch", "approve-all", "--id", "review-one");
  feedback("validate");
  feedback("approve-stack", "--branch", "review/feedback-test");

  const batch = readJson(
    ".semantic-review-feedback/batches/review-one.json",
  );
  const lineComment = readJson(
    ".semantic-review-feedback/items/line-comment.json",
  );
  if (
    batch.status !== "approved" ||
    lineComment.status !== "approved" ||
    lineComment.target.stageCommit !== originalCommit ||
    lineComment.resolution.rewrittenCommit !== rewrittenCommit ||
    git("rev-parse", "review/feedback-test") !== rewrittenCommit
  ) {
    throw new Error("Feedback workflow did not preserve or approve state.");
  }

  console.log("Semantic review feedback workflow passed.");
} finally {
  fs.rmSync(repository, { recursive: true, force: true });
}
