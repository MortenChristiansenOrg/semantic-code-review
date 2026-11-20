import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { registerReview, readReview, patchReviewState, reviewDirectory, reviewId, feedbackDirectory, listReviews, setReviewCompleted, registeredReviews, storeAttachment, resolveAttachment } from '../../src/semantic-view.ts';
import { ArtifactDraft, commitArtifact } from '../../src/shared/artifact-store.ts';
// Child processes import the same TypeScript sources.
const sourceLoader = ['--import', import.meta.resolve('tsx')];

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

test('review folder names are readable, bounded and retain the full unique identity', (t) => {
  const root = setup(t), worktree = path.join(root, 'a');
  const a = registerReview(worktree, 'Order Cancellation', 'An editable title');
  const digest = createHash('sha256').update(JSON.stringify([fs.realpathSync(worktree), 'Order Cancellation'])).digest('hex');
  assert.equal(path.basename(reviewDirectory(a.id)), `a--order-cancellation--${digest}`);
  assert.equal(reviewId(worktree, 'Order Cancellation'), a.id);
  const alias = path.join(root, 'alias'); fs.symlinkSync(worktree, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(reviewId(alias, 'Order Cancellation'), a.id);
  assert.equal(feedbackDirectory(worktree, 'Order Cancellation'), path.join(reviewDirectory(a.id), 'feedback'));
  assert.equal(registerReview(worktree, 'Order Cancellation', 'A changed title').id, a.id);
  const collision = registerReview(worktree, 'Order/Cancellation', 'Same readable name');
  assert.ok(collision.id.startsWith('a--order-cancellation--')); assert.notEqual(collision.id, a.id);
  const duplicateName = path.join(root, 'b', 'a'); fs.mkdirSync(duplicateName);
  const other = registerReview(duplicateName, 'Order Cancellation', 'Another worktree');
  assert.ok(other.id.startsWith('a--order-cancellation--')); assert.notEqual(other.id, a.id);
  const longRoot = path.join(root, 'Long Worktree Name '.repeat(3).trim()); fs.mkdirSync(longRoot);
  const long = registerReview(longRoot, 'Long Implementation Name '.repeat(20), 'Long');
  assert.ok(long.id.length <= 132);
  assert.match(registerReview(worktree, '日本語', 'Unicode').id, /^a--review--[a-f0-9]{64}$/);
  assert.match(registerReview(worktree, '../Café: cancel?!', 'Escaped').id, /^a--cafe-cancel--[a-f0-9]{64}$/);
  assert.equal(listReviews().length, 6);
  for (const invalid of [digest, '../' + a.id, a.id + '/child', a.id.toUpperCase(), a.id + '.']) {
    assert.throws(() => reviewDirectory(invalid), /Invalid review identity/);
  }
});

test('independent tab edits merge, retries are idempotent, conflicts are atomic', (t) => {
  const root = setup(t), review = registerReview(path.join(root, 'a'), 'id', 'Review');
  const write = (changes) => patchReviewState(review.id, review.generation, changes);
  write([change(['approvals', 'one'], { rev: 'a' })]);
  write([change(['approvals', 'two'], { rev: 'b' })]);
  // A retry changes nothing, so it leaves the state revision.
  assert.equal(write([change(['approvals', 'one'], { rev: 'a' })]).stateRevision, 2);
  assert.deepEqual(readReview(review.id).state.approvals, { one: { rev: 'a' }, two: { rev: 'b' } });
  assert.throws(() => write([change(['draft'], 'keep'), change(['approvals', 'one'], { rev: 'wrong' })]), /another tab/);
  assert.equal(readReview(review.id).state.draft, undefined);
  assert.equal(readReview(review.id).stateRevision, 2);
  assert.throws(() => write([{ path: ['draft', 1], before: { present: false }, after: { present: true, value: true } }]), /Invalid/);
});

test('the store records the ID of the save that last changed the state', (t) => {
  const root = setup(t), review = registerReview(path.join(root, 'a'), 'id', 'Review');
  assert.equal(patchReviewState(review.id, review.generation, [change(['draft'], 'one')], 'save-1').lastSaveId, 'save-1');
  // An exact retry changes nothing, so it keeps the ID of the save that did.
  assert.equal(patchReviewState(review.id, review.generation, [change(['draft'], 'one')], 'save-2').lastSaveId, 'save-1');
  assert.equal(readReview(review.id).lastSaveId, 'save-1');
  assert.equal(patchReviewState(review.id, review.generation, [change(['draft'], 'two', 'one')]).lastSaveId, undefined);
  assert.equal(readReview(review.id).lastSaveId, undefined);
});

test('a save is reported as stored when releasing the lock afterwards fails', (t) => {
  const root = setup(t), review = registerReview(path.join(root, 'a'), 'id', 'Review');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(to).includes('.lock.retired-')) throw Object.assign(new Error('I/O error'), { code: 'EIO' });
    return rename(from, to);
  });
  assert.equal(patchReviewState(review.id, review.generation, [change(['draft'], 'saved')]).state.draft, 'saved');
  t.mock.restoreAll();
  assert.equal(readReview(review.id).state.draft, 'saved');
});

