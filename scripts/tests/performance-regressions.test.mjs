import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createRepository, initializeImplementation, beginStage, finalizeStage, organizeStage, createImplementationWithStages, feedbackCli, flowCli, scriptsDirectory } from './helpers/repository.mjs';
const { createViewerDataSource, createSnapshotReader, exportFeedback, exportFeedbackReplies, buildFeedbackTargetData } = await import(pathToFileURL(path.join(scriptsDirectory, 'semantic-view.mjs')));
const input = (repo, ...args) => JSON.parse(repo.semantic(...args));

function lineThreads(count) {
  return Array.from({ length: count }, (_, i) => ({ id: `thread-${i}`, 'comment-id': `comment-${i}`, body: 'Review this.', label: 'Line', 'target-kind': 'line', stage: 'implementation', path: 'implementation.txt', side: 'new', line: i + 1 }));
}
function trace(t, repo, cli, args) {
  const file = path.join(os.tmpdir(), `semantic-trace-${process.pid}-${Math.random()}.json`);
  t.after(() => fs.rmSync(file, { force: true }));
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: repo.root, encoding: 'utf8', env: { ...process.env, GIT_TRACE2_EVENT: file } });
  assert.equal(result.status, 0, result.stderr);
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter((event) => event.event === 'start');
}

test('line feedback reuses one immutable blob across pre/post validation and invalidates on restack', (t) => {
  const repo = createRepository(t);
  initializeImplementation(repo); beginStage(repo); finalizeStage(repo, { contents: 'line\n'.repeat(150) });
  repo.feedback('init'); repo.feedback('thread', 'add-batch', '--threads', JSON.stringify(lineThreads(100)));
  const commands = trace(t, repo, feedbackCli, ['thread', 'reply', '--id', 'thread-0', '--comment-id', 'response', '--author', 'agent', '--body', 'Checked.']);
  assert.equal(commands.filter((event) => event.argv.includes('show')).length, 1);
  repo.commitFile('implementation.txt', 'short\n', 'Shorten file');
  repo.semantic('restack', '--from', 'implementation');
  repo.expectFeedbackFailure(/exceeds/, 'thread', 'add', '--id', 'new-line', '--comment-id', 'new-comment', '--body', 'Out of bounds', '--label', 'Line', '--target-kind', 'line', '--stage', 'implementation', '--path', 'implementation.txt', '--side', 'new', '--line', '100');
  repo.feedback('validate'); // historical stale threads are retained
});

test('partial feedback batches report invalid items, keep valid items atomic, and retry idempotently', (t) => {
  const { repository: repo } = createImplementationWithStages(t);
  repo.feedback('init');
  const items = [lineThreads(1)[0], { ...lineThreads(1)[0], id: 'invalid', path: 'absent.txt' }, { ...lineThreads(1)[0], id: 'valid-2', 'comment-id': 'second' }];
  const result = JSON.parse(repo.feedback('thread', 'add-batch', '--partial', '--threads', JSON.stringify(items)));
  assert.deepEqual(result.accepted.map((item) => item.index), [0, 2]);
  assert.deepEqual(result.rejected.map((item) => item.index), [1]);
  const retry = JSON.parse(repo.feedback('thread', 'add-batch', '--partial', '--threads', JSON.stringify(items)));
  assert.equal(retry.accepted.length, 2);
  const reassigned = JSON.parse(repo.feedback('thread', 'add-batch', '--partial', '--threads', JSON.stringify([{ ...items[0], 'assigned-stage': 'missing-stage' }])));
  assert.equal(reassigned.accepted.length, 0);
  assert.match(reassigned.rejected[0].error, /different input/);
  assert.equal(repo.readJson('.semantic-review-feedback/manifest.json').threads.length, 2);
  const replies = [{ id: 'thread-0', 'comment-id': 'reply', body: 'Valid', author: 'agent' }, { id: 'valid-2', 'comment-id': 'bad-reply', body: '', author: 'user' }, { id: 'missing', 'comment-id': 'missing', body: 'Skip' }];
  const replied = JSON.parse(repo.feedback('thread', 'reply-batch', '--partial', '--replies', JSON.stringify(replies)));
  assert.equal(replied.accepted.length, 1);
  assert.equal(replied.rejected.length, 2);
  assert.equal(repo.readJson('.semantic-review-feedback/threads/valid-2.json').comments.length, 1);
  repo.feedback('thread', 'reply-batch', '--partial', '--replies', JSON.stringify(replies));
  assert.equal(repo.readJson('.semantic-review-feedback/threads/thread-0.json').comments.length, 2);
  const invalid = repo.readJson('.semantic-review-feedback/threads/valid-2.json'); invalid.comments[0].body = '';
  repo.write('.semantic-review-feedback/threads/valid-2.json', JSON.stringify(invalid));
  repo.expectFeedbackFailure(/must NOT have fewer|invalid|schema/i, 'thread', 'reply-batch', '--partial', '--replies', JSON.stringify(replies));
});

