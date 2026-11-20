import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  beginStage,
  createRepository,
  finalizeStage,
  flowCli,
  initializeImplementation,
} from "../helpers/repository.mjs";

test("publish and local preparation enforce boundaries", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository, { implementationId: "publish-implementation" });
  beginStage(repository);
  const stageTip = finalizeStage(repository);

  repository.expectSemanticFailure(
    "cannot be combined",
    "validate",
    "--schema-only",
    "--publish",
  );
  repository.semantic("validate");
  repository.semantic("validate", "--publish");

  const prepared = JSON.parse(repository.semantic("validate-stack", "--json"));
  assert.equal(prepared.stages[0].baseBranch, "main");
  assert.equal(prepared.finalHeadRevision, stageTip);
  assert.equal("github" in prepared, false);

  repository.semantic(
    "prepare-branch",
    "--branch",
    "review/publish-implementation",
  );
  assert.equal(repository.git("rev-parse", "review/publish-implementation"), stageTip);
  repository.semantic("prepare-branch");
  repository.git("branch", "review/conflict", "main");
  repository.expectSemanticFailure(
    "is bound to cumulative branch",
    "prepare-branch",
    "--branch",
    "review/conflict",
  );
  repository.semantic(
    "prepare-branch",
    "--branch",
    "review/conflict",
    "--rebind",
    "--adopt",
  );
  assert.equal(repository.git("rev-parse", "review/conflict"), stageTip);
  assert.equal(repository.git("rev-parse", "review/publish-implementation"), stageTip);

  const metadataBranch = "semantic-flow/publish-implementation/metadata";
  const published = repository.git("rev-parse", metadataBranch);
  assert.equal(repository.git("rev-parse", `${metadataBranch}^`), stageTip);
  assert.equal(repository.git("rev-parse", "HEAD"), stageTip);
  assert.doesNotMatch(
    repository.git("show", "-s", "--format=%B", metadataBranch),
    /Co-authored-by: Copilot/,
  );
  const publishedPaths = repository
    .git("diff", "--name-only", `${metadataBranch}^`, metadataBranch)
    .split(/\r?\n/)
    .filter(Boolean);
  assert.ok(
    publishedPaths.length > 0 &&
      publishedPaths.every((file) => file.startsWith(".semantic-review/")),
  );

  repository.semantic("publish");
  assert.equal(repository.git("rev-parse", metadataBranch), published);
  repository.semantic("publish");
  // Publication stores the full form, readable without the repository.
  const full = repository.artifact.implementation();
  const publishedJson = (file) => JSON.parse(repository.git("show", `${metadataBranch}:.semantic-review/${file}`));
  assert.deepEqual(publishedJson("manifest.json"), full.manifest);
  assert.deepEqual(full.manifest.stages, ["implementation"]);
  assert.deepEqual(publishedJson("stages/implementation.json"), full.stages.implementation);
  assert.equal(full.stages.implementation.change.branch, "semantic-flow/publish-implementation/stages/implementation");
  assert.equal(full.stages.implementation.change.headRevision, stageTip);
  assert.deepEqual(full.stages.implementation.change.files, [{ path: "implementation.txt", kind: "added" }]);
});

