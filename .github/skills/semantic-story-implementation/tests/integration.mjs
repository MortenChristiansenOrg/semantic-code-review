import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(testDirectory, "..");
const cli = path.join(skillDirectory, "scripts", "semantic-review.mjs");
const repository = fs.mkdtempSync(
  path.join(os.tmpdir(), "semantic-review-skill-"),
);

function run(command, args, { cwd = repository } = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function git(...args) {
  return run("git", args);
}

function semantic(...args) {
  return run(process.execPath, [cli, ...args]);
}

function semanticFails(expectedText, ...args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status === 0 || !result.stderr.includes(expectedText)) {
    throw new Error(
      `Expected semantic command to fail with "${expectedText}", got:\n${result.stdout}\n${result.stderr}`,
    );
  }
}

function readJson(relativePath) {
  return JSON.parse(
    fs.readFileSync(path.join(repository, relativePath), "utf8"),
  );
}

try {
  git("init", "-b", "main");
  git("config", "user.name", "Semantic Review Test");
  git("config", "user.email", "semantic-review@example.invalid");
  fs.writeFileSync(path.join(repository, "README.md"), "Example\n", "utf8");
  git("add", "README.md");
  git("commit", "-m", "Initial");
  const base = git("rev-parse", "HEAD");

  semantic(
    "init",
    "--review-id",
    "cancel-order",
    "--title",
    "Cancel pending orders",
    "--summary",
    "Add a guarded cancellation workflow.",
    "--target-branch",
    "main",
    "--requirement-id",
    "cancel-order",
    "--requirement-title",
    "Customer cancels an order",
    "--requirement-summary",
    "Customers can cancel before fulfilment.",
    "--source-kind",
    "local",
    "--source-reference",
    "story-1",
    "--criterion",
    "cancel-pending=A pending order can be cancelled.",
    "--criterion",
    "persist-state=The cancelled state is persisted.",
  );

  const initialManifest = readJson(".semantic-review/manifest.json");
  if (initialManifest.baseRevision !== base || initialManifest.stages.length !== 0) {
    throw new Error("Initialization produced an invalid manifest.");
  }

  fs.writeFileSync(path.join(repository, "unrelated.txt"), "dirty\n", "utf8");
  semanticFails(
    "Beginning a stage requires a clean worktree",
    "stage",
    "begin",
    "--id",
    "add-policy",
    "--title",
    "Add cancellation policy",
    "--summary",
    "Add the domain transition.",
    "--rationale",
    "The aggregate must own its state transition.",
    "--requirement-ref",
    "cancel-order#cancel-pending",
  );
  fs.rmSync(path.join(repository, "unrelated.txt"));

  semantic(
    "stage",
    "begin",
    "--id",
    "add-policy",
    "--title",
    "Add cancellation policy",
    "--summary",
    "Add the domain transition.",
    "--rationale",
    "The aggregate must own its state transition.",
    "--requirement-ref",
    "cancel-order#cancel-pending",
  );
  fs.mkdirSync(path.join(repository, ".semantic-review", "stages"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(
      repository,
      ".semantic-review",
      "stages",
      "add-policy.json",
    ),
    "{}\n",
    "utf8",
  );
  semantic("repair");
  if (
    fs.existsSync(
      path.join(
        repository,
        ".semantic-review",
        "stages",
        "add-policy.json",
      ),
    ) ||
    !fs.existsSync(
      path.join(
        repository,
        ".semantic-review",
        ".work",
        "stages",
        "add-policy.json",
      ),
    )
  ) {
    throw new Error("Repair did not roll back an interrupted stage finish.");
  }
  semantic(
    "stage",
    "record",
    "--stage",
    "add-policy",
    "--kind",
    "decision",
    "--item-id",
    "aggregate-policy",
    "--category",
    "engineering",
    "--summary",
    "Keep the policy in the aggregate.",
    "--rationale",
    "Every caller must enforce the same rule.",
  );
  semantic(
    "stage",
    "record",
    "--stage",
    "add-policy",
    "--kind",
    "decision",
    "--item-id",
    "aggregate-policy",
    "--category",
    "engineering",
    "--summary",
    "Keep cancellation policy in the aggregate.",
    "--rationale",
    "Every caller must enforce the same invariant.",
    "--replace",
  );
  semantic(
    "stage",
    "set",
    "--id",
    "add-policy",
    "--summary",
    "Add an explicit domain cancellation transition.",
  );
  semantic(
    "stage",
    "record",
    "--stage",
    "add-policy",
    "--kind",
    "failed-attempt",
    "--item-id",
    "ordinal-state-check",
    "--approach",
    "Compare state ordinals.",
    "--outcome",
    "The result was fragile when states are inserted.",
    "--lesson",
    "Use an explicit allow-list.",
  );
  semantic(
    "stage",
    "validation",
    "--stage",
    "add-policy",
    "--item-id",
    "domain-test",
    "--type",
    "automated",
    "--status",
    "passed",
    "--summary",
    "The domain transition passed.",
    "--command",
    "node --test domain.test.mjs",
  );

  fs.mkdirSync(path.join(repository, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(repository, "src", "order.txt"),
    "pending -> cancelled\n",
    "utf8",
  );
  git("add", "src/order.txt");
  git("commit", "-m", "Add cancellation policy");
  const firstCommit = git("rev-parse", "HEAD");
  semantic("stage", "finish", "--id", "add-policy", "--commit", "HEAD");
  semantic(
    "stage",
    "record",
    "--stage",
    "add-policy",
    "--finalized",
    "--kind",
    "risk",
    "--item-id",
    "canonical-check",
    "--summary",
    "The canonical artifact needs a post-finalization check.",
    "--mitigation",
    "Record the result through the finalized context update path.",
  );
  semantic(
    "stage",
    "validation",
    "--stage",
    "add-policy",
    "--finalized",
    "--item-id",
    "canonical-load",
    "--type",
    "analysis",
    "--status",
    "passed",
    "--summary",
    "The finalized stage remained schema and Git valid.",
  );

  semantic(
    "stage",
    "begin",
    "--id",
    "persist-state",
    "--title",
    "Persist cancellation",
    "--summary",
    "Store and reload the cancelled state.",
    "--rationale",
    "Persistence is reviewed separately from the domain policy.",
    "--depends-on",
    "add-policy",
    "--requirement-ref",
    "cancel-order#persist-state",
  );
  semantic(
    "stage",
    "record",
    "--stage",
    "persist-state",
    "--kind",
    "assumption",
    "--item-id",
    "string-state",
    "--statement",
    "The existing string column accepts the new state.",
    "--risk-if-wrong",
    "A database constraint may reject writes.",
  );
  semantic(
    "stage",
    "validation",
    "--stage",
    "persist-state",
    "--item-id",
    "persistence-test",
    "--type",
    "manual",
    "--status",
    "passed",
    "--summary",
    "The state round-tripped in the test database.",
  );
  fs.writeFileSync(
    path.join(repository, "src", "persistence.txt"),
    "cancelled\n",
    "utf8",
  );
  git("add", "src/persistence.txt");
  git("commit", "-m", "Persist cancellation state");
  const secondCommit = git("rev-parse", "HEAD");
  semantic("stage", "finish", "--id", "persist-state", "--commit", "HEAD");
  semantic("validate", "--publish");

  const firstStage = readJson(
    ".semantic-review/stages/add-policy.json",
  );
  if (
    firstStage.change.commit !== firstCommit ||
    firstStage.decisions[0]?.summary !==
      "Keep cancellation policy in the aggregate." ||
    firstStage.summary !== "Add an explicit domain cancellation transition." ||
    firstStage.failedAttempts[0]?.id !== "ordinal-state-check" ||
    firstStage.risks[0]?.id !== "canonical-check" ||
    firstStage.validation[1]?.id !== "canonical-load" ||
    firstStage.change.files[0]?.path !== "src/order.txt"
  ) {
    throw new Error("Finalized stage did not preserve captured context.");
  }
  const secondStage = readJson(
    ".semantic-review/stages/persist-state.json",
  );
  if (
    secondStage.change.commit !== secondCommit ||
    secondStage.dependsOn[0] !== "add-policy"
  ) {
    throw new Error("Dependent stage was not finalized correctly.");
  }

  git("checkout", "--detach", base);
  fs.writeFileSync(
    path.join(repository, "base-update.txt"),
    "target branch advanced\n",
    "utf8",
  );
  git("add", "base-update.txt");
  git("commit", "-m", "Advance target branch");
  const newBase = git("rev-parse", "HEAD");
  git("cherry-pick", "--no-commit", firstCommit);
  git("commit", "-m", "Rewrite cancellation policy");
  const rewrittenFirst = git("rev-parse", "HEAD");
  git("cherry-pick", "--no-commit", secondCommit);
  git("commit", "-m", "Rewrite persistence");
  const rewrittenSecond = git("rev-parse", "HEAD");

  semantic(
    "refresh",
    "--base",
    newBase,
    "--stage",
    `add-policy=${rewrittenFirst}`,
    "--stage",
    `persist-state=${rewrittenSecond}`,
  );
  semantic("validate", "--publish");

  const refreshedFirst = readJson(
    ".semantic-review/stages/add-policy.json",
  );
  const refreshedSecond = readJson(
    ".semantic-review/stages/persist-state.json",
  );
  if (
    readJson(".semantic-review/manifest.json").baseRevision !== newBase ||
    refreshedFirst.change.commit !== rewrittenFirst ||
    refreshedSecond.change.commit !== rewrittenSecond
  ) {
    throw new Error("Refresh did not update rewritten commit bindings.");
  }

  semantic(
    "stage",
    "begin",
    "--id",
    "discarded-stage",
    "--title",
    "Discarded stage",
    "--summary",
    "This stage is intentionally abandoned.",
    "--rationale",
    "The implementation was no longer required.",
    "--requirement-ref",
    "cancel-order#cancel-pending",
  );
  semantic("stage", "discard", "--id", "discarded-stage");
  semantic("validate", "--publish");

  const accidentalArtifact = spawnSync(
    "git",
    ["check-ignore", ".semantic-review/manifest.json"],
    { cwd: repository, encoding: "utf8" },
  );
  if (accidentalArtifact.status !== 0) {
    throw new Error(".semantic-review was not added to local Git excludes.");
  }

  const stageTip = git("rev-parse", "HEAD");
  semantic("publish", "--message", "Publish test semantic review");
  const publishedHead = git("rev-parse", "HEAD");
  if (git("rev-parse", "HEAD^") !== stageTip) {
    throw new Error("Published metadata did not directly follow the stage tip.");
  }
  const publishedPaths = git("diff", "--name-only", "HEAD^", "HEAD")
    .split(/\r?\n/)
    .filter(Boolean);
  if (
    publishedPaths.length === 0 ||
    !publishedPaths.every((file) => file.startsWith(".semantic-review/"))
  ) {
    throw new Error("Publication commit contained non-artifact paths.");
  }

  semantic("prepare-pr", "--branch", "review/test-approved");
  if (git("rev-parse", "review/test-approved") !== publishedHead) {
    throw new Error("PR-ready branch did not point to the published review.");
  }

  semantic("archive", "--message", "Archive test semantic review");
  if (
    fs.existsSync(path.join(repository, ".semantic-review")) ||
    !fs.existsSync(
      path.join(
        repository,
        ".semantic-review-history",
        "cancel-order",
        ".semantic-review",
        "manifest.json",
      ),
    )
  ) {
    throw new Error("Review archival did not move the published artifact.");
  }

  console.log("Semantic story implementation workflow passed.");
} finally {
  fs.rmSync(repository, { recursive: true, force: true });
}