test('stage batches roll back together and stage plan reports mechanical selectors', (t) => {
  const repo = createRepository(t); initializeImplementation(repo); beginStage(repo);
  const batch = [{ kind: 'decision', itemId: 'one', category: 'engineering', summary: 'Choose one', rationale: 'Relevant reasoning' }, { kind: 'validation', itemId: 'probe', type: 'manual', status: 'passed', summary: 'Observed behavior' }];
  const file = '.semantic-review/.work/stages/implementation.json';
  const before = repo.read(file);
  repo.expectSemanticFailure(/Unsupported record kind/, 'stage', 'record-batch', '--items', JSON.stringify([...batch, { kind: 'invalid', itemId: 'bad' }]));
  assert.equal(repo.read(file), before);
  assert.equal(input(repo, 'stage', 'record-batch', '--items', JSON.stringify(batch)).recorded, 2);
  repo.commitFile('code.txt', 'a\nb\n', 'Implement');
  const plan = input(repo, 'stage', 'plan', '--selectors');
  assert.equal(plan.files[0].path, 'code.txt');
  assert.deepEqual(plan.files[0].selectors.hunks, [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 }]);
  assert.deepEqual(plan.unlinkedItems.map((item) => item.itemId), ['one', 'probe']);
  organizeStage(repo);
  const finished = input(repo, 'stage', 'finish', '--json');
  assert.equal(finished.headRevision, plan.headRevision);
  repo.expectSemanticFailure(/node-ref/, 'stage', 'record-batch', '--stage', 'implementation', '--finalized', '--items', JSON.stringify([{ kind: 'risk', itemId: 'risk', summary: 'Needs link' }]));
});

test('begin rejects a different stage branch with the next ordinal', (t) => {
  const repo = createRepository(t); initializeImplementation(repo);
  repo.git('branch', 'semantic-flow/test-implementation/01-other');
  assert.throws(() => beginStage(repo), /ordinal already exists/);
  assert.equal(repo.exists('.semantic-review/.work/stages/implementation.json'), false);
});

test('combined validation, preparation and landed archive preserve feedback gates', (t) => {
  const repo = createRepository(t); initializeImplementation(repo);
  assert.equal(JSON.parse(repo.flow('validate', '--json')).stages.length, 0);
  beginStage(repo); finalizeStage(repo);
  const verified = JSON.parse(repo.flow('validate', '--publish', '--stack', '--json'));
  assert.equal(verified.stages.length, 1);
  repo.feedback('init'); repo.feedback('thread', 'add-batch', '--threads', JSON.stringify(lineThreads(1)));
  const rejected = repo.result(process.execPath, [flowCli, 'prepare']);
  assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /Unresolved feedback/);
  assert.notEqual(repo.result('git', ['show-ref', '--verify', 'refs/heads/semantic-flow/test-implementation/metadata']).status, 0);
  repo.feedback('thread', 'resolve', '--id', 'thread-0');
  assert.equal(JSON.parse(repo.flow('prepare', '--branch', 'review-ready', '--json')).finalHeadRevision, verified.finalHeadRevision);
  assert.equal(repo.git('rev-parse', 'review-ready'), verified.finalHeadRevision);
  repo.git('switch', 'main'); repo.git('merge', '--ff-only', 'review-ready');
  assert.equal(JSON.parse(repo.flow('archive', '--json')).finalHeadRevision, verified.finalHeadRevision);
  assert.equal(repo.exists('.semantic-review-history/test-implementation/.semantic-review/manifest.json'), true);
});