test("archive pins the publication under a ref and records landing by ancestry", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository, { implementationId: "archived" });
  beginStage(repository);
  const stageTip = finalizeStage(repository);
  const metadataBranch = "semantic-flow/archived/metadata";
  const stageBranch = "semantic-flow/archived/stages/implementation";
  repository.semantic("publish");
  const published = repository.git("rev-parse", metadataBranch);
  // A change after publication is published by the archive itself.
  repository.semantic("stage", "record", "--stage", "implementation", "--finalized", "--kind", "decision",
    "--item-id", "archive-current-metadata", "--category", "engineering", "--summary", "Archive only current metadata.",
    "--rationale", "The archive is the durable copy of the implementation artifact.", "--node-ref", "implementation-change");
  const full = repository.artifact.implementation();
  repository.git("switch", "main");
  repository.git("merge", "--ff-only", stageBranch);
  const target = repository.git("rev-parse", "main");
  // Nothing in the worktree takes part, so neither a dirty file nor a failing hook matters.
  repository.write("untracked.txt", "left alone\n");
  const hook = path.join(repository.git("rev-parse", "--path-format=absolute", "--git-path", "hooks"), "pre-commit");
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  repository.semantic("archive", "--message", "Archive test implementation");

  const archive = "refs/semantic-review/archive/archived";
  assert.equal(repository.git("for-each-ref", "refs/semantic-review/active/"), "");
  assert.equal(repository.artifact.present(), false);
  // The target branch, the checkout and every branch are left as they were.
  assert.equal(repository.git("rev-parse", "main"), target);
  assert.equal(repository.git("rev-parse", "HEAD"), target);
  assert.equal(repository.git("status", "--porcelain"), "?? untracked.txt");
  assert.equal(repository.git("rev-parse", stageBranch), stageTip);
  // The archive is one commit on top of the republished metadata commit; it adds only the landing record.
  const republished = repository.git("rev-parse", metadataBranch);
  assert.notEqual(republished, published);
  assert.equal(repository.git("rev-parse", `${archive}^`), republished);
  assert.equal(repository.git("rev-parse", `${republished}^`), stageTip);
  assert.equal(repository.git("diff", "--name-only", republished, archive), ".semantic-review/landing.json");
  assert.equal(repository.git("show", "-s", "--format=%s", archive), "Archive test implementation");
  const archivedJson = (file) => JSON.parse(repository.git("show", `${archive}:.semantic-review/${file}`));
  assert.deepEqual(archivedJson("manifest.json"), full.manifest);
  assert.deepEqual(archivedJson("stages/implementation.json"), full.stages.implementation);
  const landing = archivedJson("landing.json");
  assert.equal(landing.outcome, "ancestry");
  assert.equal(landing.targetRevision, target);
  assert.equal(landing.finalHeadRevision, stageTip);
  // An archived implementation's ID is not reused.
  repository.remove("untracked.txt");
  assert.throws(() => initializeImplementation(repository, { implementationId: "archived" }), /belongs to an archived implementation/);

  // A found landing stays; sharing creates an annotated tag that never moves.
  const archived = repository.git("rev-parse", archive);
  repository.semantic("archive", "landing", "--id", "archived");
  assert.equal(repository.git("rev-parse", archive), archived);
  const shared = repository.semantic("archive", "share", "--id", "archived");
  assert.match(shared, /git push <remote> refs\/tags\/semantic-review\/archive\/archived/);
  const tag = "refs/tags/semantic-review/archive/archived";
  assert.equal(repository.git("cat-file", "-t", tag), "tag");
  assert.equal(repository.git("rev-parse", `${tag}^{commit}`), repository.git("rev-parse", archive));
  repository.semantic("archive", "share", "--id", "archived");
  repository.expectSemanticFailure("never moves", "archive", "landing", "--id", "archived", "--landed", target);
  repository.expectSemanticFailure("No archive of missing", "archive", "share", "--id", "missing");
});

