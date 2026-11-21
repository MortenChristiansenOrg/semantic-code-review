import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { promisify } from 'node:util';
import { remoteIdentity } from '../../src/shared/remote-review.ts';
import { replaceArtifactDirectory } from '../../src/shared/artifact-store.ts';
import { createRepository, feedbackCli, flowCli, implementationFromScript, initializeImplementation } from '../helpers/repository.mjs';
import { viewerFetch } from '../helpers/viewer-client.mjs';
import { createViewerDataSource, startRemoteReview, refreshRemoteReview, createImplementationDataScript, captureReviewContext, captureApprovalSnapshot, compareApprovalSnapshot,
  patchReviewState, readReview, reviewDirectory, reviewId, registeredReviews, inspectReviewStorage, deleteReviewData, exportFeedback } from '../../src/semantic-view.ts';

function setup(t) {
  const author = createRepository(t, 'remote-author-'), source = createRepository(t, 'remote-reviewer-');
  source.git('remote', 'add', 'origin', author.root);
  author.git('switch', '-c', 'feature');
  const head = author.commitFile('code.txt', 'original\n', 'Add code');
  author.git('switch', 'main'); // The remote default remains main.
  source.write('personal.txt', 'untouched\n');
  return { author, source, head };
}
/** Publishes a full-form artifact with the author's requirements and the given
 * stage documents on a metadata branch, as publication stores it, without
 * touching the author's worktree. */
function publishMetadata(author, stages, extraFiles = {}) {
  const { manifest, requirements } = author.artifact.implementation();
  const files = {
    'manifest.json': JSON.stringify({ ...manifest, stages: stages.map((stage) => stage.id) }),
    ...Object.fromEntries(Object.entries(requirements).map(([id, document]) => [`requirements/${id}.json`, JSON.stringify(document)])),
    ...Object.fromEntries(stages.map((stage) => [`stages/${stage.id}.json`, JSON.stringify(stage)])),
    ...extraFiles,
  };
  const env = { ...process.env, GIT_INDEX_FILE: path.join(author.root, '.git', 'metadata-index') };
  const git = (args, input) => execFileSync('git', args, { cwd: author.root, env, input, encoding: 'utf8' }).trim();
  for (const [file, contents] of Object.entries(files)) {
    const blob = git(['hash-object', '-w', '--stdin'], contents);
    git(['update-index', '--add', '--cacheinfo', `100644,${blob},.semantic-review/${file}`]);
  }
  const commit = git(['commit-tree', git(['write-tree']), '-p', 'main', '-m', 'Publish artifact']);
  author.git('branch', 'semantic-flow/example/metadata', commit);
}
const dataFor = (record) => implementationFromScript(createImplementationDataScript(record.repositoryRoot));
const change = (path, value) => ({ path, before: { present: false }, after: { present: true, value } });
function endpoint(data) {
  const s = data.stages.findLast((stage) => stage.files.some((file) => file.path === 'code.txt')), file = s.files.find((f) => f.path === 'code.txt');
  return { stageId: s.id, nodeId: file.memberships[0].nodeId, path: file.path, baseRevision: file.baseRevision, headRevision: s.headRevision, fileRevision: file.revision, ownership: file.memberships[0] };
}

test('remote review owns its checkout, groups commits, reopens, and deletes all owned data', (t) => {
  const { author, source, head } = setup(t);
  const original = source.git('status', '--porcelain'), branch = source.git('branch', '--show-current');
  const review = startRemoteReview(source.root, 'origin/feature');
  assert.equal(review.repositoryRoot, fs.realpathSync(path.join(reviewDirectory(review.id), 'checkout')));
  assert.equal(fs.readFileSync(path.join(review.repositoryRoot, 'code.txt'), 'utf8'), 'original\n');
  assert.equal(captureReviewContext(review.id).repositoryRoot, review.repositoryRoot);
  assert.equal(reviewId(fs.realpathSync.native(review.repositoryRoot), review.implementationId), review.id);
  const data = dataFor(review);
  assert.equal(data.remote.branch, 'feature'); assert.equal(data.stages.length, 1);
  assert.equal(data.stages[0].id, `commit-${head}`);
  assert.deepEqual(data.stages[0].files.map((f) => f.path), ['code.txt']);
  assert.equal(startRemoteReview(source.root, 'feature').id, review.id);
  // A review saved by an earlier version kept its projection inside the checkout; reading it moves it out whole.
  const projection = path.join(reviewDirectory(review.id), 'artifact');
  fs.renameSync(projection, path.join(review.repositoryRoot, '.semantic-review'));
  assert.equal(startRemoteReview(source.root, 'feature').id, review.id);
  assert.equal(dataFor(review).stages[0].id, `commit-${head}`);
  assert.ok(fs.existsSync(path.join(projection, 'manifest.json')));
  assert.equal(fs.existsSync(path.join(review.repositoryRoot, '.semantic-review')), false);
  assert.ok(registeredReviews().find((r) => r.id === review.id).remote);
  assert.equal(source.git('status', '--porcelain'), original); assert.equal(source.git('branch', '--show-current'), branch);
  assert.equal(author.git('branch', '--show-current'), 'main');
  const storage = inspectReviewStorage(review.id, review.generation);
  assert.ok(storage.bytes > 0);
  assert.equal(deleteReviewData(review.id, review.generation, storage.fingerprint).deleted, true);
  assert.equal(fs.existsSync(reviewDirectory(review.id)), false); assert.ok(fs.existsSync(source.root)); assert.ok(fs.existsSync(author.root));
  assert.throws(() => refreshRemoteReview(review.id, review.generation), /unavailable|deleted/);
  // A deleted review is started again with a fresh identity.
  const reopened = startRemoteReview(source.root, 'feature'); assert.notEqual(reopened.id, review.id);
  assert.equal(startRemoteReview(source.root, 'feature').id, reopened.id);
});

