import assert from "node:assert/strict";
import test from "node:test";
import { captureCodeTarget, resolveCodeTarget, createViewerDataSource } from "../../../skills/semantic-flow/scripts/semantic-view.mjs";
import { createRepository, initializeImplementation, beginStage, organizeStage } from "../helpers/repository.mjs";

const content = "// header\nfunction check(value) {\n  if (!value) throw new Error('missing');\n  return value;\n}\n// footer\n";
function fixture(t, text = content) {
  const repo = createRepository(t);
  const revision = repo.commitFile("src/check.js", text, "Add check");
  return { repo, revision, target: captureCodeTarget(repo.root, revision, "src/check.js", 3, 4) };
}

test("code links preserve exact original context and map shifted lines and renamed files", t => {
  const { repo, revision, target } = fixture(t);
  assert.equal(resolveCodeTarget(repo.root, target, revision).status, "current");
  assert.deepEqual(target.context, content.trimEnd().split("\n"));
  let head = repo.commitFile("src/check.js", "// inserted\n" + content, "Shift lines");
  let resolved = resolveCodeTarget(repo.root, target, head);
  assert.equal(resolved.status, "mapped");
  assert.equal(resolved.startLine, 4);
  assert.equal(resolved.endLine, 5);
  assert.deepEqual(resolved.original, target);
  repo.git("mv", "src/check.js", "src/renamed.js");
  repo.git("commit", "-m", "Rename check");
  head = repo.git("rev-parse", "HEAD");
  resolved = resolveCodeTarget(repo.root, target, head);
  assert.equal(resolved.path, "src/renamed.js");
  assert.equal(resolved.startLine, 4);
  assert.equal(resolved.status, "mapped");
  // Resolve directly from the immutable original, never accumulate offsets.
  assert.deepEqual(resolveCodeTarget(repo.root, target, head), resolved);
});

test("changed, inserted, deleted and moved target lines require review", async t => {
  for (const [label, text] of [
    ["modified", content.replace("'missing'", "'required'")],
    ["inserted", content.replace("  return", "  audit(value);\n  return")],
    ["deleted", content.replace("  if (!value) throw new Error('missing');\n  return value;\n", "")],
    ["moved", "  if (!value) throw new Error('missing');\n  return value;\n" + content.replace("  if (!value) throw new Error('missing');\n  return value;\n", "")],
  ]) await t.test(label, t => {
    const { repo, target } = fixture(t);
    const head = repo.commitFile("src/check.js", text, label);
    const resolved = resolveCodeTarget(repo.root, target, head);
    assert.equal(resolved.status, "needs-review");
    assert.deepEqual(resolved.original.context, target.context);
    assert.equal(resolved.startLine, undefined);
  });
});

test("insertions at span boundaries require review while distant insertions remain mappable", async t => {
  for (const [label, text, expected] of [
    ["immediately before", content.replace("  if (!value)", "  if (enabled) {\n  if (!value)"), "needs-review"],
    ["immediately after", content.replace("  return value;\n", "  return value;\n  }\n"), "needs-review"],
    ["before surrounding context", "// another header\n" + content, "mapped"],
    ["after surrounding context", content + "// another footer\n", "mapped"],
  ]) await t.test(label, t => {
    const { repo, target } = fixture(t);
    const head = repo.commitFile("src/check.js", text, label);
    const result = resolveCodeTarget(repo.root, target, head);
    assert.equal(result.status, expected);
    assert.deepEqual(result.original, target);
  });
});

