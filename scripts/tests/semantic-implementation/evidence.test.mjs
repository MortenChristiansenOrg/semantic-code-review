import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildFeedbackTargetData, createViewerDataSource, evidenceRange, exportFeedback, readFeedbackThread } from "../../src/semantic-view.ts";
import { beginStage, createRepository, implementationFromScript, initializeImplementation, organizeStage, semanticCli } from "../helpers/repository.mjs";

const cli = (repo, ...args) => repo.result(process.execPath, [...semanticCli, ...args]);

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
function capture(t, name, bytes = PNG) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-evidence-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, name);
  fs.writeFileSync(file, bytes);
  return file;
}
function working(t) {
  const repo = createRepository(t);
  initializeImplementation(repo); beginStage(repo);
  repo.commitFile("src/feature.js", "export const feature = 1;\n", "Add feature");
  return repo;
}
const workStage = (repo, id = "implementation") => repo.artifact.readJson(`.work/stages/${id}.json`);
/** The names of the files directly in an evidence directory of the artifact. */
const evidenceFiles = (repo, id) => repo.artifact.list(`evidence/${id}`).map((file) => file.split("/").at(-1));
const record = (repo, ...args) => repo.semantic("stage", "evidence", "--item-id", "shot", "--kind", "screenshot", "--summary", "New button shows", ...args);

test("evidence copies attachments into the artifact, outside the stage diff", t => {
  const repo = working(t);
  const file = capture(t, "after.PNG"), sha256 = createHash("sha256").update(PNG).digest("hex");
  record(repo, "--after", `${file}=The new button`, "--reproduction", "Open /settings");
  const [item] = workStage(repo).evidence;
  assert.equal("headRevision" in item, false);
  assert.deepEqual(item.attachments, [{ path: `evidence/${workStage(repo).id}/${sha256}.png`, mediaType: "image/png", sha256, caption: "The new button", role: "after" }]);
  assert.deepEqual(repo.artifact.readBytes(item.attachments[0].path), PNG);
  assert.equal(repo.git("status", "--porcelain"), "");
  assert.ok(Date.parse(item.capturedAt));
});

test("evidence is refused unless it can be tied to the committed stage head", t => {
  const repo = working(t);
  const file = capture(t, "shot.png");
  assert.throws(() => record(repo), /--file, --before, --after or --inline/);
  assert.throws(() => record(repo, "--file", capture(t, "shot.svg", Buffer.from("<svg/>"))), /Unsupported evidence file/);
  assert.throws(() => record(repo, "--file", path.join(path.dirname(file), "missing.png")), /does not exist/);
  assert.throws(() => record(repo, "--file", capture(t, "big.png", Buffer.alloc(25 * 1024 * 1024 + 1))), /larger than 25 MiB/);
  assert.throws(() => record(repo, "--file", file, "--specification-ref", "story#other"), /does not address|unresolved/);
  repo.write("dirty.txt", "x");
  assert.throws(() => record(repo, "--file", file), /clean worktree/);
  fs.rmSync(path.join(repo.root, "dirty.txt"));
  assert.deepEqual(workStage(repo).evidence, []);
  assert.deepEqual(evidenceFiles(repo, workStage(repo).id), []);
});

test("replacing and removing evidence removes files nothing else uses", t => {
  const repo = working(t);
  const first = capture(t, "first.png"), second = capture(t, "second.png", Buffer.concat([PNG, Buffer.from([1])]));
  record(repo, "--file", first);
  assert.throws(() => record(repo, "--file", second), /already has evidence/);
  const id = workStage(repo).id;
  assert.equal(evidenceFiles(repo, id).length, 1);
  record(repo, "--file", second, "--replace");
  assert.deepEqual(evidenceFiles(repo, id), [workStage(repo).evidence[0].attachments[0].path.split("/").at(-1)]);
  repo.semantic("stage", "evidence-remove", "--item-id", "shot");
  assert.equal(repo.artifact.exists(`evidence/${id}`), false);
  assert.deepEqual(workStage(repo).evidence, []);
});