test("archive records an unknown landing, suggests a squash commit, and takes the reviewer's commit later", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository, { implementationId: "squashed" });
  beginStage(repository);
  const stageTip = finalizeStage(repository);
  repository.semantic("publish");
  // The remote squash-merged the stage and the target moved on.
  repository.git("switch", "main");
  repository.git("merge", "--squash", "semantic-flow/squashed/stages/implementation");
  repository.git("commit", "--no-verify", "-m", "Squashed implementation");
  const squash = repository.git("rev-parse", "HEAD");
  repository.write("later.txt", "later\n");
  repository.git("add", "later.txt");
  repository.git("commit", "--no-verify", "-m", "Later work");
  // A supplied revision must exist.
  repository.expectSemanticFailure(/./, "archive", "--landed", "no-such-revision");
  assert.equal(repository.artifact.present(), true);

  const archived = repository.semantic("archive");
  assert.match(archived, /landing unknown/);
  assert.match(archived, new RegExp(`Target commit ${squash} matches the implementation's changes`));
  const archive = "refs/semantic-review/archive/squashed";
  const landing = () => JSON.parse(repository.git("show", `${archive}:.semantic-review/landing.json`));
  assert.equal(landing().outcome, "unknown");
  assert.equal("targetRevision" in landing(), false);
  const before = repository.git("rev-parse", archive);
  repository.semantic("archive", "landing", "--id", "squashed");
  assert.equal(repository.git("rev-parse", archive), before);

  repository.semantic("archive", "landing", "--id", "squashed", "--landed", squash.slice(0, 12));
  assert.equal(landing().outcome, "supplied");
  assert.equal(landing().landedCommits, squash);
  assert.equal(repository.git("rev-parse", `${archive}^`), repository.git("rev-parse", `${before}^`));
  repository.expectSemanticFailure("takes a commit or a range", "archive", "landing", "--id", "squashed", "--landed", `${squash}...main`);
});

test("archive suggests the range a rebase merge landed and archives an unpublished implementation", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository, { implementationId: "rebased" });
  beginStage(repository, { id: "first" });
  finalizeStage(repository, { id: "first" });
  beginStage(repository, { id: "second", dependencies: ["first"] });
  const secondTip = finalizeStage(repository, { id: "second" });
  repository.git("switch", "main");
  repository.write("unrelated.txt", "unrelated\n");
  repository.git("add", "unrelated.txt");
  repository.git("commit", "--no-verify", "-m", "Unrelated");
  const parent = repository.git("rev-parse", "HEAD");
  repository.git("cherry-pick", "main..semantic-flow/rebased/stages/second");
  const last = repository.git("rev-parse", "HEAD");
  const result = JSON.parse(repository.flow("archive", "--json"));
  assert.equal(result.archive.landing.outcome, "unknown");
  assert.equal(result.archive.suggestedLanding, `${parent}..${last}`);
  // Never published before: archiving published it.
  assert.equal(repository.git("rev-parse", "semantic-flow/rebased/metadata^"), secondTip);
  assert.equal(repository.git("rev-parse", "refs/semantic-review/archive/rebased^"), repository.git("rev-parse", "semantic-flow/rebased/metadata"));
});

test("repeat preparation updates the bound PR branch and metadata atomically", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository, { implementationId: "stable-pr" });
  beginStage(repository);
  const originalHead = finalizeStage(repository);
  const branch = "review/stable-pr";
  const bindingRef = `refs/semantic-review/prepared/stable-pr/${Buffer.from(branch, "utf8").toString("base64url")}`;

  repository.semantic("prepare-branch", "--branch", branch);
  const originalMetadata = repository.git(
    "rev-parse",
    "semantic-flow/stable-pr/metadata",
  );
  assert.equal(repository.git("rev-parse", branch), originalHead);
  assert.equal(repository.git("rev-parse", bindingRef), originalHead);

  repository.commitFile("implementation.txt", "implementation v2\n", "Fix CI");
  repository.semantic("restack", "--from", "implementation");
  const revisedHead = repository.git(
    "rev-parse",
    "semantic-flow/stable-pr/stages/implementation",
  );
  assert.notEqual(revisedHead, originalHead);

  const output = repository.semantic("prepare-branch");
  assert.match(output, /Updated bound cumulative branch review\/stable-pr/);
  assert.match(
    output,
    new RegExp(`--force-with-lease=refs/heads/review/stable-pr:${originalHead}`),
  );
  assert.equal(repository.git("rev-parse", branch), revisedHead);
  assert.equal(repository.git("rev-parse", bindingRef), revisedHead);
  const revisedMetadata = repository.git(
    "rev-parse",
    "semantic-flow/stable-pr/metadata",
  );
  assert.notEqual(revisedMetadata, originalMetadata);
  assert.equal(
    repository.git("rev-parse", "semantic-flow/stable-pr/metadata^"),
    revisedHead,
  );

  const stack = JSON.parse(repository.semantic("validate-stack", "--json"));
  assert.equal(stack.cumulativeBranch, branch);
  assert.equal(stack.preparedHeadRevision, revisedHead);
});