test('state under keys named __proto__, constructor and prototype is saved, restored and never pollutes prototypes', (t) => {
  const root = setup(t), review = registerReview(path.join(root, 'a'), 'id', 'Review');
  const write = (changes) => patchReviewState(review.id, review.generation, changes);
  const names = ['__proto__', 'constructor', 'prototype'];
  write([
    ...names.map((name) => change(['approvals', name], { rev: name, polluted: true })),
    ...names.map((name) => change(['openStages', name], true)),
    ...names.map((name) => change([name, 'polluted'], true)),
    ...names.map((name) => change(['nested', name, name, 'polluted'], name)),
  ]);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.getPrototypeOf(Object.prototype), null);
  const state = readReview(review.id).state;
  for (const name of names) {
    for (const map of [state, state.approvals, state.openStages, state.nested, state.nested[name]]) {
      assert.ok(Object.hasOwn(map, name), `${name} is an own key`);
      assert.equal(Object.getPrototypeOf(map), Object.prototype);
    }
    assert.deepEqual({ ...state.approvals[name] }, { rev: name, polluted: true });
    assert.equal(state.openStages[name], true);
    assert.equal(state[name].polluted, true);
    assert.equal(state.nested[name][name].polluted, name);
  }
  // Exact retries stay idempotent; changes and removals compare own values only.
  write(names.map((name) => change(['openStages', name], true)));
  write(names.map((name) => change(['openStages', name], false, true)));
  write(names.map((name) => ({ path: ['approvals', name], before: { present: true, value: { rev: name, polluted: true } }, after: { present: false } })));
  assert.throws(() => write([change(['openStages', 'constructor'], true, true)]), /another tab/);
  const updated = readReview(review.id).state;
  for (const name of names) {
    assert.equal(updated.openStages[name], false);
    assert.equal(Object.hasOwn(updated.approvals, name), false);
  }
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
  const moduleUrl = new URL('../../src/semantic-view.ts', import.meta.url).href;
  const source = `import { patchReviewState } from ${JSON.stringify(moduleUrl)}; patchReviewState(process.argv[1], process.argv[2], JSON.parse(process.argv[3]));`;
  await Promise.all(Array.from({ length: 6 }, (_, i) => promisify(execFile)(process.execPath, [...sourceLoader, '--input-type=module', '-e', source, review.id, review.generation, JSON.stringify([change(['approvals', String(i)], i)])])));
  assert.deepEqual(readReview(review.id).state.approvals, { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 });
});