test('viewer snapshot reads unchanged documents only on fallback and sees external changes/deletion', (t) => {
  const { repository: repo } = createImplementationWithStages(t);
  let now = 0, reads = 0;
  const snapshot = createSnapshotReader(repo.root, { now: () => now, readFile: (file) => { reads++; return fs.readFileSync(file, 'utf8'); } });
  const initial = snapshot(); const initialReads = reads;
  assert.deepEqual(snapshot(), initial); assert.equal(reads, initialReads);
  repo.feedback('init'); repo.feedback('thread', 'add-batch', '--threads', JSON.stringify(lineThreads(1)));
  const pending = snapshot(); assert.notEqual(pending.revision, initial.revision); assert.equal(pending.awaitingAgentReplies, 1);
  repo.feedback('thread', 'reply', '--id', 'thread-0', '--comment-id', 'done', '--author', 'agent', '--body', 'Done');
  assert.equal(snapshot().awaitingAgentReplies, 0);
  const beforeScan = reads; now = 10001; snapshot(); assert.ok(reads > beforeScan);
  repo.remove('.semantic-review-feedback'); assert.equal(snapshot().revision, initial.revision);
});

test('large file pages preserve changes, full context, distant line targets and immutable revisions', async (t) => {
  const repo = createRepository(t);
  repo.commitFile('large.txt', Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join('\n') + '\n', 'Base');
  initializeImplementation(repo); beginStage(repo);
  repo.write('large.txt', repo.read('large.txt').replace('line 2000\n', 'updated 2000\n'));
  repo.write('small.txt', 'small\n'); repo.git('add', '.'); repo.git('commit', '-m', 'Review'); organizeStage(repo); repo.semantic('stage', 'finish');
  const source = createViewerDataSource(repo.root);
  const stage = repo.readJson('.semantic-review/stages/implementation.json');
  const args = ['implementation', 'large.txt', stage.change.baseRevision, stage.change.headRevision];
  const changes = await source.fileDiff(...args);
  assert.ok(changes.lines.length < 20);
  assert.deepEqual(changes.lines.filter((row) => row.t === 'add').map((row) => [row.n, row.h]), [[2000, 1]]);
  const full = await source.fileDiff(...args, 'full'); assert.equal(full.lines.length, 900); assert.equal(full.nextOffset, 900);
  const page = await source.fileDiff(...args, 'full', 900); assert.equal(page.lines[0].n, 901);
  const target = await source.fileDiff(...args, 'full', 0, 'new', 2000);
  assert.equal(target.offset, 1800); assert.ok(target.lines.some((row) => row.n === 2000 && row.s === 'updated 2000'));
  repo.commitFile('large.txt', 'rewritten\n', 'Rewrite'); repo.semantic('restack', '--from', 'implementation');
  assert.deepEqual(await source.fileDiff(...args, 'full', 900), page);
  const revised = repo.readJson('.semantic-review/stages/implementation.json');
  const current = await source.fileDiff('implementation', 'large.txt', revised.change.baseRevision, revised.change.headRevision, 'changes');
  assert.ok(current.nextOffset !== null || current.lines.some((row) => row.s === 'rewritten'));
});

test('viewer sends a failed batch once and deterministic retries do not duplicate feedback', (t) => {
  const { repository: repo } = createImplementationWithStages(t);
  const context = { repoRoot: repo.root, feedbackCli, implementation: buildFeedbackTargetData(repo.root) };
  const notes = [{ ref: 0, clientId: 'draft-1', kind: 'stage', id: 'implementation', body: 'Review once' }, { ref: 1, kind: 'file', id: 'f:implementation:absent', body: 'Invalid' }];
  const first = exportFeedback(context, notes); const second = exportFeedback(context, notes);
  assert.deepEqual(first.exported, second.exported);
  assert.equal(repo.readJson('.semantic-review-feedback/manifest.json').threads.length, 1);
  const drafts = [{ ref: 'reply-draft', threadId: first.exported[0].threadId, body: 'One reply' }];
  exportFeedbackReplies(context, drafts); exportFeedbackReplies(context, drafts);
  assert.equal(repo.readJson(`.semantic-review-feedback/threads/${first.exported[0].threadId}.json`).comments.length, 2);
});

test('snapshot read failure does not publish or retain a partially refreshed snapshot', (t) => {
  const { repository: repo } = createImplementationWithStages(t);
  let failRead = false;
  const reader = createSnapshotReader(repo.root, { readFile(file) {
    if (failRead && file.endsWith('implementation.json')) throw new Error('Temporary read failure');
    return fs.readFileSync(file, 'utf8');
  } });
  const initial = reader();
  const manifest = repo.readJson('.semantic-review/manifest.json'); manifest.title = 'New title';
  repo.write('.semantic-review/manifest.json', JSON.stringify(manifest));
  failRead = true;
  assert.throws(() => reader(true), /Temporary read failure/);
  failRead = false;
  assert.notEqual(reader().revision, initial.revision);
});