test('a remote review keeps its identity when opened from another checkout of the repository', (t) => {
  const { author, source } = setup(t);
  const review = startRemoteReview(source.root, 'origin/feature');
  // The remote URL may hold credentials, so the review stores only a hash of it.
  assert.equal(review.remote.url, undefined);
  assert.ok(!JSON.stringify(readReview(review.id)).includes(author.root));
  const linked = source.root + '-linked';
  source.git('worktree', 'add', '-q', '--detach', linked);
  t.after(() => fs.rmSync(linked, { recursive: true, force: true }));
  const clone = createRepository(t, 'remote-reviewer-clone-');
  clone.git('remote', 'add', 'origin', author.root);
  patchReviewState(review.id, review.generation, [{ path: ['notes'], before: { present: false }, after: { present: true, value: 'Kept' } }]);
  assert.equal(startRemoteReview(linked, 'feature').id, review.id);
  const reopened = startRemoteReview(clone.root, 'feature');
  assert.equal(reopened.id, review.id);
  assert.equal(reopened.generation, review.generation);
  assert.equal(reopened.state.notes, 'Kept');
  // Another branch of the same remote is another review.
  author.git('branch', 'other', 'feature');
  const other = startRemoteReview(clone.root, 'other');
  assert.notEqual(other.id, review.id);
  // No checkout started a second review of either branch.
  const keys = [review.implementationId, other.implementationId];
  assert.equal(registeredReviews().filter((entry) => entry.remote && keys.includes(entry.implementationId)).length, 2);
});

test('credentials in a remote URL neither name nor identify its review', () => {
  const plain = remoteIdentity('https://example.com/team/project.git', 'feature');
  const first = remoteIdentity('https://user:secret@example.com/team/project.git', 'feature');
  const rotated = remoteIdentity('https://user:changed@example.com/team/project.git', 'feature');
  assert.equal(first.key, plain.key);
  assert.equal(rotated.key, plain.key);
  assert.equal(first.label, 'project');
  // A review an earlier version keyed by the URL as configured is still found.
  const legacy = 'remote-' + createHash('sha256').update(JSON.stringify(['https://user:secret@example.com/team/project.git', 'feature'])).digest('hex').slice(0, 24);
  assert.deepEqual(first.keys, [plain.key, legacy]);
  const root = remoteIdentity('https://user:secret@example.com', 'feature');
  assert.ok(!root.label.includes('secret'), root.label);
  assert.equal(root.label, 'example.com');
  assert.deepEqual(plain.keys, [plain.key]);
});

