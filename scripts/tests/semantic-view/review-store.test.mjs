import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { registerReview, readReview, patchReviewState, reviewDirectory, listReviews, setReviewCompleted, registeredReviews } from '../../../skills/semantic-flow/scripts/semantic-view.mjs';

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


test('failed owner metadata writes release the lock for the next operation', (t) => {
  const root = setup(t);
  const write = fs.writeFileSync;
  const failure = Object.assign(new Error('Disk full'), { code: 'ENOSPC' });
  const mocked = t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (path.basename(String(file)) === 'owner.json') throw failure;
    return write(file, ...args);
  });
  assert.throws(() => registerReview(path.join(root, 'a'), 'id', 'Review'), (error) => error === failure);
  assert.deepEqual(fs.readdirSync(path.join(root, 'user-data', 'locks')), []);
  mocked.mock.restore();
  assert.equal(registerReview(path.join(root, 'a'), 'id', 'Review').implementationId, 'id');
});


test('relative user-store overrides cannot change meaning between CLI worktrees', (t) => {
  const root = setup(t);
  process.env.SEMANTIC_FLOW_HOME = 'relative-user-data';
  assert.throws(() => registerReview(path.join(root, 'a'), 'id', 'Review'), /absolute path/);
});


test('registry lifecycle is explicit, generation guarded, and retains unavailable entries', (t) => {
  const root = setup(t), repo = path.join(root, 'a');
  fs.mkdirSync(path.join(repo, '.semantic-review'));
  fs.writeFileSync(path.join(repo, '.semantic-review', 'manifest.json'), JSON.stringify({ implementationId: 'id' }));
  const review = registerReview(repo, 'id', 'Review');
  assert.equal(registeredReviews()[0].available, true);
  assert.equal(setReviewCompleted(review.id, review.generation, true, null).completedAt, readReview(review.id).updatedAt);
  const complete = readReview(review.id);
  assert.equal(registerReview(repo, 'id', 'Review').completedAt, complete.completedAt);
  assert.equal(setReviewCompleted(review.id, review.generation, true, null).completedAt, complete.completedAt);
  assert.throws(() => setReviewCompleted(review.id, review.generation, false, null), /another tab/);
  assert.equal(setReviewCompleted(review.id, review.generation, false, complete.completedAt).completedAt, null);
  assert.throws(() => setReviewCompleted(review.id, 'old-generation', true, null), /replaced/);
  fs.rmSync(repo, { recursive: true });
  assert.equal(listReviews().length, 1);
  assert.equal(registeredReviews()[0].available, false);
  assert.match(registeredReviews()[0].unavailableReason, /unavailable/);
});

test('review edits update activity timestamps while navigation preferences do not', (t) => {
  const root = setup(t), review = registerReview(path.join(root, 'a'), 'id', 'Review');
  review.updatedAt = '2000-01-01T00:00:00.000Z';
  review.state.approvals = { one: { rev: 'old' } };
  fs.writeFileSync(path.join(reviewDirectory(review.id), 'review.json'), JSON.stringify(review));
  patchReviewState(review.id, review.generation, [change(['openNodes', 'one'], true)]);
  assert.equal(readReview(review.id).updatedAt, review.updatedAt);
  patchReviewState(review.id, review.generation, [change(['approvals', 'one', 'rev'], 'new', 'old')]);
  assert.notEqual(readReview(review.id).updatedAt, review.updatedAt);
});