test("combined preparation reuses bindings and rejects drift before publication", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository, { implementationId: "combined-pr" });
  beginStage(repository);
  const originalHead = finalizeStage(repository);
  const branch = "review/combined-pr";
  const metadataBranch = "semantic-flow/combined-pr/metadata";

  const initial = JSON.parse(repository.flow("prepare", "--branch", branch, "--json"));
  assert.equal(initial.cumulativeBranch, branch);
  assert.equal(initial.preparedHeadRevision, originalHead);

  repository.commitFile("implementation.txt", "implementation v2\n", "Revise implementation");
  repository.semantic("restack", "--from", "implementation");
  const revised = JSON.parse(repository.flow("prepare", "--branch", branch, "--json"));
  assert.notEqual(revised.finalHeadRevision, originalHead);
  assert.equal(revised.preparedHeadRevision, revised.finalHeadRevision);
  assert.equal(repository.git("rev-parse", branch), revised.finalHeadRevision);
  assert.equal(repository.git("rev-parse", `${metadataBranch}^`), revised.finalHeadRevision);

  const metadataHead = repository.git("rev-parse", metadataBranch);
  repository.commitFile("implementation.txt", "implementation v3\n", "Revise again");
  repository.semantic("restack", "--from", "implementation");
  repository.git("branch", "-f", branch, "main");
  assert.throws(
    () => repository.flow("prepare", "--branch", branch, "--json"),
    /moved from prepared head/,
  );
  assert.equal(repository.git("rev-parse", metadataBranch), metadataHead);
  assert.equal(repository.git("rev-parse", branch), repository.git("rev-parse", "main"));
  const stack = JSON.parse(repository.semantic("validate-stack", "--json"));
  assert.equal(stack.preparedHeadRevision, revised.finalHeadRevision);
});

test("repeat preparation refuses externally moved bound branches without partial publication", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository, { implementationId: "guarded-pr" });
  beginStage(repository);
  const originalHead = finalizeStage(repository);
  const branch = "review/guarded-pr";

  repository.semantic("prepare-branch", "--branch", branch);
  const originalMetadata = repository.git(
    "rev-parse",
    "semantic-flow/guarded-pr/metadata",
  );
  repository.commitFile("implementation.txt", "implementation v2\n", "Fix CI");
  repository.semantic("restack", "--from", "implementation");
  repository.git("branch", "-f", branch, "main");

  repository.expectSemanticFailure(
    "moved from prepared head",
    "prepare-branch",
  );
  assert.equal(repository.git("rev-parse", branch), repository.git("rev-parse", "main"));
  assert.equal(
    repository.git("rev-parse", "semantic-flow/guarded-pr/metadata"),
    originalMetadata,
  );
  const bindingRef = `refs/semantic-review/prepared/guarded-pr/${Buffer.from(branch, "utf8").toString("base64url")}`;
  assert.equal(repository.git("rev-parse", bindingRef), originalHead);
});

test("preparation explicitly adopts a cumulative branch created before binding support", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository, { implementationId: "adopt-pr" });
  beginStage(repository);
  const reviewedHead = finalizeStage(repository);
  const branch = "review/adopt-pr";
  repository.git("branch", branch, "main");

  repository.expectSemanticFailure(
    "use --adopt",
    "prepare-branch",
    "--branch",
    branch,
  );
  repository.semantic("prepare-branch", "--branch", branch, "--adopt");
  assert.equal(repository.git("rev-parse", branch), reviewedHead);
  const bindingRef = `refs/semantic-review/prepared/adopt-pr/${Buffer.from(branch, "utf8").toString("base64url")}`;
  assert.equal(repository.git("rev-parse", bindingRef), reviewedHead);
});

