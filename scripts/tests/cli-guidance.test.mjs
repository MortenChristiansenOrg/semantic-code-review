// What the CLI tells a caller who got a command or its input wrong.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cliApis, fullCommand } from "../src/command-api.ts";
import {
  beginStage,
  createImplementationWithStages,
  createRepository,
  flowCli,
  initializeImplementation,
} from "./helpers/repository.mjs";

const BOM = "﻿";
const ORGANIZATION_SCHEMA = "https://semantic-code-review.dev/skills/semantic-flow/v0.1/stage-organization.schema.json";
const schema = (file) => JSON.parse(fs.readFileSync(new URL(`../../standard/v0.1/${file}`, import.meta.url), "utf8")).$defs;

function run(cwd, args, input = "") {
  return spawnSync(process.execPath, [flowCli, ...args], { cwd, input, encoding: "utf8" });
}

function failure(cwd, args, input) {
  const result = run(cwd, args, input);
  assert.notEqual(result.status, 0, result.stdout);
  return result.stderr;
}

function outsideRepository(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-no-repository-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function workingStage(t) {
  const repository = createRepository(t);
  initializeImplementation(repository);
  beginStage(repository);
  const batch = (value, ...args) => failure(repository.root, ["implementation", "stage", "record-batch", "--input", "-", ...args], JSON.stringify(value));
  return { repository, batch };
}

test("every command's help shows its options outside a Git repository", (t) => {
  const cwd = outsideRepository(t);
  for (const api of cliApis) {
    for (const { command, options = [] } of api.commands) {
      const words = fullCommand(api, command).split(" ");
      // `feedback --help` is the feedback group's help, which includes the workflow command of that name.
      const result = run(cwd, [...words, "--help"]);
      assert.equal(result.status, 0, `${words.join(" ")}: ${result.stderr}`);
      assert.ok(result.stdout.includes(`semantic-flow.mjs ${words.join(" ")}${options.length ? " [options]" : ""}\n\nOptions:\n`), result.stdout);
      for (const { name, value, required, repeatable, note } of options) {
        const usage = `  --${name}${value ? ` ${value}` : ""}${repeatable ? " ..." : ""}`;
        const notes = [required && "required", note].filter(Boolean).join("; ");
        assert.ok(result.stdout.includes(`${usage}${notes ? `  (${notes})` : ""}\n`), `${words.join(" ")} --${name}`);
      }
    }
  }
});

test("help follows either spelling, reads no input, and rejects unknown commands", (t) => {
  const cwd = outsideRepository(t);
  const flag = run(cwd, ["implementation", "archive", "landing", "--help"]);
  assert.equal(run(cwd, ["implementation", "help", "archive", "landing"]).stdout, flag.stdout);
  assert.match(run(cwd, ["implementation", "stage", "--help"]).stdout, /implementation stage record-batch/);
  assert.match(run(cwd, ["viewer", "serve", "--help"]).stdout, /usage: semantic-flow viewer serve/);
  const input = run(cwd, ["implementation", "init", "--input", "absent.json", "--help"]);
  assert.equal(input.status, 0, input.stderr);
  assert.match(input.stdout, /--implementation-id <id>  \(required\)/);
  assert.match(failure(cwd, ["implementation", "stage", "unknown", "--help"]), /Unknown command: stage unknown/);
});

test("help lists the allowed values the schemas enforce", () => {
  const artifact = schema("schema/common.schema.json"), feedback = schema("feedback-schema/common.schema.json");
  const expected = [
    ["stage record", "category", artifact.decision.properties.category.enum],
    ["stage validation", "type", artifact.validationEvidence.properties.type.enum],
    ["stage validation", "status", artifact.validationEvidence.properties.status.enum],
    ["stage evidence", "kind", artifact.evidence.properties.kind.enum],
    ["stage target", "collection", feedback.target.properties.collection.enum],
    ["thread add", "collection", feedback.target.properties.collection.enum],
    ["thread add", "target-kind", feedback.target.properties.kind.enum],
    ["thread add", "side", feedback.target.properties.side.enum],
    ["thread reply", "author", feedback.comment.properties.author.enum],
  ];
  for (const [command, name, values] of expected) {
    const option = cliApis.flatMap((api) => api.commands).find((entry) => entry.command === command).options.find((entry) => entry.name === name);
    assert.deepEqual(option.value.slice(1, -1).split("|"), values, `${command} --${name}`);
  }
});

test("the options help requires for each insight kind are the ones the command requires", (t) => {
  const { repository } = workingStage(t);
  const { options } = cliApis[0].commands.find(({ command }) => command === "stage record");
  for (const kind of options.find(({ name }) => name === "kind").value.slice(1, -1).split("|")) {
    const required = options.filter(({ note }) => note?.startsWith("required for --kind") && note.slice("required for --kind ".length).split(" or ").includes(kind));
    const base = ["implementation", "stage", "record", "--kind", kind, "--item-id", `item-${kind}`];
    const values = ({ name }) => [`--${name}`, name === "category" ? "engineering" : "Text"];
    for (const missing of required) {
      const args = [...base, ...required.filter((option) => option !== missing).flatMap(values)];
      assert.match(failure(repository.root, args), new RegExp(`Missing required option --${missing.name}\\.`));
    }
    const complete = run(repository.root, [...base, ...required.flatMap(values)]);
    assert.equal(complete.status, 0, `${kind}: ${complete.stderr}`);
  }
});

test("unknown input keys are reported together, before their values are converted", (t) => {
  const { repository, batch } = workingStage(t);
  const before = repository.artifact.implementation();
  const error = batch({ stageId: "implementation", validations: [{ summary: "Tests pass" }], decisions: [{ id: "d" }] });
  assert.match(error, /JSON input standard input: Unknown keys "stageId", "validations", "decisions"\. Valid keys: stage, finalized, items\./);
  assert.doesNotMatch(error, /arrays may contain/);
  assert.deepEqual(repository.artifact.implementation(), before);

  // Every group checks keys before it looks for a repository.
  const cwd = outsideRepository(t);
  for (const [args, valid] of [
    [["implementation", "stage", "plan"], "stage, finalized, selectors"],
    [["feedback", "thread", "add-batch"], "threads, partial"],
    [["version"], "json"],
    [["feedback", "init"], "none"],
  ]) {
    assert.ok(failure(cwd, [...args, "--input", "-"], '{"wrong":[{"a":1}]}').includes(`Unknown key "wrong". Valid keys: ${valid}.`), args.join(" "));
  }
});

test("an unknown option on the command line lists the valid ones", (t) => {
  assert.match(failure(outsideRepository(t), ["version", "--jsno"]), /Unknown option --jsno\. Valid options: --json\./);
});

test("batch items name the failing item and the keys of its kind", (t) => {
  const { repository, batch } = workingStage(t);
  const before = repository.artifact.implementation();
  const good = { kind: "question", itemId: "open", question: "Which?" };

  const untyped = batch({ items: [good, { id: "v-example" }] });
  assert.match(untyped, /items\[1\]: Unknown key "id"\. Valid keys: .*item-id.*type/);
  assert.doesNotMatch(untyped, /Valid keys: .*\b(stage|finalized)\b/);

  const decision = batch({ items: [{ kind: "decision", itemId: "d", question: "Wrong kind" }] });
  assert.match(decision, /items\[0\]: Unknown key "question"\. Valid keys: .*category/);
  assert.doesNotMatch(decision.split("Valid keys:")[1], /question|mitigation|status/);

  const validation = batch({ items: [{ kind: "validation", id: "v" }] });
  assert.match(validation.split("Valid keys:")[1], /kind.*item-id.*type.*status/);

  // A wrong key is reported before its value, and a wrong kind offers validation too.
  assert.match(batch({ items: [{ kind: "risk", files: [{ path: "a" }] }] }), /items\[0\]: Unknown key "files"/);
  assert.match(batch({ items: [{ kind: "unit", itemId: "v" }] }), /items\[0\]: Unsupported record kind unit\. Use .*or validation\./);
  assert.match(batch({ items: [good, { kind: "risk", itemId: "r" }] }), /items\[1\]: Missing required option --summary/);
  assert.match(batch({ items: [good, { kind: "risk", itemId: "r", nodeRef: [{ id: "n" }] }] }), /items\[1\]: Input option node-ref arrays/);
  assert.match(batch({ items: [good, null] }), /items\[1\]: must be an object/);
  assert.deepEqual(repository.artifact.implementation(), before);
});

test("feedback batch items name the failing item and valid keys, also when partial", (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  for (const [command, name, wrong] of [["add-batch", "threads", "targetKind"], ["reply-batch", "replies", "commentId"]]) {
    const args = ["feedback", "thread", command, "--input", "-"];
    const value = { [name]: [{ id: "first", [wrong]: "value" }] };
    const expected = new RegExp(`${name}\\[0\\]: Unknown key "${wrong}"\\. Valid keys: id, comment-id`);
    assert.match(failure(repository.root, args, JSON.stringify(value)), expected);
    const partial = run(repository.root, args, JSON.stringify({ ...value, partial: true }));
    assert.equal(partial.status, 0, partial.stderr);
    assert.match(JSON.parse(partial.stdout).rejected[0].error, expected);
  }
});

test("values outside a fixed set list the allowed ones", (t) => {
  const { repository } = workingStage(t);
  const artifact = schema("schema/common.schema.json");
  const stage = (...args) => failure(repository.root, ["implementation", "stage", ...args]);
  const listed = (values) => `must be equal to one of the allowed values: ${values.join(", ")}`;
  assert.ok(stage("record", "--kind", "decision", "--item-id", "d", "--category", "bad", "--summary", "S", "--rationale", "R").includes(listed(artifact.decision.properties.category.enum)));
  const validation = stage("validation", "--item-id", "v", "--type", "bad", "--status", "bad", "--summary", "S");
  assert.ok(validation.includes(listed(artifact.validationEvidence.properties.type.enum)));
  assert.ok(validation.includes(listed(artifact.validationEvidence.properties.status.enum)));
  assert.ok(stage("evidence", "--item-id", "e", "--kind", "bad", "--summary", "S", "--inline", "Output").includes(listed(artifact.evidence.properties.kind.enum)));
  assert.match(stage("target", "--collection", "bad", "--item-id", "d", "--remove"), /--collection must be one of decisions, .*openQuestions/);
});

test("JSON given as a file or on standard input may start with a byte-order mark", (t) => {
  const { repository } = workingStage(t);
  const items = (id) => `${BOM}${JSON.stringify({ items: [{ kind: "question", itemId: id, question: "Which?" }] })}`;
  const piped = run(repository.root, ["implementation", "stage", "record-batch", "--input", "-"], items("piped"));
  assert.equal(piped.status, 0, piped.stderr);
  repository.write("input.json", items("file"));
  repository.semantic("stage", "record-batch", "--input", "input.json");
  repository.remove("input.json");
  const version = run(repository.root, ["version", "--input", "-"], `${BOM}{"json":true}`);
  assert.equal(version.status, 0, version.stderr);
  assert.ok(JSON.parse(version.stdout));

  repository.commitFile("feature.txt", "Feature\n", "Add feature");
  const organization = (change) => `${BOM}${JSON.stringify({
    $schema: ORGANIZATION_SCHEMA,
    nodes: [{ id: "feature", description: "Add the feature.", changes: [{ path: "feature.txt", ...change }] }],
    itemLinks: ["piped", "file"].map((itemId) => ({ collection: "openQuestions", itemId, nodeRefs: ["feature"] })),
  })}`;
  const file = path.join(outsideRepository(t), "organization.json");
  const organize = ["implementation", "stage", "organize", "--file", file];

  fs.writeFileSync(file, organization({ classification: "feature", kind: "added" }));
  const invalid = failure(repository.root, organize);
  assert.match(invalid, /\/nodes\/0\/changes\/0 must NOT have additional properties: unknown key "kind"\. Valid keys: path, classification, hunks, lineRanges\./);
  assert.match(invalid, /classification must be equal to one of the allowed values: behavior, .*trivial/);

  // Apart from the mark, an input file is read as strictly as before.
  fs.writeFileSync(file, `${BOM}{"nodes":[],"nodes":[]}`);
  assert.match(failure(repository.root, organize), /duplicate object key "nodes"/);

  fs.writeFileSync(file, organization({ classification: "behavior" }));
  const organized = run(repository.root, organize);
  assert.equal(organized.status, 0, organized.stderr);
});

test("stored artifact and feedback documents still reject a byte-order mark", (t) => {
  const { repository } = createImplementationWithStages(t);
  repository.feedback("init");
  const manifest = repository.feedbackPath("manifest.json");
  const text = fs.readFileSync(manifest, "utf8");
  fs.writeFileSync(manifest, `${BOM}${text}`);
  repository.expectFeedbackFailure("byte-order marks are not allowed", "validate");
  fs.writeFileSync(manifest, text);
  const stage = "stages/implementation.json";
  repository.artifact.write(stage, `${BOM}${repository.artifact.read(stage)}`);
  repository.expectSemanticFailure("byte-order marks are not allowed", "validate");
});