test("deleted files, ambiguous repeated code and unavailable originals retain inspectable context", async t => {
  await t.test("deleted file", t => {
    const { repo, target } = fixture(t);
    repo.git("rm", "src/check.js"); repo.git("commit", "-m", "Delete file");
    assert.match(resolveCodeTarget(repo.root, target, repo.git("rev-parse", "HEAD")).reason, /deleted/);
  });
  await t.test("repeated code", t => {
    const { repo, target } = fixture(t);
    const head = repo.commitFile("src/check.js", content + content, "Duplicate code");
    assert.match(resolveCodeTarget(repo.root, target, head).reason, /ambiguous/);
  });
  await t.test("missing revision", t => {
    const { repo, revision, target } = fixture(t);
    const missing = { ...target, revision: "f".repeat(40) };
    const resolved = resolveCodeTarget(repo.root, missing, revision);
    assert.equal(resolved.status, "needs-review");
    assert.deepEqual(resolved.original.context, target.context);
  });
});

test("code target capture rejects invalid ranges, traversal, binary and symlink files", t => {
  const { repo, revision } = fixture(t);
  for (const [start, end] of [[0, 1], [3, 2], [1, 90], [1.5, 2]]) assert.throws(() => captureCodeTarget(repo.root, revision, "src/check.js", start, end), /range/);
  assert.throws(() => captureCodeTarget(repo.root, revision, "../outside", 1, 1), /relative/);
  assert.throws(() => captureCodeTarget(repo.root, revision, "missing", 1, 1), /regular text/);
  const binaryHead = repo.commitFile("binary", "a\0b", "Binary");
  assert.throws(() => captureCodeTarget(repo.root, binaryHead, "binary", 1, 1), /regular text/);
  const blob = repo.git("hash-object", "-w", "README.md");
  repo.git("update-index", "--add", "--cacheinfo", `120000,${blob},link`);
  repo.git("commit", "-m", "Symlink");
  assert.throws(() => captureCodeTarget(repo.root, repo.git("rev-parse", "HEAD"), "link", 1, 1), /regular text/);
});

test("all insight kinds and validation support optional capture, replacement, retarget and removal", t => {
  const repo = createRepository(t);
  initializeImplementation(repo); beginStage(repo);
  repo.commitFile("src/check.js", content, "Add check");
  const kinds = [
    ["decision", "decisions", ["--category", "engineering", "--summary", "Check input", "--rationale", "Explain why"]],
    ["assumption", "assumptions", ["--statement", "Input may be absent", "--risk-if-wrong", "Extra check"]],
    ["alternative", "alternatives", ["--approach", "Ignore input", "--reason-rejected", "Must report error"]],
    ["failed-attempt", "failedAttempts", ["--approach", "Ignore input", "--outcome", "Failed", "--lesson", "Check it"]],
    ["risk", "risks", ["--summary", "May reject input"]],
    ["question", "openQuestions", ["--question", "Which inputs?"]],
    ["validation", "validation", ["--type", "analysis", "--status", "passed", "--summary", "Inspected check"]],
  ];
  const read = () => repo.readJson(".semantic-review/.work/stages/implementation.json");
  for (const [kind, collection, fields] of kinds) {
    const args = ["stage", kind === "validation" ? "validation" : "record", ...(kind === "validation" ? [] : ["--kind", kind]), "--item-id", kind, ...fields];
    repo.semantic(...args, "--code-path", "src/check.js", "--code-start", "3", "--code-end", "4");
    const captured = read()[collection][0].codeTarget;
    assert.equal(captured.startLine, 3);
    repo.semantic(...args, "--replace");
    assert.deepEqual(read()[collection][0].codeTarget, captured);
    repo.semantic("stage", "target", "--collection", collection, "--item-id", kind, "--code-path", "src/check.js", "--code-start", "4");
    assert.equal(read()[collection][0].codeTarget.endLine, 4);
    repo.semantic("stage", "target", "--collection", collection, "--item-id", kind, "--remove");
    assert.equal(read()[collection][0].codeTarget, undefined);
  }
  repo.expectSemanticFailure(/require --code-path/, "stage", "target", "--collection", "risks", "--item-id", "risk", "--code-start", "3");
  repo.expectSemanticFailure(/line range/, "stage", "target", "--collection", "risks", "--item-id", "risk", "--code-path", "src/check.js", "--code-start", "999");
  assert.equal(read().risks[0].codeTarget, undefined);
  repo.semantic("stage", "target", "--collection", "risks", "--item-id", "risk", "--code-path", "src/check.js", "--code-start", "3");
  organizeStage(repo); repo.semantic("stage", "finish");
  const source = createViewerDataSource(repo.root);
  const data = JSON.parse(source.implementationDataScript().replace(/^window.SEMANTIC_IMPLEMENTATION = /, "").trim().replace(/;$/, ""));
  assert.equal(data.stages[0].insights.find(item => item.id === "risk").codeTarget.status, "current");
  repo.semantic("stage", "target", "--stage", "implementation", "--finalized", "--collection", "risks", "--item-id", "risk", "--remove");
  repo.semantic("validate");
});