test("preparation requires adoption before binding an existing branch at the reviewed head", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository, { implementationId: "adopt-current-pr" });
  beginStage(repository);
  const reviewedHead = finalizeStage(repository);
  const branch = "review/adopt-current-pr";
  repository.git("branch", branch, reviewedHead);

  repository.expectSemanticFailure(
    "use --adopt",
    "prepare-branch",
    "--branch",
    branch,
  );
  const output = repository.semantic(
    "prepare-branch",
    "--branch",
    branch,
    "--adopt",
  );
  assert.match(output, /Adopted and bound existing cumulative branch/);
});

test("publication rejects target drift until the stack is restacked", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository);
  finalizeStage(repository);

  repository.git("switch", "main");
  repository.commitFile("trunk.txt", "advanced\n", "Advance trunk");
  repository.expectSemanticFailure(
    "Target branch main moved",
    "validate",
    "--publish",
  );
  repository.expectSemanticFailure(
    "Target branch main moved",
    "validate-stack",
  );

  const refs = () => repository.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads");
  const before = { refs: refs(), manifest: repository.artifact.read("manifest.json") };
  repository.expectSemanticFailure("Option --json is a flag", "restack", "--base", "main", "--json=false");
  assert.equal(refs(), before.refs);
  assert.equal(repository.artifact.read("manifest.json"), before.manifest);

  repository.semantic("restack", "--base", "main");
  repository.semantic("validate", "--publish");
});

test("preparation ignores acceptance criteria outside the review", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository, {
    criteria: [
      ["reviewed", "Covered by the reviewed implementation."],
      ["not-reviewed", "Outside this review."],
    ],
  });
  beginStage(repository, { specificationRefs: ["story#reviewed"] });
  const stageTip = finalizeStage(repository);

  repository.semantic("validate");
  repository.semantic("validate", "--publish");
  const stack = JSON.parse(repository.semantic("validate-stack", "--json"));
  assert.equal(stack.finalHeadRevision, stageTip);
  repository.semantic(
    "prepare-branch",
    "--branch",
    "review/reviewed-criteria-only",
  );
  assert.equal(repository.git("rev-parse", "review/reviewed-criteria-only"), stageTip);
});

test("archive works without the target branch and from a linked worktree, and takes a supplied range", (t) => {
  const repository = createRepository(t);
  initializeImplementation(repository, { implementationId: "gone-target" });
  beginStage(repository);
  finalizeStage(repository);
  // With the target branch deleted, landing is unknown but archiving is not blocked.
  repository.git("branch", "-D", "main");
  const archived = repository.semantic("archive");
  assert.match(archived, /landing unknown/);
  assert.equal(JSON.parse(repository.git("show", "refs/semantic-review/archive/gone-target:.semantic-review/landing.json")).outcome, "unknown");

  const linked = createRepository(t);
  initializeImplementation(linked, { implementationId: "linked" });
  beginStage(linked);
  finalizeStage(linked);
  const stageBranch = "semantic-flow/linked/stages/implementation";
  // A rebase merge on main, which stays checked out in the main worktree.
  linked.git("switch", "main");
  linked.git("cherry-pick", stageBranch);
  const landed = linked.git("rev-parse", "HEAD");
  const before = linked.git("rev-parse", "HEAD^");
  const worktree = `${linked.root}-linked`;
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  linked.git("worktree", "add", worktree, stageBranch);
  const result = linked.result(process.execPath, [flowCli, "archive", "--json", "--project", worktree, "--landed", `${before}..${landed}`]);
  assert.equal(result.status, 0, result.stderr);
  const landing = JSON.parse(result.stdout).archive.landing;
  assert.equal(landing.outcome, "supplied");
  assert.equal(landing.landedCommits, `${before}..${landed}`);
  assert.equal(linked.git("rev-parse", "main"), landed);
  // A commit only the remote target holds is recorded as supplied, with a warning.
  const elsewhere = createRepository(t);
  initializeImplementation(elsewhere, { implementationId: "elsewhere" });
  beginStage(elsewhere);
  finalizeStage(elsewhere);
  elsewhere.git("switch", "-c", "remote-main", "main");
  elsewhere.commitFile("squashed.txt", "squashed\n", "Squash merge on the remote");
  const squash = elsewhere.git("rev-parse", "HEAD");
  const warned = elsewhere.result(process.execPath, [flowCli, "implementation", "archive", "--landed", squash]);
  assert.equal(warned.status, 0, warned.stderr);
  assert.match(warned.stderr, /not on the local target branch main/);
});

