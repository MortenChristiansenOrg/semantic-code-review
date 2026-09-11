import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { registerReview, readReview, patchReviewState, reviewDirectory, registeredReviews, storeAttachment, resolveAttachment, inspectReviewStorage, deleteReviewData, cleanUnusedReviewFiles, reviewSessionUnavailable } from '../../../skills/semantic-flow/scripts/semantic-view.mjs';
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-cleanup-')), previous = process.env.SEMANTIC_FLOW_HOME;
  process.env.SEMANTIC_FLOW_HOME = path.join(root, 'data');
  t.after(() => { t.mock.restoreAll(); if (previous === undefined) delete process.env.SEMANTIC_FLOW_HOME; else process.env.SEMANTIC_FLOW_HOME = previous; fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); });
  fs.mkdirSync(path.join(root, 'repo')); fs.mkdirSync(path.join(root, 'other'));
  const review = registerReview(path.join(root, 'repo'), 'same-id', 'Review'), other = registerReview(path.join(root, 'other'), 'same-id', 'Other');
  return { root, review, other };
}
const change = (key, value, before) => ({ path: [key], before: before === undefined ? { present: false } : { present: true, value: before }, after: { present: true, value } });
const preview = (review) => inspectReviewStorage(review.id, review.generation);
function oldAttachment(review, filename) {
  const file = storeAttachment(review.id, review.generation, filename, 'text/plain', Buffer.from('context'));
  const metadata = path.join(path.dirname(resolveAttachment(review.id, file.id).localPath), 'metadata.json');
  const record = JSON.parse(fs.readFileSync(metadata, 'utf8')); record.uploadedAt = new Date(Date.now() - 7200000).toISOString(); fs.writeFileSync(metadata, JSON.stringify(record));
  return file;
}

test('storage previews count drafts and feedback; confirmed deletion preserves other reviews and repository files', (t) => {
  const { root, review, other } = setup(t);
  fs.writeFileSync(path.join(root, 'repo', 'source.txt'), 'source');
  fs.mkdirSync(path.join(root, 'repo', '.semantic-review')); fs.writeFileSync(path.join(root, 'repo', '.semantic-review', 'manifest.json'), 'artifact');
  const file = oldAttachment(review, 'context.log');
  const otherFile = storeAttachment(other.id, other.generation, 'context.log', 'text/plain', Buffer.from('context'));
  patchReviewState(review.id, review.generation, [change('comments', [{ mode: 'feedback', body: 'Unsent', attachments: [file] }, { mode: 'personal', body: 'Personal' }]), change('editor', { compose: { body: 'Typing' } })]);
  const threads = path.join(reviewDirectory(review.id), 'feedback', 'threads'); fs.mkdirSync(threads);
  fs.writeFileSync(path.join(threads, 'one.json'), JSON.stringify({ status: 'open', comments: [{ attachments: [file] }] }));
  const before = preview(review);
  assert.equal(before.drafts, 2); assert.equal(before.unresolved, 1); assert.equal(before.unusedBytes, 0);
  assert.ok(before.bytes > file.size); assert.equal(before.categories.reduce((sum, item) => sum + item.bytes, 0), before.bytes);
  assert.equal(deleteReviewData(review.id, review.generation, before.fingerprint).deleted, true);
  assert.throws(() => readReview(review.id), /deleted/);
  assert.equal(fs.readFileSync(path.join(root, 'repo', 'source.txt'), 'utf8'), 'source');
  assert.equal(fs.readFileSync(path.join(root, 'repo', '.semantic-review', 'manifest.json'), 'utf8'), 'artifact');
  assert.ok(fs.existsSync(resolveAttachment(other.id, otherFile.id).localPath));
  assert.deepEqual(deleteReviewData(review.id, review.generation, before.fingerprint), { deleted: true, cleanupPending: false });
  const reopened = registerReview(path.join(root, 'repo'), 'same-id', 'Fresh'); assert.notEqual(reopened.generation, review.generation);
  assert.throws(() => deleteReviewData(review.id, review.generation, before.fingerprint), /replaced/);
  assert.throws(() => patchReviewState(review.id, review.generation, [change('late', true)]), /replaced/);
});

test('deletion rejects an outdated preview and works after the worktree is removed', (t) => {
  const { root, review } = setup(t), before = preview(review);
  patchReviewState(review.id, review.generation, [change('comments', [{ body: 'New work' }])]);
  assert.throws(() => deleteReviewData(review.id, review.generation, before.fingerprint), /changed since/);
  fs.rmSync(path.join(root, 'repo'), { recursive: true });
  assert.equal(registeredReviews().find((entry) => entry.id === review.id).available, false);
  assert.equal(deleteReviewData(review.id, review.generation, preview(review).fingerprint).cleanupPending, false);
});

test('failed removal invalidates writers and stays discoverable until retry completes', (t) => {
  const { root, review } = setup(t), before = preview(review), remove = fs.rmSync;
  const mock = t.mock.method(fs, 'rmSync', (file, options) => {
    if (String(file).includes(path.join('data', 'trash'))) throw Object.assign(new Error('File is open'), { code: 'EBUSY' });
    return remove(file, options);
  });
  const result = deleteReviewData(review.id, review.generation, before.fingerprint);
  assert.equal(result.cleanupPending, true); assert.throws(() => readReview(review.id), /deleted/);
  const remaining = preview(review); assert.equal(remaining.categories.reduce((sum, item) => sum + item.bytes, 0), remaining.bytes);
  assert.equal(registeredReviews().find((entry) => entry.id === review.id).deletionPending, true);
  assert.throws(() => storeAttachment(review.id, review.generation, 'late', 'text/plain', Buffer.alloc(0)), /deleted/);
  assert.throws(() => registerReview(path.join(root, 'repo'), 'same-id', 'Fresh'), /pending review deletion/);
  mock.mock.restore();
  assert.equal(deleteReviewData(review.id, review.generation, before.fingerprint).cleanupPending, false);
  assert.equal(registeredReviews().some((entry) => entry.id === review.id), false);
});

