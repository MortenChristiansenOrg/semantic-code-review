import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { execFile, spawnSync } from 'node:child_process';
import http from 'node:http';
import { promisify } from 'node:util';
import { createRepository, feedbackCli, flowCli, initializeImplementation } from '../helpers/repository.mjs';
import { startRemoteReview, refreshRemoteReview, createImplementationDataScript, captureReviewContext, captureApprovalSnapshot, compareApprovalSnapshot,
  patchReviewState, readReview, reviewDirectory, registeredReviews, inspectReviewStorage, deleteReviewData, exportFeedback } from '../../../skills/semantic-flow/scripts/semantic-view.mjs';

function setup(t) {
  const author = createRepository(t, 'remote-author-'), source = createRepository(t, 'remote-reviewer-');
  source.git('remote', 'add', 'origin', author.root);
  author.git('switch', '-c', 'feature');
  const head = author.commitFile('code.txt', 'original\n', 'Add code');
  author.git('switch', 'main'); // The remote default remains main.
  source.write('personal.txt', 'untouched\n');
  return { author, source, head };
}
const dataFor = (record) => JSON.parse(createImplementationDataScript(record.repositoryRoot).replace(/^window.SEMANTIC_IMPLEMENTATION = /, '').replace(/;\s*$/, ''));
const change = (path, value) => ({ path, before: { present: false }, after: { present: true, value } });
function endpoint(data) {
  const s = data.stages[0], file = s.files.find((f) => f.path === 'code.txt');
  return { stageId: s.id, nodeId: file.memberships[0].nodeId, path: file.path, baseRevision: s.baseRevision, headRevision: s.headRevision, fileRevision: file.revision, ownership: file.memberships[0] };
}

test('remote review owns its checkout, groups commits, reopens, and deletes all owned data', (t) => {
  const { author, source, head } = setup(t);
  const original = source.git('status', '--porcelain'), branch = source.git('branch', '--show-current');
  const review = startRemoteReview(source.root, 'origin/feature');
  assert.equal(review.repositoryRoot, fs.realpathSync(path.join(reviewDirectory(review.id), 'checkout')));
  assert.equal(fs.readFileSync(path.join(review.repositoryRoot, 'code.txt'), 'utf8'), 'original\n');
  assert.equal(captureReviewContext(review.id).repositoryRoot, review.repositoryRoot);
  const data = dataFor(review);
  assert.equal(data.remote.branch, 'feature'); assert.equal(data.stages.length, 2);
  assert.equal(data.stages[0].id, 'branch'); assert.equal(data.stages[1].id, `commit-${head}`);
  assert.deepEqual(data.stages[0].files.map((f) => f.path), ['code.txt']);
  assert.equal(startRemoteReview(source.root, 'feature').id, review.id);
  assert.ok(registeredReviews().find((r) => r.id === review.id).remote);
  assert.equal(source.git('status', '--porcelain'), original); assert.equal(source.git('branch', '--show-current'), branch);
  assert.equal(author.git('branch', '--show-current'), 'main');
  const storage = inspectReviewStorage(review.id, review.generation);
  assert.ok(storage.bytes > 0);
  assert.equal(deleteReviewData(review.id, review.generation, storage.fingerprint).deleted, true);
  assert.equal(fs.existsSync(reviewDirectory(review.id)), false); assert.ok(fs.existsSync(source.root)); assert.ok(fs.existsSync(author.root));
  assert.throws(() => refreshRemoteReview(review.id, review.generation), /unavailable|deleted/);
  const reopened = startRemoteReview(source.root, 'feature'); assert.equal(reopened.id, review.id); assert.notEqual(reopened.generation, review.generation);
});

