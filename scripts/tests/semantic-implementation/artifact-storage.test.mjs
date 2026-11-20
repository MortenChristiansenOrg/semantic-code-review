import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ArtifactDraft, commitArtifact, readArtifact } from "../../src/shared/artifact-store.ts";
import { beginStage, createRepository, initializeImplementation } from "../helpers/repository.mjs";

test("a writer that read the artifact before another write fails without overwriting it", (t) => {
  const repo = createRepository(t);
  initializeImplementation(repo);
  beginStage(repo);
  const file = path.join(repo.root, ".semantic-review", ".work", "stages", "implementation.json");

  const stale = readArtifact(repo.root);
  const draft = new ArtifactDraft(stale);
  draft.write(".work/stages/implementation.json", stale.read(".work/stages/implementation.json"));
  repo.semantic("stage", "set", "--id", "implementation", "--summary", "Written first.");
  assert.throws(() => commitArtifact(repo.root, stale, draft), /changed while this command ran; retry it/);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).summary, "Written first.");
});