test('failed owner metadata writes release the lock for the next operation', (t) => {
  const root = setup(t);
  const write = fs.writeFileSync;
  const failure = Object.assign(new Error('Disk full'), { code: 'ENOSPC' });
  const mocked = t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (/^owner-[a-f0-9-]+\.json$/.test(path.basename(String(file)))) throw failure;
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
  const artifact = new ArtifactDraft(undefined);
  artifact.writeJson('manifest.json', { implementationId: 'id' });
  commitArtifact(repo, undefined, artifact);
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


test('attachments preserve bytes, enforce limits and ownership, and reject stale sessions', (t) => {
  const root = setup(t), review = registerReview(path.join(root, 'a'), 'attachments', 'Files');
  const save = (name, bytes, type = 'application/octet-stream') => storeAttachment(review.id, review.generation, name, type, bytes);
  const attachment = save('context.html', Buffer.from('<script>unsafe preview</script>'), 'image/png');
  assert.equal(attachment.mediaType, 'application/octet-stream');
  const resolved = resolveAttachment(review.id, attachment.id);
  assert.equal(fs.readFileSync(resolved.localPath, 'utf8'), '<script>unsafe preview</script>');
  assert.deepEqual(save('context.html', Buffer.from('<script>unsafe preview</script>'), 'image/png'), attachment);
  assert.equal(save('empty.log', Buffer.alloc(0)).size, 0);
  for (const name of ['../escape', 'a\\b', 'line\nname', '.', '']) assert.throws(() => save(name, Buffer.alloc(0)), /filename/);
  assert.throws(() => save('large', Buffer.alloc(20 * 1024 * 1024 + 1)), /20 MiB/);
  assert.throws(() => storeAttachment(review.id, 'old-generation', 'stale', 'text/plain', Buffer.alloc(0)), /replaced or deleted/);
  const other = registerReview(path.join(root, 'b'), 'attachments', 'Other');
  assert.throws(() => resolveAttachment(other.id, attachment.id), /ENOENT/);
  assert.throws(() => resolveAttachment(review.id, '../outside'), /identity/);
  if (process.platform !== 'win32') {
    const outside = path.join(root, 'outside'); fs.writeFileSync(outside, '<script>unsafe preview</script>');
    fs.rmSync(resolved.localPath); fs.symlinkSync(outside, resolved.localPath);
    assert.throws(() => resolveAttachment(review.id, attachment.id), /outside/);
  }
});


test('attachment resolution rejects same-size replacements and metadata with a stale identity', (t) => {
  const root = setup(t), review = registerReview(path.join(root, 'a'), 'integrity', 'Integrity');
  const attachment = storeAttachment(review.id, review.generation, 'context.log', 'text/plain', Buffer.from('before'));
  const file = resolveAttachment(review.id, attachment.id).localPath;
  fs.writeFileSync(file, 'after!');
  assert.throws(() => resolveAttachment(review.id, attachment.id), /damaged/);
  const metadataFile = path.join(path.dirname(file), 'metadata.json');
  const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
  metadata.attachment.sha256 = createHash('sha256').update('after!').digest('hex');
  fs.writeFileSync(metadataFile, JSON.stringify(metadata));
  assert.throws(() => resolveAttachment(review.id, attachment.id), /damaged/);
});

test('lock cleanup retires its directory before removal and tolerates transient rename failures', (t) => {
  const root = setup(t); const rename = fs.renameSync, remove = fs.rmSync;
  let retries = 0, retired = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(from).endsWith('.lock') && retries++ === 0) throw Object.assign(new Error('Busy'), { code: 'EACCES' });
    return rename(from, to);
  });
  t.mock.method(fs, 'rmSync', (file, options) => {
    assert.equal(String(file).endsWith('.lock'), false, 'Never recursively remove the public lock path');
    if (String(file).includes('.retired-')) { retired++; assert.equal(options.maxRetries, 10); }
    return remove(file, options);
  });
  const review = registerReview(path.join(root, 'a'), 'locking', 'Locking');
  patchReviewState(review.id, review.generation, [change(['draft'], 'saved')]);
  assert.equal(readReview(review.id).state.draft, 'saved'); assert.equal(retired, 2); assert.ok(retries >= 3);
});


