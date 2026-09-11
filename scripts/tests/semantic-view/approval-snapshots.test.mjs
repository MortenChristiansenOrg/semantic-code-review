import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRepository, initializeImplementation } from '../helpers/repository.mjs';
import { registerReview, captureReviewContext, captureApprovalSnapshot, compareApprovalSnapshot, patchReviewState, reviewDirectory } from '../../../skills/semantic-flow/scripts/semantic-view.mjs';

function setup(t) {
  const repo = createRepository(t, 'approved-snapshot-'); initializeImplementation(repo);
  const review = registerReview(repo.root, 'test-implementation', 'Snapshot test');
  return { repo, review, context: captureReviewContext(review.id) };
}
function endpoint(repo, head = repo.git('rev-parse', 'HEAD'), file = 'code.txt') {
  return { stageId: 'stage', nodeId: 'node', path: file, baseRevision: head, headRevision: head, fileRevision: head, ownership: { nodeId: 'node', classification: 'behavior', hunks: [1] } };
}
const change = (key, value, before) => ({ path: ['approvals', key], before: before === undefined ? { present: false } : { present: true, value: before }, after: value === undefined ? { present: false } : { present: true, value } });

test('approved content survives loss of the original Git objects and compares across renames', (t) => {
  const { repo, context } = setup(t);
  const old = repo.commitFile('code.txt', 'approved content\n', 'Original review');
  const blob = repo.git('rev-parse', `${old}:code.txt`);
  const saved = captureApprovalSnapshot(context, endpoint(repo));
  repo.git('checkout', '--orphan', 'replacement'); repo.git('rm', '-rf', '.');
  const current = repo.commitFile('renamed.txt', 'current content\n', 'Restacked review');
  repo.git('branch', '-D', 'main'); repo.git('reflog', 'expire', '--expire=now', '--all'); repo.git('gc', '--prune=now');
  assert.notEqual(repo.result('git', ['cat-file', '-e', blob]).status, 0);
  const next = { ...endpoint(repo, current, 'renamed.txt'), previousPath: 'code.txt', ownership: { nodeId: 'node', classification: 'behavior', hunks: [2] } };
  const diff = compareApprovalSnapshot(context, saved.snapshotId, next);
  assert.deepEqual(diff.lines.filter((line) => line.t !== 'ctx').map(({ t, s }) => [t, s]), [['del', 'approved content'], ['add', 'current content']]);
  assert.equal(diff.approved.path, 'code.txt'); assert.equal(diff.current.path, 'renamed.txt');
  assert.equal(diff.baseChanged, true); assert.equal(diff.ownershipChanged, true);
  assert.throws(() => compareApprovalSnapshot(context, saved.snapshotId, { ...next, nodeId: 'other' }), /another file review/);
  const key = `m:${JSON.stringify(['stage', 'node', 'renamed.txt'])}`;
  patchReviewState(context.reviewId, context.generation, [change(key, { snapshotId: saved.snapshotId })]);
  repo.git('mv', 'renamed.txt', 'third.txt'); repo.git('commit', '-m', 'Second rename');
  const chained = compareApprovalSnapshot(context, saved.snapshotId, { ...endpoint(repo, undefined, 'third.txt'), previousPath: 'renamed.txt' });
  assert.equal(chained.approved.path, 'code.txt'); assert.equal(chained.current.path, 'third.txt');
  assert.throws(() => compareApprovalSnapshot(context, saved.snapshotId, endpoint(repo, undefined, 'unrelated.txt')), /another file review/);
});

