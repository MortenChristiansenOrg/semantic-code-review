import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { registerReview, readReview, patchReviewState, reviewDirectory } from '../../../skills/semantic-flow/scripts/semantic-view.mjs';

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-store-'));
  const old = process.env.SEMANTIC_FLOW_HOME;
  process.env.SEMANTIC_FLOW_HOME = path.join(directory, 'user-data');
  t.after(() => { if (old === undefined) delete process.env.SEMANTIC_FLOW_HOME; else process.env.SEMANTIC_FLOW_HOME = old; fs.rmSync(directory, { recursive: true, force: true }); });
  for (const name of ['a', 'b']) fs.mkdirSync(path.join(directory, name));
  return directory;
}
const change = (keys, value, before) => ({ path: keys, before: before === undefined ? { present: false } : { present: true, value: before }, after: { present: true, value } });

test('review identities isolate worktrees and persist across reopening', (t) => {
  const root = setup(t);
  const a = registerReview(path.join(root, 'a'), 'same-id', 'Review');
  const b = registerReview(path.join(root, 'b'), 'same-id', 'Review');
  assert.notEqual(a.id, b.id);
  patchReviewState(a.id, a.generation, [change(['comments'], [{ body: 'Draft' }])]);
  assert.deepEqual(registerReview(path.join(root, 'a'), 'same-id', 'Review').state.comments, [{ body: 'Draft' }]);
  assert.deepEqual(readReview(b.id).state, {});
  assert.equal(registerReview(path.join(root, 'a'), 'same-id', 'Review').updatedAt, readReview(a.id).updatedAt);
  assert.ok(fs.existsSync(path.join(reviewDirectory(a.id), 'snapshots')));
});

test('independent tab edits merge, retries are idempotent, conflicts are atomic', (t) => {
  const root = setup(t), review = registerReview(path.join(root, 'a'), 'id', 'Review');
  const write = (changes) => patchReviewState(review.id, review.generation, changes);
  write([change(['approvals', 'one'], { rev: 'a' })]);
  write([change(['approvals', 'two'], { rev: 'b' })]);
  write([change(['approvals', 'one'], { rev: 'a' })]);
  assert.deepEqual(readReview(review.id).state.approvals, { one: { rev: 'a' }, two: { rev: 'b' } });
  assert.throws(() => write([change(['draft'], 'keep'), change(['approvals', 'one'], { rev: 'wrong' })]), /another tab/);
  assert.equal(readReview(review.id).state.draft, undefined);
  assert.throws(() => write([change(['__proto__', 'polluted'], true)]), /Invalid/);
  assert.equal({}.polluted, undefined);
});

test('deleted sessions cannot be resurrected by stale writes', (t) => {
  const root = setup(t), first = registerReview(path.join(root, 'a'), 'id', 'Review');
  fs.rmSync(reviewDirectory(first.id), { recursive: true });
  assert.throws(() => patchReviewState(first.id, first.generation, [change(['draft'], 'old')]), /deleted/);
  const reopened = registerReview(path.join(root, 'a'), 'id', 'Review');
  assert.notEqual(first.generation, reopened.generation);
  assert.throws(() => patchReviewState(first.id, first.generation, []), /replaced/);
});


test('separate processes cannot lose independent state writes', async (t) => {
  const root = setup(t), review = registerReview(path.join(root, 'a'), 'id', 'Review');
  const moduleUrl = new URL('../../../skills/semantic-flow/scripts/semantic-view.mjs', import.meta.url).href;
  const source = `import { patchReviewState } from ${JSON.stringify(moduleUrl)}; patchReviewState(process.argv[1], process.argv[2], JSON.parse(process.argv[3]));`;
  await Promise.all(Array.from({ length: 6 }, (_, i) => promisify(execFile)(process.execPath, ['--input-type=module', '-e', source, review.id, review.generation, JSON.stringify([change(['approvals', String(i)], i)])])));
  assert.deepEqual(readReview(review.id).state.approvals, { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 });
});
