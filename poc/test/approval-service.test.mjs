import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  readReviewApprovals,
  setReviewApproval,
} from "../src/approval-service.mjs";

const execFileAsync = promisify(execFile);

async function git(root, ...args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout.trim();
}

async function writeArtifact(root, { baseRevision, headRevision }) {
  const artifact = path.join(root, ".semantic-review");
  await fs.mkdir(path.join(artifact, "requirements"), { recursive: true });
  await fs.mkdir(path.join(artifact, "stages"), { recursive: true });
  await fs.writeFile(
    path.join(artifact, "manifest.json"),
    JSON.stringify({
      formatVersion: "0.1",
      reviewId: "approval-review",
      title: "Approval review",
      summary: "Exercise reviewer progress.",
      baseRevision,
      targetBranch: "main",
      branchPrefix: "semantic-review/approval-review",
      requirements: ["approval-requirement"],
      stages: ["approval-stage"],
    }),
    "utf8",
  );
  await fs.writeFile(
    path.join(artifact, "requirements", "approval-requirement.json"),
    JSON.stringify({
      id: "approval-requirement",
      title: "Track approvals",
      summary: "Reviewer progress remains visible.",
      source: {
        kind: "local",
        reference: "approval-test",
      },
      acceptanceCriteria: [
        {
          id: "approval-state",
          text: "Changed files invalidate approvals.",
        },
      ],
    }),
    "utf8",
  );
  await fs.writeFile(
    path.join(artifact, "stages", "approval-stage.json"),
    JSON.stringify({
      id: "approval-stage",
      title: "Add approval state",
      summary: "Track review progress.",
      rationale: "Reviewers need durable local state.",
      dependsOn: [],
      requirementRefs: ["approval-requirement#approval-state"],
      nodes: [
        {
          id: "approval-node",
          description: "Change the reviewed file.",
          changes: [
            {
              path: "reviewed.txt",
              classification: "behavior",
            },
          ],
        },
      ],
      change: {
        branch: "semantic-review/approval-review/01-approval-stage",
        baseBranch: "main",
        baseRevision,
        headRevision,
        files: [
          {
            path: "reviewed.txt",
            kind: "modified",
          },
        ],
      },
      decisions: [],
      assumptions: [],
      alternatives: [],
      failedAttempts: [],
      risks: [],
      validation: [],
      openQuestions: [],
    }),
    "utf8",
  );
}

test("invalidates changed approvals while retaining prior approval", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "review-approvals-"));
  try {
    await git(root, "init", "--quiet");
    await git(root, "config", "user.email", "review@example.test");
    await git(root, "config", "user.name", "Review Test");
    await fs.writeFile(path.join(root, "reviewed.txt"), "before\n", "utf8");
    await git(root, "add", "reviewed.txt");
    await git(root, "commit", "--quiet", "-m", "Base");
    const baseRevision = await git(root, "rev-parse", "HEAD");
    await fs.writeFile(path.join(root, "reviewed.txt"), "first review\n", "utf8");
    await git(root, "commit", "--quiet", "-am", "First change");
    const firstHead = await git(root, "rev-parse", "HEAD");
    await writeArtifact(root, {
      baseRevision,
      headRevision: firstHead,
    });

    const resources = [
      {
        kind: "file",
        stageId: "approval-stage",
        path: "reviewed.txt",
      },
      {
        kind: "node",
        stageId: "approval-stage",
        nodeId: "approval-node",
      },
      { kind: "stage", stageId: "approval-stage" },
      { kind: "changeSet" },
    ];
    for (const resource of resources) {
      await setReviewApproval({
        repositoryRoot: root,
        resource,
        approved: true,
      });
    }

    const approved = await readReviewApprovals({ repositoryRoot: root });
    assert.equal(approved.changeSet.approved, true);
    assert.equal(approved.stages["approval-stage"].approved, true);
    assert.equal(
      approved.nodes["approval-stage"]["approval-node"].approved,
      true,
    );
    assert.equal(
      approved.files["approval-stage"]["reviewed.txt"].approved,
      true,
    );

    await fs.writeFile(path.join(root, "reviewed.txt"), "changed again\n", "utf8");
    await git(root, "commit", "--quiet", "-am", "Rewrite reviewed file");
    const rewrittenHead = await git(root, "rev-parse", "HEAD");
    await writeArtifact(root, {
      baseRevision,
      headRevision: rewrittenHead,
    });

    const stale = await readReviewApprovals({ repositoryRoot: root });
    for (const status of [
      stale.changeSet,
      stale.stages["approval-stage"],
      stale.nodes["approval-stage"]["approval-node"],
      stale.files["approval-stage"]["reviewed.txt"],
    ]) {
      assert.equal(status.approved, false);
      assert.equal(status.previouslyApproved, true);
    }

    const cleared = await setReviewApproval({
      repositoryRoot: root,
      resource: {
        kind: "file",
        stageId: "approval-stage",
        path: "reviewed.txt",
      },
      approved: false,
    });
    assert.equal(
      cleared.files["approval-stage"]["reviewed.txt"].previouslyApproved,
      false,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("keeps child approval records independent from parent approvals", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "review-approvals-"));
  try {
    await git(root, "init", "--quiet");
    await git(root, "config", "user.email", "review@example.test");
    await git(root, "config", "user.name", "Review Test");
    await fs.writeFile(path.join(root, "reviewed.txt"), "before\n", "utf8");
    await git(root, "add", "reviewed.txt");
    await git(root, "commit", "--quiet", "-m", "Base");
    const baseRevision = await git(root, "rev-parse", "HEAD");
    await fs.writeFile(path.join(root, "reviewed.txt"), "reviewed\n", "utf8");
    await git(root, "commit", "--quiet", "-am", "Change");
    const headRevision = await git(root, "rev-parse", "HEAD");
    await writeArtifact(root, { baseRevision, headRevision });

    const file = {
      kind: "file",
      stageId: "approval-stage",
      path: "reviewed.txt",
    };
    const stage = { kind: "stage", stageId: "approval-stage" };
    await setReviewApproval({
      repositoryRoot: root,
      resource: file,
      approved: true,
    });
    await setReviewApproval({
      repositoryRoot: root,
      resource: stage,
      approved: true,
    });
    const restored = await setReviewApproval({
      repositoryRoot: root,
      resource: stage,
      approved: false,
    });

    assert.equal(restored.stages["approval-stage"].approved, false);
    assert.equal(restored.files["approval-stage"]["reviewed.txt"].approved, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