test("full validation detects damaged, missing and stray evidence files", t => {
  const repo = working(t);
  record(repo, "--file", capture(t, "shot.png"));
  const id = workStage(repo).id, [{ attachments: [{ path: stored }] }] = workStage(repo).evidence;
  repo.semantic("validate");
  repo.artifact.write(stored, "tampered");
  assert.throws(() => repo.semantic("validate"), /does not match its recorded hash/);
  repo.artifact.remove(stored);
  assert.throws(() => repo.semantic("validate"), /is missing/);
  // A lost capture must not block the edits that repair it, or unrelated ones.
  repo.semantic("stage", "record", "--kind", "risk", "--item-id", "unrelated", "--summary", "Still recordable");
  repo.artifact.write(stored, PNG);
  repo.artifact.write(`evidence/${id}/stray.png`, PNG);
  assert.throws(() => repo.semantic("validate"), /Unreferenced evidence file/);
  repo.artifact.remove(`evidence/${id}/stray.png`);
  repo.semantic("validate");

  // Anything under evidence/ gets published, not only what sits beside a known stage.
  repo.artifact.write("evidence/abandoned/old.png", PNG);
  assert.throws(() => repo.semantic("validate"), /Unreferenced evidence file evidence\/abandoned\/old\.png/);
  repo.artifact.remove("evidence/abandoned");
  repo.artifact.write("evidence/loose.png", PNG);
  assert.throws(() => repo.semantic("validate"), /Unreferenced evidence file evidence\/loose\.png/);
});

test("a capture damaged by a crash is rewritten, and a lost one can be removed", t => {
  const repo = working(t);
  const source = capture(t, "shot.png");
  record(repo, "--file", source);
  const [{ attachments: [{ path: stored }] }] = workStage(repo).evidence;
  repo.artifact.write(stored, "truncated");
  record(repo, "--file", source, "--replace");
  assert.deepEqual(repo.artifact.readBytes(stored), PNG);
  repo.semantic("validate");
  repo.artifact.remove(stored);
  repo.semantic("stage", "evidence-remove", "--item-id", "shot");
  repo.semantic("validate");
});

test("published captures keep their bytes under Git filters and line-ending conversion", t => {
  const repo = working(t);
  repo.git("config", "core.autocrlf", "true");
  repo.commitFile(".gitattributes", "*.txt text\n", "Normalize text");
  const id = workStage(repo).id, bytes = Buffer.from("line one\r\nline two\r\n");
  record(repo, "--file", capture(t, "output.txt", bytes));
  const [{ attachments: [{ path: stored }] }] = workStage(repo).evidence;
  organizeStage(repo, { id });
  repo.semantic("stage", "finish", "--id", id);
  repo.semantic("publish");
  const metadata = repo.git("for-each-ref", "--format=%(refname)", "refs/heads/").split("\n").find(ref => ref.endsWith("/metadata"));
  const published = spawnSync("git", ["show", `${metadata}:.semantic-review/${stored}`], { cwd: repo.root });
  assert.deepEqual(published.stdout, bytes);
});

test("removing evidence keeps feedback on it valid", t => {
  const repo = working(t);
  const id = workStage(repo).id;
  record(repo, "--file", capture(t, "shot.png"));
  organizeStage(repo, { id });
  repo.semantic("stage", "finish", "--id", id);
  const sent = exportFeedback({ repoRoot: repo.root, implementation: buildFeedbackTargetData(repo.root) },
    [{ kind: "insight", id: `i:${id}:evidence:shot`, body: "Contains a secret", mode: "feedback", clientId: "secret" }]);
  assert.deepEqual(sent.skipped, []);
  repo.semantic("stage", "evidence-remove", "--stage", id, "--finalized", "--item-id", "shot");
  repo.feedback("validate");
});