test('comparisons distinguish added, deleted, empty, and binary file states', (t) => {
  const { repo, context } = setup(t);
  const absent = captureApprovalSnapshot(context, endpoint(repo));
  repo.commitFile('code.txt', '', 'Empty file');
  const empty = compareApprovalSnapshot(context, absent.snapshotId, endpoint(repo));
  assert.equal(empty.approved.exists, false); assert.equal(empty.current.exists, true); assert.deepEqual(empty.lines, []);
  repo.commitFile('code.txt', 'added\n', 'Add content');
  assert.deepEqual(compareApprovalSnapshot(context, absent.snapshotId, endpoint(repo)).lines.map((r) => r.t), ['add']);
  const added = captureApprovalSnapshot(context, endpoint(repo));
  repo.git('rm', 'code.txt'); repo.git('commit', '-m', 'Delete file');
  const deleted = compareApprovalSnapshot(context, added.snapshotId, endpoint(repo));
  assert.equal(deleted.current.exists, false); assert.deepEqual(deleted.lines.map((r) => r.t), ['del']);
  repo.commitFile('code.txt', '\0before', 'Binary file');
  const binary = captureApprovalSnapshot(context, endpoint(repo));
  repo.commitFile('code.txt', '\0after', 'Binary changed');
  const comparison = compareApprovalSnapshot(context, binary.snapshotId, endpoint(repo));
  assert.match(comparison.unsupported, /Binary/); assert.notEqual(comparison.approved.sha256, comparison.current.sha256);
});

test('comparison pages preserve all changed rows including source header-like text', (t) => {
  const { repo, context } = setup(t);
  repo.commitFile('code.txt', 'before\n', 'Before');
  const saved = captureApprovalSnapshot(context, endpoint(repo));
  repo.commitFile('code.txt', Array.from({ length: 1805 }, (_, i) => i === 0 ? '++ header-like source' : `line ${i}`).join('\n') + '\n', 'Large change');
  const rows = []; let offset = 0;
  do { const page = compareApprovalSnapshot(context, saved.snapshotId, endpoint(repo), offset); rows.push(...page.lines); offset = page.nextOffset; } while (offset !== null);
  assert.equal(rows.length, 1806); assert.equal(rows[1].s, '++ header-like source'); assert.equal(rows.at(-1).n, 1805);
});

test('saving approval removal releases only unreferenced snapshots and rejects missing content', (t) => {
  const { repo, review, context } = setup(t);
  repo.commitFile('code.txt', 'approved\n', 'Approved');
  const saved = captureApprovalSnapshot(context, endpoint(repo));
  const record = { rev: 'one', at: 1, snapshotId: saved.snapshotId };
  patchReviewState(review.id, review.generation, [change('one', record), change('two', record)]);
  const file = path.join(reviewDirectory(review.id), 'snapshots', saved.snapshotId + '.json');
  patchReviewState(review.id, review.generation, [change('one', undefined, record)]); assert.ok(fs.existsSync(file));
  patchReviewState(review.id, review.generation, [change('two', undefined, record)]); assert.equal(fs.existsSync(file), false);
  assert.throws(() => patchReviewState(review.id, review.generation, [change('one', record)]), /Approved content is unavailable/);
});


test('oversized approved and current blobs retain identity without storing misleading content hashes', (t) => {
  const { repo, context } = setup(t);
  repo.commitFile('code.txt', 'small\n', 'Small content');
  const small = captureApprovalSnapshot(context, endpoint(repo));
  const size = 20 * 1024 * 1024 + 1;
  repo.commitFile('code.txt', Buffer.alloc(size, 65), 'Oversized content');
  const largeEndpoint = endpoint(repo), large = captureApprovalSnapshot(context, largeEndpoint);
  const file = path.join(reviewDirectory(context.reviewId), 'snapshots', large.snapshotId + '.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(fs.statSync(file).size < 2000); assert.equal(saved.content.bytes, '');
  assert.equal(saved.content.size, size); assert.equal(saved.content.sha256, null);
  assert.equal(saved.content.objectId, repo.git('rev-parse', 'HEAD:code.txt'));
  const currentLarge = compareApprovalSnapshot(context, small.snapshotId, largeEndpoint);
  assert.match(currentLarge.unsupported, /20 MiB/); assert.equal(currentLarge.current.sha256, null);
  repo.commitFile('code.txt', 'small again\n', 'Small again');
  const approvedLarge = compareApprovalSnapshot(context, large.snapshotId, endpoint(repo));
  assert.match(approvedLarge.unsupported, /20 MiB/); assert.equal(approvedLarge.approved.size, size);
  assert.equal(approvedLarge.approved.sha256, null); assert.match(approvedLarge.current.sha256, /^[a-f0-9]{64}$/);
});