test("archive refuses a metadata branch that is the target, survives a failing diff driver, and shares only its own annotated tag", (t) => {
  const collision = createRepository(t);
  collision.git("switch", "-c", "semantic-flow/clash/metadata");
  initializeImplementation(collision, { implementationId: "clash", targetBranch: "semantic-flow/clash/metadata" });
  beginStage(collision);
  finalizeStage(collision);
  const target = collision.git("rev-parse", "semantic-flow/clash/metadata");
  collision.expectSemanticFailure("is the target branch", "archive");
  assert.equal(collision.git("rev-parse", "semantic-flow/clash/metadata"), target);
  assert.equal(collision.artifact.present(), true);

  const repository = createRepository(t);
  initializeImplementation(repository, { implementationId: "tagged" });
  beginStage(repository);
  finalizeStage(repository);
  repository.git("switch", "main");
  repository.git("merge", "--squash", "semantic-flow/tagged/stages/implementation");
  repository.git("commit", "--no-verify", "-m", "Squashed");
  const squash = repository.git("rev-parse", "HEAD");
  // An external diff driver that fails does not affect the suggestion.
  repository.git("config", "diff.external", "false");
  const result = JSON.parse(repository.flow("archive", "--json"));
  assert.equal(result.archive.suggestedLanding, squash);
  repository.git("tag", "semantic-review/archive/tagged", result.archive.commit);
  repository.expectSemanticFailure("is not an annotated tag", "archive", "share", "--id", "tagged");
  repository.expectSemanticFailure("never moves", "archive", "landing", "--id", "tagged", "--landed", squash);
});

test("archive writes only direct refs and replaces a stale artifact folder under a sparse checkout", (t) => {
  const repository = createRepository(t);
  repository.commitFile(".semantic-review/stale.txt", "stale\n", "Unrelated file where the artifact goes");
  initializeImplementation(repository, { implementationId: "direct" });
  beginStage(repository);
  finalizeStage(repository);
  repository.git("sparse-checkout", "set", "--no-cone", "/*", "!/.semantic-review/");
  repository.semantic("publish");
  // A target that is a symbolic ref to the metadata branch would move with it.
  repository.git("switch", "--detach");
  const target = repository.git("rev-parse", "main");
  repository.git("branch", "-D", "main");
  repository.git("symbolic-ref", "refs/heads/main", "refs/heads/semantic-flow/direct/metadata");
  repository.expectSemanticFailure("refs/heads/main is a symbolic ref", "archive");
  repository.git("symbolic-ref", "--delete", "refs/heads/main");
  repository.git("branch", "main", target);
  repository.semantic("archive");
  const archive = "refs/semantic-review/archive/direct";
  assert.notEqual(repository.result("git", ["cat-file", "-e", `${archive}:.semantic-review/stale.txt`]).status, 0);
  assert.equal(repository.git("rev-parse", `${archive}:.semantic-review/manifest.json`), repository.git("rev-parse", "semantic-flow/direct/metadata:.semantic-review/manifest.json"));
  // A dangling symbolic ref at the tag name is not overwritten.
  repository.git("symbolic-ref", "refs/tags/semantic-review/archive/direct", "refs/tags/elsewhere");
  repository.expectSemanticFailure("is a symbolic ref", "archive", "share", "--id", "direct");
  repository.expectSemanticFailure("is a symbolic ref", "archive", "landing", "--id", "direct", "--landed", target);
  assert.equal(repository.result("git", ["rev-parse", "--verify", "--quiet", "refs/tags/elsewhere"]).status, 1);
});