test('locks publish initialized owners and recover abandoned claims and dead public owners', async (t) => {
  const root = setup(t), directory = path.join(root, 'user-data', 'locks');
  const id = reviewId(path.join(root, 'a'), 'crash');
  const lock = path.join(directory, id + '.lock');
  fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(lock + '.claim-abandoned'); // Process death before publication cannot block.
  const child = await promisify(execFile)(process.execPath, ['-e', 'console.log(process.pid)']);
  const deadPid = Number(child.stdout.trim());
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner-00000000-0000-4000-8000-000000000000.json'), JSON.stringify({ pid: deadPid }));
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(to) === lock) {
      const entries = fs.readdirSync(from);
      assert.equal(entries.length, 1); assert.match(entries[0], /^owner-/);
      assert.equal(JSON.parse(fs.readFileSync(path.join(from, entries[0]), 'utf8')).pid, process.pid);
    }
    return rename(from, to);
  });
  const review = registerReview(path.join(root, 'a'), 'crash', 'Recovered');
  assert.equal(review.id, id); assert.equal(fs.existsSync(lock), false);
  fs.mkdirSync(lock); // Reaper death after unlinking the dead marker also recovers.
  patchReviewState(review.id, review.generation, [change(['draft'], 'recovered')]);
  assert.equal(readReview(review.id).state.draft, 'recovered');
});

test('lock acquisition retries when a competing owner retires before the contention check', (t) => {
  const root = setup(t), review = registerReview(path.join(root, 'a'), 'id', 'Review');
  const rename = fs.renameSync;
  let contended = false;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (!contended && String(to).endsWith('.lock')) {
      contended = true;
      // Windows reports EPERM for an occupied destination. The other owner may
      // have already retired it by the time this process handles that error.
      assert.equal(fs.existsSync(to), false);
      throw Object.assign(new Error('Lock destination was occupied'), { code: 'EPERM' });
    }
    return rename(from, to);
  });
  patchReviewState(review.id, review.generation, [change(['draft'], 'Retained after contention')]);
  assert.equal(contended, true);
  assert.equal(readReview(review.id).state.draft, 'Retained after contention');
  assert.deepEqual(fs.readdirSync(path.join(root, 'user-data', 'locks')), []);
});


test('a dead owner reaped at the deadline does not block acquiring the freed lock', (t) => {
  const root = setup(t), review = registerReview(path.join(root, 'a'), 'id', 'Review');
  const lock = path.join(root, 'user-data', 'locks', review.id + '.lock'), deadPid = 123456789;
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner-00000000-0000-4000-8000-000000000000.json'), JSON.stringify({ pid: deadPid }));
  const kill = process.kill;
  t.mock.method(process, 'kill', (pid, signal) => {
    if (pid === deadPid) throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
    return kill(pid, signal);
  });
  let now = Date.now();
  t.mock.method(Date, 'now', () => now += 10001);
  patchReviewState(review.id, review.generation, [change(['draft'], 'Saved after reaping')]);
  assert.equal(readReview(review.id).state.draft, 'Saved after reaping');
  assert.equal(fs.existsSync(lock), false);
});

test('records saved without a title or lifecycle fields stay readable and listed', (t) => {
  const root = setup(t);
  const review = registerReview(path.join(root, 'a'), 'legacy-id', 'Review');
  const file = path.join(reviewDirectory(review.id), 'review.json');
  const { title, completedAt, stateRevision, ...legacy } = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify(legacy));
  assert.equal(readReview(review.id).title, '');
  assert.equal(readReview(review.id).completedAt, null);
  assert.equal(readReview(review.id).stateRevision, 0);
  assert.deepEqual(listReviews().map((record) => record.id), [review.id]);
});

test('damaged viewer metadata counts as absent and keeps the review listed', (t) => {
  const root = setup(t);
  const review = registerReview(path.join(root, 'a'), 'viewer-id', 'Review');
  registerReview(path.join(root, 'b'), 'other-id', 'Other');
  const file = path.join(reviewDirectory(review.id), 'review.json');
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...record, viewer: { port: 1, processId: 2, viewerVersion: 'v' } }));
  assert.equal(readReview(review.id).viewer, undefined);
  assert.equal(listReviews().length, 2);
  const viewer = { port: 29180, processId: 2, viewerVersion: 'v', skillDirectory: root };
  fs.writeFileSync(file, JSON.stringify({ ...record, viewer }));
  assert.deepEqual(readReview(review.id).viewer, viewer);
  for (const port of [0, 70000, 1.5]) {
    fs.writeFileSync(file, JSON.stringify({ ...record, viewer: { ...viewer, port } }));
    assert.equal(readReview(review.id).viewer, undefined, `port ${port}`);
  }
});