test("code targets validate stored context and batch recording is atomic", t => {
  const repo = createRepository(t);
  initializeImplementation(repo); beginStage(repo);
  repo.commitFile("src/check.js", content, "Add check");
  const args = { kind: "risk", "item-id": "check", summary: "Check", "code-path": "src/check.js", "code-start": "3" };
  repo.expectSemanticFailure(/line range/, "stage", "record-batch", "--items", JSON.stringify([args, { ...args, "item-id": "bad", "code-start": "999" }]));
  const file = ".semantic-review/.work/stages/implementation.json";
  assert.equal(repo.readJson(file).risks.length, 0);
  repo.semantic("stage", "record-batch", "--items", JSON.stringify([args]));
  const stage = repo.readJson(file);
  stage.risks[0].codeTarget.context[0] = "forged";
  repo.write(file, JSON.stringify(stage));
  repo.expectSemanticFailure(/does not match/, "validate");
  stage.risks[0].codeTarget.endLine = 999;
  repo.write(file, JSON.stringify(stage));
  repo.expectSemanticFailure(/complete ordered line range/, "validate", "--schema-only");
});


test("restacking resolves from the original anchor and publication preserves it", t => {
  const repo = createRepository(t);
  initializeImplementation(repo); beginStage(repo);
  repo.commitFile("src/check.js", content, "Add check");
  repo.semantic("stage", "record", "--kind", "decision", "--item-id", "check", "--category", "engineering", "--summary", "Check input", "--rationale", "Required", "--code-path", "src/check.js", "--code-start", "3", "--code-end", "4");
  organizeStage(repo); repo.semantic("stage", "finish");
  const file = ".semantic-review/stages/implementation.json";
  const original = repo.readJson(file).decisions[0].codeTarget;
  repo.commitFile("src/check.js", "// inserted\n" + content, "Shift lines");
  repo.semantic("restack", "--from", "implementation");
  assert.deepEqual(repo.readJson(file).decisions[0].codeTarget, original);
  const viewer = createViewerDataSource(repo.root);
  const readViewer = () => JSON.parse(viewer.implementationDataScript().replace(/^window.SEMANTIC_IMPLEMENTATION = /, "").trim().replace(/;$/, ""));
  assert.equal(readViewer().stages[0].insights[0].codeTarget.startLine, 4);
  repo.semantic("publish");
  const published = JSON.parse(repo.git("show", "semantic-flow/test-implementation/metadata:" + file));
  assert.deepEqual(published.decisions[0].codeTarget, original);
  repo.commitFile("src/check.js", content.replace("'missing'", "'required'"), "Change target");
  repo.semantic("restack", "--from", "implementation");
  assert.equal(readViewer().stages[0].insights[0].codeTarget.status, "needs-review");
  repo.semantic("stage", "target", "--stage", "implementation", "--finalized", "--collection", "decisions", "--item-id", "check", "--code-path", "src/check.js", "--code-start", "3", "--code-end", "4");
  assert.equal(readViewer().stages[0].insights[0].codeTarget.status, "current");
  assert.equal(repo.readJson(file).decisions[0].rationale, "Required");
});