test("range requests select the bytes a video player asks for", () => {
  assert.deepEqual(evidenceRange("bytes=0-9", 100), { start: 0, end: 9 });
  assert.deepEqual(evidenceRange("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(evidenceRange("bytes=-4", 100), { start: 96, end: 99 });
  assert.deepEqual(evidenceRange("bytes=90-500", 100), { start: 90, end: 99 });
  assert.equal(evidenceRange("bytes=100-", 100), "unsatisfiable");
  assert.equal(evidenceRange("bytes=0-", 0), "unsatisfiable");
  for (const header of [undefined, "bytes=-", "bytes=0-1,3-4", "items=0-1"]) assert.equal(evidenceRange(header, 100), null);
});

test("the schema rejects attachment paths that leave the evidence directory", t => {
  const repo = working(t);
  record(repo, "--file", capture(t, "shot.png"));
  const id = workStage(repo).id, file = `.work/stages/${id}.json`, stage = workStage(repo);
  stage.evidence[0].attachments[0].path = `evidence/${id}/../../manifest.json`;
  repo.artifact.write(file, stage);
  assert.throws(() => repo.semantic("validate"), /schema|pattern|must match/i);
});

test("finishing warns about missing evidence without blocking", t => {
  const repo = working(t);
  const id = workStage(repo).id;
  organizeStage(repo, { id });
  const warned = cli(repo, "stage", "finish", "--id", id);
  assert.equal(warned.status, 0);
  assert.match(warned.stderr, /changes behavior but has no evidence/);

  repo.semantic("stage", "no-evidence", "--stage", id, "--finalized", "--reason", "Only reachable from tests");
  assert.doesNotMatch(cli(repo, "validate").stderr, /no evidence/);
  repo.semantic("stage", "no-evidence", "--stage", id, "--finalized", "--remove");
  assert.match(cli(repo, "validate").stderr, /no evidence/);

  record(repo, "--stage", id, "--finalized", "--inline", "$ tool\nok", "--node-ref", "implementation-change");
  assert.doesNotMatch(cli(repo, "validate").stderr, /no evidence/);
});

test("publication and the viewer carry the evidence", t => {
  const repo = working(t);
  const id = workStage(repo).id;
  record(repo, "--file", capture(t, "shot.png"));
  organizeStage(repo, { id });
  repo.semantic("stage", "finish", "--id", id);
  const [{ attachments: [{ path: stored }] }] = repo.artifact.readJson(`stages/${id}.json`).evidence;
  repo.semantic("publish");
  const metadata = repo.git("for-each-ref", "--format=%(refname)", "refs/heads/").split("\n").find(ref => ref.endsWith("/metadata"));
  assert.match(repo.git("ls-tree", "-r", "--name-only", metadata, ".semantic-review/evidence"), new RegExp(stored.split("/").at(-1)));

  const source = createViewerDataSource(repo.root);
  const script = source.implementationDataScript();
  const data = implementationFromScript(script);
  const insight = data.stages[0].insights.find(item => item.collection === "evidence");
  assert.equal("stale" in insight.evidence, false);
  assert.equal(insight.evidence.attachments[0].mediaType, "image/png");
  const sent = exportFeedback({ repoRoot: repo.root, implementation: buildFeedbackTargetData(repo.root) },
    [{ kind: "insight", id: `i:${id}:evidence:shot`, body: "This shows the wrong page", mode: "feedback", clientId: "evidence-note" }]);
  assert.deepEqual(sent.skipped, []);
  assert.equal(readFeedbackThread(repo.root, sent.exported[0].threadId).target.collection, "evidence");
  const served = source.evidenceFile(id, "shot", "0");
  assert.deepEqual(Buffer.from(served.content, "base64"), PNG);
  assert.equal(served.mediaType, "image/png");
  assert.throws(() => source.evidenceFile(id, "shot", "1"), /does not exist/);
  repo.artifact.write(stored, "tampered");
  assert.throws(() => source.evidenceFile(id, "shot", "0"), /damaged/);
});