test('refresh preserves notes and approved snapshots through appends, force-pushes, and failures', (t) => {
  const { author, source } = setup(t), review = startRemoteReview(source.root, 'feature');
  const context = captureReviewContext(review.id), initial = dataFor(review), saved = captureApprovalSnapshot(context, endpoint(initial));
  patchReviewState(review.id, review.generation, [change(['comments'], [{ mode: 'personal', body: 'Private note' }]), change(['approvals', 'file'], saved)]);
  author.git('switch', 'feature'); author.commitFile('code.txt', 'updated\n', 'Update code'); author.git('switch', 'main');
  assert.equal(startRemoteReview(source.root, 'feature').remote.headRevision, review.remote.headRevision);
  refreshRemoteReview(review.id, review.generation);
  const next = dataFor(review);
  assert.notEqual(next.stages[0].files[0].revision, initial.stages[0].files[0].revision);
  assert.equal(next.stages.length, 3);
  assert.equal(readReview(review.id).state.comments[0].body, 'Private note');
  const diff = compareApprovalSnapshot(context, saved.snapshotId, endpoint(next));
  assert.deepEqual(diff.lines.filter((l) => l.t !== 'ctx').map((l) => l.s), ['original', 'updated']);
  author.git('switch', 'feature'); author.git('reset', '--hard', 'main'); author.commitFile('code.txt', 'rewritten\n', 'Rewritten history'); author.git('switch', 'main');
  refreshRemoteReview(review.id, review.generation);
  assert.equal(dataFor(review).stages[0].id, 'branch');
  assert.deepEqual(compareApprovalSnapshot(context, saved.snapshotId, endpoint(dataFor(review))).lines.filter((l) => l.t !== 'ctx').map((l) => l.s), ['original', 'rewritten']);
  author.git('branch', '-D', 'feature');
  assert.throws(() => refreshRemoteReview(review.id, review.generation));
  assert.equal(fs.readFileSync(path.join(review.repositoryRoot, 'code.txt'), 'utf8'), 'rewritten\n');
  assert.equal(dataFor(review).stages[0].headRevision, readReview(review.id).remote.headRevision);
});