test('API index exposes all groups and contract checks still catch drift and missing JSDoc', (t) => {
  const sourceRoot = path.resolve(scriptsDirectory, '..', '..', '..');
  const index = fs.readFileSync(path.join(scriptsDirectory, 'API.d.ts'), 'utf8');
  assert.ok(index.length < 2000);
  for (const group of ['shared', 'implementation', 'stages', 'history', 'feedback', 'workflow']) {
    assert.ok(index.includes(`./api/${group}.js`));
    assert.ok(fs.statSync(path.join(scriptsDirectory, 'api', `${group}.d.ts`)).size > 0);
  }
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-api-check-'));
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  fs.cpSync(path.join(sourceRoot, 'scripts/src/api'), path.join(copy, 'api'), { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, 'scripts/src/api.ts'), path.join(copy, 'api.ts'));
  const stages = path.join(copy, 'api/stages.ts');
  const original = fs.readFileSync(stages, 'utf8');
  const program = `import {compileApiDefinition} from ${JSON.stringify(pathToFileURL(path.join(sourceRoot, 'scripts/src/api-contract-check.ts')).href)}; import {cliApis} from ${JSON.stringify(pathToFileURL(path.join(sourceRoot, 'scripts/src/command-api.ts')).href)}; compileApiDefinition(${JSON.stringify(path.join(copy, 'api.ts'))},cliApis);`;
  const check = () => spawnSync(process.execPath, ['--import', path.join(sourceRoot, 'scripts/node_modules/tsx/dist/loader.mjs'), '--input-type=module', '-e', program], { encoding: 'utf8' });
  assert.equal(check().status, 0);
  fs.writeFileSync(stages, original.replace('  json?: true;', '  json: true;'));
  const drift = check(); assert.notEqual(drift.status, 0); assert.match(drift.stderr, /required/);
  fs.writeFileSync(stages, original.replace('/** Emits stage branch, immutable revisions, worktree, and next action as JSON. */', ''));
  const missing = check(); assert.notEqual(missing.status, 0); assert.match(missing.stderr, /no source JSDoc/);
});

test('one stale export item never falls back to one CLI process per item', (t) => {
  const { repository: repo } = createImplementationWithStages(t);
  repo.feedback('init');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-export-count-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const counter = path.join(directory, 'calls.txt');
  const wrapper = path.join(directory, 'feedback.mjs');
  fs.writeFileSync(wrapper, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(counter)}, 'call\\n'); await import(${JSON.stringify(pathToFileURL(feedbackCli).href)});`);
  const notes = Array.from({ length: 25 }, (_, index) => ({ ref: index, kind: 'stage', id: 'implementation', body: `Note ${index}` }));
  notes.push({ ref: 25, kind: 'file', id: 'f:implementation:missing.txt', body: 'Stale' });
  const result = exportFeedback({ repoRoot: repo.root, feedbackCli: wrapper, implementation: buildFeedbackTargetData(repo.root) }, notes);
  assert.equal(result.exported.length, 25);
  assert.equal(result.skipped.length, 1);
  assert.equal(fs.readFileSync(counter, 'utf8'), 'call\n');
});

test('streamed rename pages do not include a newly recreated old path', async (t) => {
  const repo = createRepository(t);
  repo.commitFile('old.txt', 'original\n'.repeat(1000), 'Base');
  initializeImplementation(repo); beginStage(repo);
  repo.git('mv', 'old.txt', 'new.txt');
  repo.write('new.txt', 'renamed change\n' + 'original\n'.repeat(999));
  repo.write('old.txt', 'unrelated replacement\n');
  repo.git('add', '.'); repo.git('commit', '-m', 'Rename and recreate'); organizeStage(repo); repo.semantic('stage', 'finish');
  const stage = repo.readJson('.semantic-review/stages/implementation.json');
  const source = createViewerDataSource(repo.root);
  const result = await source.fileDiff('implementation', 'new.txt', stage.change.baseRevision, stage.change.headRevision, 'full');
  assert.ok(result.lines.some((row) => row.s === 'renamed change'));
  assert.equal(result.lines.some((row) => row.s === 'unrelated replacement'), false);
});