test('refresh preserves notes and approved snapshots through appends, force-pushes, and failures', (t) => {
  const { author, source } = setup(t), review = startRemoteReview(source.root, 'feature');
  const context = captureReviewContext(review.id), initial = dataFor(review), saved = captureApprovalSnapshot(context, endpoint(initial));
  patchReviewState(review.id, review.generation, [change(['comments'], [{ mode: 'personal', body: 'Private note' }]), change(['approvals', `m:${JSON.stringify([endpoint(initial).stageId, 'changes', 'code.txt'])}`], { ...saved, ...endpoint(initial), at: 1, rev: 'initial' })]);
  author.git('switch', 'feature'); author.commitFile('code.txt', 'updated\n', 'Update code'); author.git('switch', 'main');
  assert.equal(startRemoteReview(source.root, 'feature').remote.headRevision, review.remote.headRevision);
  refreshRemoteReview(review.id, review.generation);
  const next = dataFor(review);
  assert.equal(next.stages[0].files[0].revision, initial.stages[0].files[0].revision);
  assert.notEqual(next.stages[1].files[0].revision, initial.stages[0].files[0].revision);
  assert.equal(next.stages.length, 2);
  assert.equal(readReview(review.id).state.comments[0].body, 'Private note');
  const unreferenced = captureApprovalSnapshot(context, endpoint(initial));
  assert.throws(() => compareApprovalSnapshot(context, unreferenced.snapshotId, endpoint(next)), /another file review/);
  const diff = compareApprovalSnapshot(context, saved.snapshotId, endpoint(next));
  assert.deepEqual(diff.lines.filter((l) => l.t !== 'ctx').map((l) => l.s), ['original', 'updated']);
  author.git('switch', 'feature'); author.git('reset', '--hard', 'main'); author.commitFile('code.txt', 'rewritten\n', 'Rewritten history'); author.git('switch', 'main');
  refreshRemoteReview(review.id, review.generation);
  assert.equal(dataFor(review).stages.length, 1);
  assert.notEqual(dataFor(review).stages[0].id, initial.stages[0].id);
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
  assert.throws(() => exportFeedback({ repoRoot: review.repositoryRoot, implementation: dataFor(review), context }, []), /personal notes only/);
  const result = spawnSync(process.execPath, [...feedbackCli, 'init'], { cwd: review.repositoryRoot, encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /personal notes only/);
  assert.equal(fs.existsSync(path.join(reviewDirectory(review.id), 'feedback', 'manifest.json')), false);
  patchReviewState(review.id, review.generation, [change(['comments'], [{ mode: 'personal', body: 'Keep' }])]);
  assert.equal(readReview(review.id).state.comments[0].body, 'Keep');
});

test('published metadata supplies semantic stages, nodes, requirements and insights', (t) => {
  const { author, source, head } = setup(t);
  initializeImplementation(author);
  const semanticStage = { $schema: 'https://semantic-code-review.dev/schemas/v0.1/stage.schema.json', id: 'semantic-stage', title: 'Semantic title', summary: 'Semantic summary', rationale: 'Why', dependsOn: [], specificationRefs: ['story#works'], assumptions: [], alternatives: [], failedAttempts: [], risks: [], validation: [], evidence: [], openQuestions: [],
    change: { baseRevision: author.git('rev-parse', 'main'), headRevision: head, branch: 'feature', baseBranch: 'main', files: [{ path: 'code.txt', kind: 'added' }] },
    nodes: [{ id: 'semantic-node', description: 'Authored node', changes: [{ path: 'code.txt', classification: 'behavior' }] }],
    decisions: [{ id: 'why', category: 'engineering', rationale: 'Why', summary: 'Preserved reasoning', nodeRefs: ['semantic-node'] }] };
  publishMetadata(author, [semanticStage]);
  const review = startRemoteReview(source.root, 'feature'), data = dataFor(review);
  // The projection is private review data; the managed checkout holds only the branch.
  assert.ok(fs.existsSync(path.join(reviewDirectory(review.id), 'artifact', 'stages', 'semantic-semantic-stage.json')));
  assert.equal(fs.existsSync(path.join(review.repositoryRoot, '.semantic-review')), false);
  assert.equal(data.stages.length, 1); assert.equal(data.stages[0].title, 'Semantic title'); assert.equal(data.stages[0].nodes[0].id, 'semantic-node');
  assert.equal(data.stages[0].insights[0].title, 'Preserved reasoning'); assert.ok(data.requirements.length);
});

test('published evidence attachments are available in a remote review', (t) => {
  const { author, source, head } = setup(t);
  initializeImplementation(author);
  const bytes = 'published capture\n', sha256 = createHash('sha256').update(bytes).digest('hex');
  const stored = `evidence/semantic-stage/${sha256}.txt`;
  const semanticStage = { $schema: 'https://semantic-code-review.dev/schemas/v0.1/stage.schema.json', id: 'semantic-stage', title: 'Semantic title', summary: 'Semantic summary', rationale: 'Why', dependsOn: [], specificationRefs: ['story#works'], decisions: [], assumptions: [], alternatives: [], failedAttempts: [], risks: [], validation: [], openQuestions: [],
    evidence: [{ id: 'output', kind: 'terminal', summary: 'It runs', attachments: [{ path: stored, mediaType: 'text/plain', sha256 }], capturedAt: '2026-10-30T10:00:00Z', nodeRefs: ['semantic-node'] }],
    change: { baseRevision: author.git('rev-parse', 'main'), headRevision: head, branch: 'feature', baseBranch: 'main', files: [{ path: 'code.txt', kind: 'added' }] },
    nodes: [{ id: 'semantic-node', description: 'Authored node', changes: [{ path: 'code.txt', classification: 'behavior' }] }] };
  publishMetadata(author, [semanticStage], { [stored]: bytes });
  const review = startRemoteReview(source.root, 'feature'), data = dataFor(review);
  const insight = data.stages[0].insights.find((item) => item.collection === 'evidence');
  assert.equal(data.stages[0].id, 'semantic-semantic-stage');
  const served = createViewerDataSource(review.repositoryRoot).evidenceFile(data.stages[0].id, insight.id, '0');
  assert.equal(Buffer.from(served.content, 'base64').toString(), bytes);
});

test('remote evidence extraction reads each file once and keeps empty captures', (t) => {
  const { author, source, head } = setup(t);
  initializeImplementation(author);
  const sha256 = createHash('sha256').update('').digest('hex'), stored = `evidence/semantic-stage/${sha256}.txt`;
  const attachment = { path: stored, mediaType: 'text/plain', sha256 };
  const semanticStage = { $schema: 'https://semantic-code-review.dev/schemas/v0.1/stage.schema.json', id: 'semantic-stage', title: 'Semantic title', summary: 'Semantic summary', rationale: 'Why', dependsOn: [], specificationRefs: ['story#works'], decisions: [], assumptions: [], alternatives: [], failedAttempts: [], risks: [], validation: [], openQuestions: [],
    evidence: [{ id: 'output', kind: 'terminal', summary: 'It runs', attachments: [attachment, attachment], capturedAt: '2026-10-30T10:00:00Z', nodeRefs: ['semantic-node'] }],
    change: { baseRevision: author.git('rev-parse', 'main'), headRevision: head, branch: 'feature', baseBranch: 'main', files: [{ path: 'code.txt', kind: 'added' }] },
    nodes: [{ id: 'semantic-node', description: 'Authored node', changes: [{ path: 'code.txt', classification: 'behavior' }] }] };
  publishMetadata(author, [semanticStage], { [stored]: '' });
  const review = startRemoteReview(source.root, 'feature'), data = dataFor(review);
  const served = createViewerDataSource(review.repositoryRoot).evidenceFile(data.stages[0].id, 'output', '1');
  assert.equal(served.content, '');
});

test('review --branch enforces read-only mode and authoritative approval lineage over HTTP', async (t) => {
  const { source, author } = setup(t);
  author.git('switch', 'feature');
  author.commitFile('docs/README.md', '# Preview\n\nComplete document.\n', 'Add documentation');
  author.git('switch', 'main');
  const result = spawnSync(process.execPath, [flowCli, 'review', '--branch', 'feature', '--project', source.root], {
    cwd: source.root, encoding: 'utf8', env: { ...process.env, SEMANTIC_VIEW_NO_OPEN: '1' }, timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(result.stdout)?.[0]; assert.ok(url, result.stdout);
  const identity = await (await viewerFetch(url + 'api/whoami')).json();
  t.after(async () => {
    await viewerFetch(url + 'api/shutdown', { method: 'POST', headers: { "content-type": "application/json" }, body: '{}' }).catch(() => {});
    for (let attempt = 0; attempt < 100; attempt++) {
      try { process.kill(identity.processId, 0); }
      catch (error) { if (error.code === 'ESRCH') return; throw error; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail('The remote review viewer did not exit.');
  });
  const query = `?review=${identity.reviewId}&generation=${identity.generation}`;
  const feedback = await viewerFetch(url + 'api/feedback/export' + query, { method: 'POST', headers: { origin: new URL(url).origin, "content-type": "application/json" }, body: '{}' });
  assert.equal(feedback.status, 403);
  const post = (route, body) => viewerFetch(url + route + query, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const implementation = (await (await viewerFetch(url + 'api/implementation' + query)).json()).implementation;
  const docStage = implementation.stages.find(stage => stage.files.some(file => file.path === 'docs/README.md'));
  const docFile = docStage.files.find(file => file.path === 'docs/README.md');
  const contentUrl = new URL(url + 'api/file-content' + query);
  for (const [key, value] of Object.entries({ stage: docStage.id, path: docFile.path, base: docFile.baseRevision, head: docStage.headRevision })) contentUrl.searchParams.set(key, value);
  const document = await (await viewerFetch(contentUrl)).json();
  assert.equal(document.content, '# Preview\n\nComplete document.\n');
  assert.equal(document.revision, docStage.headRevision);
  contentUrl.searchParams.set('raw', '1');
  const raw = await viewerFetch(contentUrl);
  assert.equal(raw.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(raw.headers.get('x-content-type-options'), 'nosniff');
  assert.match(raw.headers.get('content-security-policy'), /sandbox/);
  contentUrl.searchParams.set('target', '../outside');
  assert.equal((await viewerFetch(contentUrl)).status, 422);
  contentUrl.searchParams.set('review', 'wrong-review');
  assert.equal((await viewerFetch(contentUrl)).status, 409);
  const initial = endpoint(implementation);
  const draftSnapshot = { base: initial.baseRevision, head: initial.headRevision };
  const migrated = await (await post('api/draft-snapshots', { notes: [{ kind: 'line', id: `l:${initial.stageId}:new:1:${initial.path}`, snapshot: draftSnapshot }] })).json();
  assert.deepEqual(migrated.snapshots, [{ ...draftSnapshot, fileRevision: initial.fileRevision }]);
  // Obsolete commit coordinates are safe when content and ownership still match:
  // the server must capture its authoritative current endpoint.
  const moved = { ...initial, baseRevision: '0'.repeat(40), headRevision: '0'.repeat(40) };
  const saved = await (await post('api/approval-snapshots', moved)).json();
  assert.equal(saved.ok, true);
  const unchanged = await (await post('api/approval-comparison', { ...moved, snapshotId: saved.snapshotId })).json();
  assert.equal(unchanged.current.baseRevision, initial.baseRevision);
  assert.equal(unchanged.current.headRevision, initial.headRevision);
  assert.deepEqual(unchanged.lines, []);
  assert.equal((await post('api/approval-snapshots', { ...initial, fileRevision: 'changed' })).status, 409);
  assert.equal((await post('api/approval-snapshots', { ...initial, ownership: { ...initial.ownership, classification: 'refactor' } })).status, 409);
  patchReviewState(identity.reviewId, identity.generation, [change(['approvals', `m:${JSON.stringify([initial.stageId, initial.nodeId, initial.path])}`], { ...initial, ...saved, at: 1, rev: 'initial' })]);
  author.git('switch', 'feature');
  author.git('mv', 'code.txt', 'middle.txt'); author.git('commit', '-m', 'First rename');
  author.git('mv', 'middle.txt', 'final.txt'); author.git('commit', '-m', 'Second rename');
  author.write('final.txt', 'updated\n'); author.write('unrelated.txt', 'different file\n');
  author.git('add', 'final.txt', 'unrelated.txt'); author.git('commit', '-m', 'Update files'); author.git('switch', 'main');
  const refreshed = await viewerFetch(url + 'api/remote/refresh' + query, { method: 'POST', headers: { origin: new URL(url).origin, "content-type": "application/json" } });
  assert.equal(refreshed.status, 200, await refreshed.text());
  const list = await (await viewerFetch(url + 'api/reviews' + query)).json();
  assert.ok(list.reviews.find((r) => r.id === identity.reviewId).remote);
  const current = (await (await viewerFetch(url + 'api/implementation' + query)).json()).implementation.stages.at(-1);
  const compare = (filePath) => {
    const file = current.files.find(file => file.path === filePath);
    return post('api/approval-comparison', { stageId: current.id, nodeId: 'changes', path: file.path,
      baseRevision: file.baseRevision, headRevision: current.headRevision, fileRevision: file.revision, ownership: file.memberships[0],
      snapshotId: saved.snapshotId, previousPaths: ['code.txt'] });
  };
  const comparison = await compare('final.txt');
  assert.equal(comparison.status, 200);
  assert.deepEqual((await comparison.json()).lines.filter(line => line.t !== 'ctx').map(line => line.s), ['original', 'updated']);
  const forged = await compare('unrelated.txt');
  assert.equal(forged.status, 409, 'Client-provided rename paths must not authorize a different file');
  assert.match((await forged.json()).error, /another file review/);

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
  assert.ok(data.stages.every(stage => stage.id.startsWith('commit-'))); assert.equal(data.stages.length, 2);
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
  assert.equal(after.stages.length, 3); assert.equal(after.stages.at(-1).title, 'Merge side');
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
  assert.ok(dataFor(review).stages.some(stage => stage.files.some(f => f.path === file)));
  author.git('switch', 'feature'); author.commitFile(file, 'refreshed content\n', 'Nested update'); author.git('switch', 'main');
  refreshRemoteReview(review.id, review.generation);
  assert.equal(fs.readFileSync(path.join(review.repositoryRoot, file), 'utf8'), 'refreshed content\n');
  const storage = inspectReviewStorage(review.id, review.generation);
  assert.deepEqual(deleteReviewData(review.id, review.generation, storage.fingerprint), { deleted: true });
  assert.equal(fs.existsSync(reviewDirectory(review.id)), false);
});


test('Windows short aliases for the review directory retain remote identity', { skip: process.platform !== 'win32' }, (t) => {
  const { source } = setup(t), review = startRemoteReview(source.root, 'feature');
  const shortPath = execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${review.repositoryRoot}") do @echo %~sI`], { encoding: 'utf8', windowsVerbatimArguments: true }).trim();
  assert.ok(shortPath, 'Windows must return a checkout path');
  if (shortPath === review.repositoryRoot) { t.skip('This volume does not create 8.3 aliases'); return; }
  assert.equal(reviewId(shortPath, review.implementationId), review.id);
  const result = spawnSync(process.execPath, [...feedbackCli, 'init'], { cwd: shortPath, encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /personal notes only/);
});

test('remote commit diffs show only incremental edits without a cumulative stage', async (t) => {
  const { author, source, head } = setup(t);
  author.git('switch', 'feature');
  author.commitFile('unrelated.txt', 'gap\n', 'Intervening commit');
  const updated = author.commitFile('code.txt', 'updated\n', 'Update code');
  author.git('switch', 'main');
  const review = startRemoteReview(source.root, 'feature');
  const { createViewerDataSource } = await import('../../src/semantic-view.ts');
  const dataSource = createViewerDataSource(review.repositoryRoot);
  const data = implementationFromScript(dataSource.implementationDataScript());
  assert.equal(data.stages.length, 3);
  assert.ok(data.stages.every((stage) => stage.id.startsWith('commit-')));
  const stage = data.stages.find((stage) => stage.id === `commit-${updated}`), file = stage.files[0];
  assert.equal(file.baseRevision, head);
  assert.equal(file.previousStageId, `commit-${head}`);
  const diff = await dataSource.fileDiff(stage.id, file.path, file.baseRevision, stage.headRevision);
  assert.deepEqual(diff.lines.filter((line) => line.t !== 'ctx').map((line) => line.s), ['original', 'updated']);
});

test('an approval carried to a later commit keeps every correction since it visible', (t) => {
  const { author, source } = setup(t), review = startRemoteReview(source.root, 'feature');
  const context = captureReviewContext(review.id), initial = endpoint(dataFor(review));
  const saved = captureApprovalSnapshot(context, initial);
  patchReviewState(review.id, review.generation, [change(['approvals', `m:${JSON.stringify([initial.stageId, initial.nodeId, initial.path])}`], { ...initial, ...saved, at: 1, rev: 'initial' })]);
  author.git('switch', 'feature');
  author.commitFile('code.txt', 'original\ncorrection one\n', 'First correction');
  author.commitFile('code.txt', 'original\ncorrection one\ncorrection two\n', 'Second correction');
  author.git('switch', 'main');
  refreshRemoteReview(review.id, review.generation);
  const comparison = compareApprovalSnapshot(context, saved.snapshotId, endpoint(dataFor(review)));
  assert.equal(comparison.baseChanged, true); assert.equal(comparison.baseChanges, 'mixed');
  assert.deepEqual(comparison.lines.filter((line) => line.t === 'add').map((line) => line.s), ['correction one', 'correction two']);
});

test('remote approval comparisons follow a complete rename chain across commits and reloads', (t) => {
  const { author, source } = setup(t), review = startRemoteReview(source.root, 'feature');
  const context = captureReviewContext(review.id), initial = endpoint(dataFor(review));
  const saved = captureApprovalSnapshot(context, initial);
  patchReviewState(review.id, review.generation, [change(['approvals', `m:${JSON.stringify([initial.stageId, initial.nodeId, initial.path])}`], { ...initial, ...saved, at: 1, rev: 'initial' })]);
  author.git('switch', 'feature');
  author.git('mv', 'code.txt', 'middle.txt'); author.git('commit', '-m', 'First rename');
  author.git('mv', 'middle.txt', 'final.txt'); author.git('commit', '-m', 'Second rename');
  author.commitFile('final.txt', 'updated\n', 'Edit after rename'); author.git('switch', 'main');
  refreshRemoteReview(review.id, review.generation);
  const data = dataFor(review), stage = data.stages.at(-1), file = stage.files[0];
  assert.deepEqual(file.previousPaths, ['middle.txt', 'code.txt']);
  assert.equal(file.previousPath, undefined);
  const current = { stageId: stage.id, nodeId: 'changes', path: file.path, previousPaths: file.previousPaths,
    baseRevision: file.baseRevision, headRevision: stage.headRevision, fileRevision: file.revision, ownership: file.memberships[0] };
  assert.deepEqual(compareApprovalSnapshot(context, saved.snapshotId, current).lines.filter(line => line.t !== 'ctx').map(line => line.s), ['original', 'updated']);
  assert.deepEqual(dataFor(review).stages.at(-1).files[0].previousPaths, file.previousPaths);
  assert.throws(() => compareApprovalSnapshot(context, saved.snapshotId, { ...current, previousPaths: [], path: 'unrelated.txt' }), /another file review/);
  assert.throws(() => compareApprovalSnapshot(context, saved.snapshotId, { ...current, nodeId: 'another-node' }), /another file review/);
});

/** A projection directory holding one file, and a reader of the folder's files. */
function projection(t, contents = 'previous\n') {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'projection-replace-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const directory = path.join(parent, 'artifact');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'manifest.json'), contents);
  const read = () => fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8');
  return { parent, directory, read };
}

/** Runs operation as on platform, refusing each rename refuse names a code for. */
function withRenames(t, platform, refuse, operation) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  const rename = fs.renameSync;
  const moves = [];
  const mock = t.mock.method(fs, 'renameSync', (from, to) => {
    const code = refuse(from, to);
    moves.push([path.basename(from), path.basename(to), code ?? 'moved']);
    if (code) throw Object.assign(new Error(`${code}: simulated, rename`), { code });
    return rename(from, to);
  });
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  try { operation(); }
  finally { Object.defineProperty(process, 'platform', original); mock.mock.restore(); }
  return moves;
}

test('replacing a projection on Windows waits for readers of its files and folder', (t) => {
  const { parent, directory, read } = projection(t);
  // A reader's open file refuses moving the folder it is in until the reader is done.
  const refusals = new Map([['artifact', ['EPERM', 'EACCES', 'EBUSY']]]);
  const moves = withRenames(t, 'win32', (from) => refusals.get(path.basename(from))?.shift(), () =>
    replaceArtifactDirectory(directory, [['manifest.json', Buffer.from('next\n')]], () => {}));
  assert.deepEqual(moves.filter(([from]) => from === 'artifact').map(([, , outcome]) => outcome), ['EPERM', 'EACCES', 'EBUSY', 'moved']);
  assert.deepEqual(moves.filter(([from]) => from === 'artifact.next').map(([, to, outcome]) => [to, outcome]), [['artifact', 'moved']]);
  assert.equal(read(), 'next\n');
  assert.deepEqual(fs.readdirSync(parent), ['artifact']);
});

test('a projection that stays in use keeps its previous files and reverts the change', (t) => {
  const { parent, directory, read } = projection(t);
  // The retry's own clock and waits, so the budget is checked without real time.
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  t.mock.method(Atomics, 'wait', (array, index, value, ms) => { now += ms; return 'timed-out'; });
  let reverted = 0;
  const refuse = (from) => path.basename(from) === 'artifact' ? 'EPERM' : undefined;
  assert.throws(() => withRenames(t, 'win32', refuse, () =>
    replaceArtifactDirectory(directory, [['manifest.json', Buffer.from('next\n')]], () => {}, () => { reverted++; })), /EPERM/);
  assert.ok(now >= 2000, `waited ${now} ms`);
  assert.equal(reverted, 1);
  assert.equal(read(), 'previous\n');
  assert.deepEqual(fs.readdirSync(parent), ['artifact']);
  // Elsewhere the refusal is not a reader's, so it is reported at once.
  now = 0;
  assert.throws(() => withRenames(t, 'linux', refuse, () =>
    replaceArtifactDirectory(directory, [['manifest.json', Buffer.from('next\n')]], () => {})), /EPERM/);
  assert.equal(now, 0);
  assert.equal(read(), 'previous\n');
});

test('a failed replacement puts the previous projection back once its readers are done', (t) => {
  const { parent, directory, read } = projection(t);
  let reverted = 0;
  // The new files cannot be moved in; the previous ones are held by a reader for a moment.
  const restoring = ['EPERM', 'EBUSY'];
  const refuse = (from) => path.basename(from) === 'artifact.next' ? 'ENOSPC' : path.basename(from) === 'artifact.previous' ? restoring.shift() : undefined;
  assert.throws(() => withRenames(t, 'win32', refuse, () =>
    replaceArtifactDirectory(directory, [['manifest.json', Buffer.from('next\n')]], () => {}, () => { reverted++; })), /ENOSPC/);
  assert.equal(reverted, 1);
  assert.equal(read(), 'previous\n');
  assert.deepEqual(fs.readdirSync(parent), ['artifact']);
});

test('earlier files left only in their backup are kept until new files are in place', (t) => {
  const { parent, directory, read } = projection(t);
  // An earlier replacement moved the files aside, and neither it nor its rollback could move them back.
  fs.renameSync(directory, `${directory}.previous`);
  const backup = () => fs.readFileSync(path.join(`${directory}.previous`, 'manifest.json'), 'utf8');
  let reverted = 0;
  const refuse = (from) => path.basename(from) === 'artifact.next' ? 'ENOSPC' : undefined;
  assert.throws(() => withRenames(t, 'linux', refuse, () =>
    replaceArtifactDirectory(directory, [['manifest.json', Buffer.from('next\n')]], () => {}, () => { reverted++; })), /ENOSPC/);
  // The backup may not match what the change reverted, so it is kept but not shown.
  assert.equal(reverted, 1);
  assert.equal(backup(), 'previous\n');
  assert.deepEqual(fs.readdirSync(parent), ['artifact.previous']);
  replaceArtifactDirectory(directory, [['manifest.json', Buffer.from('next\n')]], () => {});
  assert.equal(read(), 'next\n');
  assert.deepEqual(fs.readdirSync(parent), ['artifact']);
});

test('previous files are not shown again when reverting the change fails', (t) => {
  const { parent, directory } = projection(t);
  const refuse = (from) => path.basename(from) === 'artifact.next' ? 'ENOSPC' : undefined;
  assert.throws(() => withRenames(t, 'linux', refuse, () =>
    replaceArtifactDirectory(directory, [['manifest.json', Buffer.from('next\n')]], () => {}, () => { throw new Error('checkout failed'); })),
  (error) => error instanceof AggregateError && /ENOSPC/.test(error.message) && /checkout failed/.test(error.message));
  // They may not match what stays checked out, so they are kept aside.
  assert.deepEqual(fs.readdirSync(parent), ['artifact.previous']);
  assert.equal(fs.readFileSync(path.join(`${directory}.previous`, 'manifest.json'), 'utf8'), 'previous\n');
});

test('removing a busy staging folder on Windows waits for its readers', (t) => {
  const { parent, directory, read } = projection(t);
  fs.mkdirSync(`${directory}.next`);
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  const remove = fs.rmSync;
  let refusals = 2;
  t.mock.method(fs, 'rmSync', (folder, options) => {
    if (path.basename(folder) === 'artifact.next' && refusals > 0) { const code = ['EBUSY', 'ENOTEMPTY'][--refusals]; throw Object.assign(new Error(`${code}: simulated, rmdir`), { code }); }
    return remove(folder, options);
  });
  Object.defineProperty(process, 'platform', { ...original, value: 'win32' });
  try { replaceArtifactDirectory(directory, [['manifest.json', Buffer.from('next\n')]], () => {}); }
  finally { Object.defineProperty(process, 'platform', original); }
  assert.equal(refusals, 0);
  assert.equal(read(), 'next\n');
  assert.deepEqual(fs.readdirSync(parent), ['artifact']);
});

test('a projection is replaced while another process reads one of its files', { skip: process.platform !== 'win32' }, async (t) => {
  const { parent, directory, read } = projection(t);
  const go = path.join(parent, 'go');
  // The reader holds the file open until it is told to let go, then closes it a moment later.
  const reader = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    const [file, go] = process.argv.slice(1);
    const descriptor = fs.openSync(file, 'r');
    process.stdout.write('open\\n');
    const deadline = Date.now() + 20000;
    const poll = setInterval(() => {
      if (!fs.existsSync(go) && Date.now() < deadline) return;
      clearInterval(poll);
      setTimeout(() => fs.closeSync(descriptor), 300);
    }, 10);
  `, path.join(directory, 'manifest.json'), go], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const exited = new Promise((resolve) => reader.on('exit', resolve));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The reader did not open the file within 10 seconds.')), 10_000);
      reader.stdout.on('data', (chunk) => { if (String(chunk).includes('open')) { clearTimeout(timer); resolve(); } });
      reader.on('error', (error) => { clearTimeout(timer); reject(error); });
      reader.on('exit', () => { clearTimeout(timer); reject(new Error('The reader exited before opening the file.')); });
    });
    // The open file is what the replacement must wait for.
    assert.throws(() => fs.renameSync(directory, `${directory}.moved`), (error) => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
    // The reader lets go only once the new files are staged, so the move starts while it still holds the file.
    replaceArtifactDirectory(directory, [['manifest.json', Buffer.from('next\n')]], () => fs.writeFileSync(go, ''));
    assert.equal(read(), 'next\n');
    assert.equal(await exited, 0);
    assert.deepEqual(fs.readdirSync(parent).filter((name) => !['artifact.previous', 'go'].includes(name)), ['artifact']);
  } finally { reader.kill(); }
});