test('remote feedback is rejected in store, export, and CLI while personal notes save', (t) => {
  const { source } = setup(t), review = startRemoteReview(source.root, 'feature'), context = captureReviewContext(review.id);
  assert.throws(() => patchReviewState(review.id, review.generation, [change(['comments'], [{ mode: 'feedback', body: 'Send' }])]), /personal notes only/);
  assert.throws(() => patchReviewState(review.id, review.generation, [change(['editor'], { compose: { mode: 'feedback', body: 'Draft' } })]), /personal notes only/);
  assert.throws(() => exportFeedback({ repoRoot: review.repositoryRoot, implementation: dataFor(review), feedbackCli, context }, []), /personal notes only/);
  const result = spawnSync(process.execPath, [feedbackCli, 'init'], { cwd: review.repositoryRoot, encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /personal notes only/);
  assert.equal(fs.existsSync(path.join(reviewDirectory(review.id), 'feedback', 'manifest.json')), false);
  patchReviewState(review.id, review.generation, [change(['comments'], [{ mode: 'personal', body: 'Keep' }])]);
  assert.equal(readReview(review.id).state.comments[0].body, 'Keep');
});

test('published metadata supplies semantic stages, nodes, requirements and insights', (t) => {
  const { author, source, head } = setup(t);
  initializeImplementation(author);
  const manifest = author.readJson('.semantic-review/manifest.json');
  const semanticStage = { $schema: 'https://semantic-code-review.dev/schemas/v0.1/stage.schema.json', id: 'semantic-stage', title: 'Semantic title', summary: 'Semantic summary', rationale: 'Why', dependsOn: [], specificationRefs: ['story#works'], assumptions: [], alternatives: [], failedAttempts: [], risks: [], validation: [], openQuestions: [],
    change: { baseRevision: author.git('rev-parse', 'main'), headRevision: head, branch: 'feature', baseBranch: 'main', files: [{ path: 'code.txt', kind: 'added' }] },
    nodes: [{ id: 'semantic-node', description: 'Authored node', changes: [{ path: 'code.txt', classification: 'behavior' }] }],
    decisions: [{ id: 'why', category: 'engineering', rationale: 'Why', summary: 'Preserved reasoning', nodeRefs: ['semantic-node'] }] };
  author.write('.semantic-review/stages/semantic-stage.json', JSON.stringify(semanticStage));
  author.write('.semantic-review/manifest.json', JSON.stringify({ ...manifest, stages: ['semantic-stage'] }));
  author.git('switch', '-c', 'semantic-flow/example/metadata'); author.git('add', '-f', '.semantic-review'); author.git('commit', '-m', 'Publish artifact'); author.git('switch', 'main');
  const review = startRemoteReview(source.root, 'feature'), data = dataFor(review);
  assert.equal(data.stages[0].id, 'branch'); assert.equal(data.stages[1].title, 'Semantic title'); assert.equal(data.stages[1].nodes[0].id, 'semantic-node');
  assert.equal(data.stages[1].insights[0].title, 'Preserved reasoning'); assert.ok(data.requirements.length);
});

test('review --branch launches a remote viewer and enforces HTTP read-only mode', async (t) => {
  const { source } = setup(t);
  const result = spawnSync(process.execPath, [flowCli, 'review', '--branch', 'feature', '--project', source.root], {
    cwd: source.root, encoding: 'utf8', env: { ...process.env, SEMANTIC_VIEW_NO_OPEN: '1' }, timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(result.stdout)?.[0]; assert.ok(url, result.stdout);
  const identity = await (await fetch(url + 'api/whoami')).json();
  t.after(async () => {
    await fetch(url + 'api/shutdown', { method: 'POST', headers: { "content-type": "application/json" }, body: '{}' }).catch(() => {});
    for (let attempt = 0; attempt < 100; attempt++) {
      try { process.kill(identity.processId, 0); }
      catch (error) { if (error.code === 'ESRCH') return; throw error; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail('The remote review viewer did not exit.');
  });
  const query = `?review=${identity.reviewId}&generation=${identity.generation}`;
  const feedback = await fetch(url + 'api/feedback/export' + query, { method: 'POST', headers: { origin: new URL(url).origin, "content-type": "application/json" }, body: '{}' });
  assert.equal(feedback.status, 403);
  const refreshed = await fetch(url + 'api/remote/refresh' + query, { method: 'POST', headers: { origin: new URL(url).origin, "content-type": "application/json" } });
  assert.equal(refreshed.status, 200, await refreshed.text());
  const list = await (await fetch(url + 'api/reviews' + query)).json();
  assert.ok(list.reviews.find((r) => r.id === identity.reviewId).remote);
});


test('branch selection isolates remotes and invalid branches leave no saved review', (t) => {
  const { source } = setup(t), other = createRepository(t, 'other-remote-');
  other.git('switch', '-c', 'feature'); other.commitFile('other.txt', 'other remote\n', 'Other branch'); other.git('switch', 'main');
  source.git('remote', 'add', 'upstream', other.root);
  const a = startRemoteReview(source.root, 'feature'), b = startRemoteReview(source.root, 'upstream/feature');
  assert.notEqual(a.id, b.id); assert.equal(b.remote.remoteName, 'upstream');
  assert.equal(dataFor(b).stages[0].files[0].path, 'other.txt');
  const count = registeredReviews().length;
  assert.throws(() => startRemoteReview(source.root, 'missing'));
  assert.throws(() => startRemoteReview(source.root, '--upload-pack=bad'), /Invalid remote branch/);
  assert.equal(registeredReviews().length, count);
});

test('malformed and stale metadata fall back to complete Git history', (t) => {
  const { source, author } = setup(t);
  author.git('switch', 'feature');
  author.write('.semantic-review/manifest.json', JSON.stringify({ stages: ['../escape'], requirements: [] }));
  author.git('add', '-f', '.semantic-review'); author.git('commit', '-m', 'Unusable metadata'); author.git('switch', 'main');
  const review = startRemoteReview(source.root, 'feature'), data = dataFor(review);
  assert.equal(data.stages[0].id, 'branch'); assert.equal(data.stages.length, 3);
  assert.deepEqual(data.stages[0].files.map(f => f.path), ['code.txt']);
  assert.equal(fs.existsSync(path.join(reviewDirectory(review.id), 'escape.json')), false);
});

test('first-parent merge stages show their changes and unchanged approvals retain file revisions', (t) => {
  const { source, author } = setup(t), review = startRemoteReview(source.root, 'feature'), before = dataFor(review);
  author.git('switch', 'feature'); author.git('switch', '-c', 'side'); author.commitFile('side.txt', 'side\n', 'Side change');
  author.git('switch', 'feature'); author.commitFile('second.txt', 'second\n', 'Second change');
  author.git('merge', '--no-ff', 'side', '-m', 'Merge side'); author.git('switch', 'main');
  refreshRemoteReview(review.id, review.generation);
  const after = dataFor(review);
  assert.equal(after.stages.length, 4); assert.equal(after.stages.at(-1).title, 'Merge side');
  assert.deepEqual(after.stages.at(-1).files.map(f => f.path), ['side.txt']);
  assert.equal(after.stages[0].files.find(f => f.path === 'code.txt').revision, before.stages[0].files[0].revision);
});


test('remote authentication failures do not invoke interactive askpass helpers', async (t) => {
  const source = createRepository(t, 'remote-auth-');
  const server = http.createServer((_request, response) => {
    response.writeHead(401, { 'www-authenticate': 'Basic realm="test"' }); response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  source.git('remote', 'add', 'origin', `http://127.0.0.1:${server.address().port}/private.git`);
  const marker = source.path('askpass-ran');
  source.write('askpass.cjs', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called'); process.stdout.write('fixture-user\\n');`);
  source.write('empty-git-config', '');
  const askpass = source.path(process.platform === 'win32' ? 'askpass.cmd' : 'askpass');
  fs.writeFileSync(askpass, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${source.path('askpass.cjs')}"\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${source.path('askpass.cjs')}"\n`, { mode: 0o755 });
  await assert.rejects(promisify(execFile)(process.execPath, [flowCli, 'review', '--branch', 'feature'], {
    cwd: source.root, timeout: 15_000,
    env: { ...process.env, GIT_ASKPASS: askpass, SSH_ASKPASS: askpass, GIT_CONFIG_GLOBAL: source.path('empty-git-config'), GIT_CONFIG_NOSYSTEM: '1', SEMANTIC_VIEW_NO_OPEN: '1' },
  }), error => { assert.match(error.stderr, /Authentication failed|could not read Username/); return true; });
  assert.equal(fs.existsSync(marker), false, 'Remote Git operations must not launch inherited password prompts');
});


test('remote clones support nested paths under the private review directory', (t) => {
  const { source, author } = setup(t);
  const file = `nested-${'a'.repeat(45)}/nested-${'b'.repeat(45)}/file.txt`;
  author.git('switch', 'feature'); author.commitFile(file, 'nested content\n', 'Nested file'); author.git('switch', 'main');
  const review = startRemoteReview(source.root, 'feature');
  assert.equal(fs.readFileSync(path.join(review.repositoryRoot, file), 'utf8'), 'nested content\n');
  assert.ok(dataFor(review).stages[0].files.some(f => f.path === file));
  author.git('switch', 'feature'); author.commitFile(file, 'refreshed content\n', 'Nested update'); author.git('switch', 'main');
  refreshRemoteReview(review.id, review.generation);
  assert.equal(fs.readFileSync(path.join(review.repositoryRoot, file), 'utf8'), 'refreshed content\n');
  const storage = inspectReviewStorage(review.id, review.generation);
  assert.equal(deleteReviewData(review.id, review.generation, storage.fingerprint).cleanupPending, false);
});
