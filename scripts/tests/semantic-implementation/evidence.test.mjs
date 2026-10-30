import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createViewerDataSource } from "../../../skills/semantic-flow/scripts/semantic-view.mjs";
import { beginStage, createRepository, initializeImplementation, organizeStage, semanticCli } from "../helpers/repository.mjs";

const cli = (repo, ...args) => repo.result(process.execPath, [semanticCli, ...args]);

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
const artifactFile = (repo, ...parts) => path.join(repo.root, ".semantic-review", ...parts);
const workStage = (repo, id = "implementation") => JSON.parse(fs.readFileSync(artifactFile(repo, ".work", "stages", `${id}.json`), "utf8"));
const record = (repo, ...args) => repo.semantic("stage", "evidence", "--item-id", "shot", "--kind", "screenshot", "--summary", "New button shows", ...args);

test("evidence copies attachments into the artifact, outside the stage diff", t => {
  const repo = working(t);
  const file = capture(t, "after.PNG"), sha256 = createHash("sha256").update(PNG).digest("hex");
  const head = repo.git("rev-parse", "HEAD");
  record(repo, "--after", `${file}=The new button`, "--reproduction", "Open /settings");
  const [item] = workStage(repo).evidence;
  assert.equal(item.headRevision, head);
  assert.deepEqual(item.attachments, [{ path: `evidence/${workStage(repo).id}/${sha256}.png`, mediaType: "image/png", sha256, caption: "The new button", role: "after" }]);
  assert.deepEqual(fs.readFileSync(artifactFile(repo, ...item.attachments[0].path.split("/"))), PNG);
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
  assert.deepEqual(fs.existsSync(artifactFile(repo, "evidence", workStage(repo).id)) ? fs.readdirSync(artifactFile(repo, "evidence", workStage(repo).id)) : [], []);
});

test("replacing and removing evidence removes files nothing else uses", t => {
  const repo = working(t);
  const first = capture(t, "first.png"), second = capture(t, "second.png", Buffer.concat([PNG, Buffer.from([1])]));
  record(repo, "--file", first);
  assert.throws(() => record(repo, "--file", second), /already has evidence/);
  const directory = artifactFile(repo, "evidence", workStage(repo).id);
  assert.equal(fs.readdirSync(directory).length, 1);
  record(repo, "--file", second, "--replace");
  assert.equal(fs.readdirSync(directory).length, 1);
  assert.equal(fs.readdirSync(directory)[0], workStage(repo).evidence[0].attachments[0].path.split("/").at(-1));
  repo.semantic("stage", "evidence-remove", "--item-id", "shot");
  assert.equal(fs.existsSync(directory), false);
  assert.deepEqual(workStage(repo).evidence, []);
});

test("full validation detects damaged, missing and stray evidence files", t => {
  const repo = working(t);
  record(repo, "--file", capture(t, "shot.png"));
  const id = workStage(repo).id, [{ attachments: [{ path: stored }] }] = workStage(repo).evidence;
  const file = artifactFile(repo, ...stored.split("/"));
  repo.semantic("validate");
  fs.writeFileSync(file, "tampered");
  assert.throws(() => repo.semantic("validate"), /does not match its recorded hash/);
  fs.rmSync(file);
  assert.throws(() => repo.semantic("validate"), /is missing/);
  fs.writeFileSync(file, PNG);
  fs.writeFileSync(artifactFile(repo, "evidence", id, "stray.png"), PNG);
  assert.throws(() => repo.semantic("validate"), /unreferenced evidence file/);
});

test("the schema rejects attachment paths that leave the evidence directory", t => {
  const repo = working(t);
  record(repo, "--file", capture(t, "shot.png"));
  const id = workStage(repo).id, file = artifactFile(repo, ".work", "stages", `${id}.json`), stage = workStage(repo);
  stage.evidence[0].attachments[0].path = `evidence/${id}/../../manifest.json`;
  fs.writeFileSync(file, `${JSON.stringify(stage, null, 2)}\n`);
  assert.throws(() => repo.semantic("validate"), /schema|pattern|must match/i);
});

test("finishing warns about missing and stale evidence without blocking", t => {
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
  const [{ attachments: [{ path: stored }] }] = JSON.parse(fs.readFileSync(artifactFile(repo, "stages", `${id}.json`), "utf8")).evidence;
  repo.semantic("publish");
  const metadata = repo.git("for-each-ref", "--format=%(refname)", "refs/heads/").split("\n").find(ref => ref.endsWith("/metadata"));
  assert.match(repo.git("ls-tree", "-r", "--name-only", metadata, ".semantic-review/evidence"), new RegExp(stored.split("/").at(-1)));

  const source = createViewerDataSource(repo.root);
  const script = source.implementationDataScript();
  const data = JSON.parse(script.slice(script.indexOf("{"), script.lastIndexOf("}") + 1));
  const insight = data.stages[0].insights.find(item => item.collection === "evidence");
  assert.equal(insight.evidence.stale, false);
  assert.equal(insight.evidence.attachments[0].mediaType, "image/png");
  const served = source.evidenceFile(id, "shot", "0");
  assert.deepEqual(Buffer.from(served.content, "base64"), PNG);
  assert.equal(served.mediaType, "image/png");
  assert.throws(() => source.evidenceFile(id, "shot", "1"), /does not exist/);
  fs.writeFileSync(artifactFile(repo, ...stored.split("/")), "tampered");
  assert.throws(() => source.evidenceFile(id, "shot", "0"), /damaged/);
});