test('unused cleanup protects references and recent uploads, and permits retry of partially removed files', (t) => {
  const { review } = setup(t), kept = oldAttachment(review, 'kept'), unused = oldAttachment(review, 'unused');
  const recent = storeAttachment(review.id, review.generation, 'recent', 'text/plain', Buffer.from('recent'));
  patchReviewState(review.id, review.generation, [change('editor', { replyAttachments: [kept] })]);
  let before = preview(review); assert.equal(before.unused.length, 1);
  const remove = fs.rmSync; let failed = false;
  const mock = t.mock.method(fs, 'rmSync', (file, options) => {
    if (String(file).includes(path.sep + '.cleanup' + path.sep) && !failed) { failed = true; throw new Error('File is open'); }
    return remove(file, options);
  });
  assert.equal(cleanUnusedReviewFiles(review.id, review.generation, before.fingerprint).failures.length, 1); mock.mock.restore();
  assert.throws(() => patchReviewState(review.id, review.generation, [change('comments', [{ attachments: [unused] }])]), /removed/);
  before = preview(review); assert.equal(before.unused.length, 1);
  assert.ok(cleanUnusedReviewFiles(review.id, review.generation, before.fingerprint).reclaimedBytes > 0);
  assert.ok(resolveAttachment(review.id, kept.id)); assert.ok(resolveAttachment(review.id, recent.id));
  assert.equal(preview(review).unused.length, 0);
  const old = oldAttachment(review, 'retry-upload'); before = preview(review); assert.equal(before.unused.length, 1);
  storeAttachment(review.id, review.generation, 'retry-upload', 'text/plain', Buffer.from('context'));
  assert.throws(() => cleanUnusedReviewFiles(review.id, review.generation, before.fingerprint), /changed since/);
  assert.equal(preview(review).unused.length, 0); assert.ok(resolveAttachment(review.id, old.id));
});

test('stale process writes cannot resurrect a deleted review', async (t) => {
  const { review } = setup(t);
  const moduleUrl = new URL('../../../skills/semantic-flow/scripts/semantic-view.mjs', import.meta.url).href;
  const source = `import { patchReviewState } from ${JSON.stringify(moduleUrl)}; try { patchReviewState(process.argv[1], process.argv[2], JSON.parse(process.argv[3])); } catch {} `;
  const writers = Array.from({ length: 8 }, (_, i) => promisify(execFile)(process.execPath, ['--input-type=module', '-e', source, review.id, review.generation, JSON.stringify([change('draft' + i, 'late')])]));
  // Either a writer finishes before preview, invalidates it, or is rejected after retirement.
  for (;;) {
    const current = preview(review);
    try { deleteReviewData(review.id, review.generation, current.fingerprint); break; }
    catch (error) { if (!/changed since/.test(error.message)) throw error; }
  }
  await Promise.all(writers);
  assert.equal(fs.existsSync(reviewDirectory(review.id)), false);
});

test('cleanup includes retained snapshots without deleting referenced snapshots or following directory links', (t) => {
  const { root, review } = setup(t), snapshots = path.join(reviewDirectory(review.id), 'snapshots');
  for (const id of ['a', 'b']) { const file = path.join(snapshots, id.repeat(32) + '.json'); fs.writeFileSync(file, '{}'); fs.utimesSync(file, new Date(0), new Date(0)); }
  patchReviewState(review.id, review.generation, [change('approvals', { kept: { snapshotId: 'a'.repeat(32) } })]);
  const current = preview(review); assert.equal(current.unused.length, 1);
  cleanUnusedReviewFiles(review.id, review.generation, current.fingerprint);
  assert.ok(fs.existsSync(path.join(snapshots, 'a'.repeat(32) + '.json')));
  if (process.platform !== 'win32') {
    const outside = path.join(root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep'), 'outside');
    fs.symlinkSync(outside, path.join(reviewDirectory(review.id), 'external'), 'dir');
    deleteReviewData(review.id, review.generation, preview(review).fingerprint);
    assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'outside');
  }
});


test('temporary read errors do not classify a live review as deleted', (t) => {
  const { review } = setup(t), context = { reviewId: review.id, generation: review.generation, repositoryRoot: review.repositoryRoot, implementationId: review.implementationId };
  assert.equal(reviewSessionUnavailable(context), false);
  const read = fs.readFileSync;
  const mock = t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (String(file) === path.join(reviewDirectory(review.id), 'review.json')) throw Object.assign(new Error('Temporarily denied'), { code: 'EACCES' });
    return read(file, ...args);
  });
  assert.equal(reviewSessionUnavailable(context), false);
  assert.throws(() => readReview(review.id), (error) => error.code === 'EACCES'); mock.mock.restore();
  deleteReviewData(review.id, review.generation, preview(review).fingerprint);
  assert.equal(reviewSessionUnavailable(context), true);
});
