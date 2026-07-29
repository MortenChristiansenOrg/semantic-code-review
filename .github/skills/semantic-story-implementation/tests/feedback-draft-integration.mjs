import { execFileSync } from "node:child_process";
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
  feedback("init");
  feedback("batch", "create", "--id", "review", "--title", "Review");
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
