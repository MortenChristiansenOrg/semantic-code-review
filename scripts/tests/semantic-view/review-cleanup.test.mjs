import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import childProcess, { execFile, execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { registerReview, readReview, patchReviewState, reviewDirectory, reviewId, registeredReviews, setReviewCompleted, recordViewer, storeAttachment, resolveAttachment, inspectReviewStorage, deleteReviewData, cleanUnusedReviewFiles, reviewSessionUnavailable, reviewRetirementCheck, assertReviewContext, captureReviewContext, viewerLaunchCurrent } from '../../src/semantic-view.ts';
import { activeRef, archivingRef, ArtifactDraft, commitArtifact, readArtifact, replaceArtifactFileInGitDirectory } from '../../src/shared/artifact-store.ts';
import { newReviewId, removeOrphanedReviews, writeReviewId } from '../../src/shared/review-store.ts';
// Child processes import the same TypeScript sources.
const sourceLoader = ['--import', import.meta.resolve('tsx')];
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-cleanup-')), previous = process.env.SEMANTIC_FLOW_HOME;
  process.env.SEMANTIC_FLOW_HOME = path.join(root, 'data');
  t.after(() => { t.mock.restoreAll(); if (previous === undefined) delete process.env.SEMANTIC_FLOW_HOME; else process.env.SEMANTIC_FLOW_HOME = previous; fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); });
  for (const name of ['repo', 'other']) activate(path.join(root, name), 'same-id');
  const review = registerReview(path.join(root, 'repo'), 'same-id', 'Review'), other = registerReview(path.join(root, 'other'), 'same-id', 'Other');
  return { root, review, other };
}
const manifest = (implementationId) => `{"implementationId": ${JSON.stringify(implementationId)}}\n`;
/** Makes the implementation active in a repository at root, creating the repository if needed. */
function activate(root, implementationId) {
  if (!fs.existsSync(path.join(root, '.git'))) {
    fs.mkdirSync(root, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'Initial'], { cwd: root });
  }
  // The artifact is stored in the repository's Git refs.
  const draft = new ArtifactDraft(undefined); draft.write('manifest.json', manifest(implementationId));
  writeReviewId(draft, root, implementationId);
  commitArtifact(root, undefined, draft);
}
/** Makes a review look unused for longer than cleanup's grace period for missing repositories. */
function age(review, days = 31) {
  const file = path.join(reviewDirectory(review.id), 'review.json'), then = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const record = JSON.parse(fs.readFileSync(file, 'utf8')); record.updatedAt = then.toISOString();
  fs.writeFileSync(file, JSON.stringify(record)); fs.utimesSync(file, then, then);
}
/** Makes cleanup believe it first found the review's Git directory missing days ago. */
function missingFor(review, days) {
  const file = path.join(reviewDirectory(review.id), 'review.json'), record = JSON.parse(fs.readFileSync(file, 'utf8'));
  record.missingSince = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(record));
}
const reviewsFolder = () => path.join(process.env.SEMANTIC_FLOW_HOME, 'reviews');
const pendingFolder = (review) => path.join(reviewsFolder(), '.deleting-' + review.id);
const retiredMarker = (review) => path.join(reviewsFolder(), '.retired-' + review.id);
const storedReviewId = (root, implementationId) => JSON.parse(readArtifact(root, implementationId).read('review.json')).reviewId;
const retiredFolders = () => fs.readdirSync(path.join(process.env.SEMANTIC_FLOW_HOME, 'reviews')).filter((name) => !/^[a-z0-9-]+--[a-z0-9-]+--[a-f0-9]{64}$/.test(name));
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
  assert.equal(readArtifact(path.join(root, 'repo')).read('manifest.json').toString('utf8'), manifest('same-id'));
  assert.ok(fs.existsSync(resolveAttachment(other.id, otherFile.id).localPath));
  assert.deepEqual(deleteReviewData(review.id, review.generation, before.fingerprint), { deleted: true });
  assert.deepEqual(retiredFolders(), []);
  // The implementation got a fresh review ID, so the next review starts empty and the old ID is never used again.
  const reopened = registerReview(path.join(root, 'repo'), 'same-id', 'Fresh');
  assert.notEqual(reopened.id, review.id); assert.deepEqual(reopened.state, {});
  assert.equal(storedReviewId(path.join(root, 'repo'), 'same-id'), reopened.id);
  assert.equal(readReview(other.id).generation, other.generation);
  assert.deepEqual(deleteReviewData(review.id, review.generation, before.fingerprint), { deleted: true });
  assert.throws(() => patchReviewState(review.id, review.generation, [change('late', true)]), /deleted/);
  assert.equal(fs.existsSync(reviewDirectory(review.id)), false);
});

test('an open viewer of a deleted review sees it as unavailable', (t) => {
  const { root, review } = setup(t);
  const context = { reviewId: review.id, generation: review.generation, repositoryRoot: review.repositoryRoot, implementationId: review.implementationId };
  assert.equal(assertReviewContext(context).id, review.id);
  deleteReviewData(review.id, review.generation, preview(review).fingerprint);
  assert.throws(() => assertReviewContext(context), (error) => error.code === 'REVIEW_UNAVAILABLE');
  assert.equal(reviewSessionUnavailable(context), true);
  // Even a record restored in its place no longer matches the implementation's review.
  fs.mkdirSync(reviewDirectory(review.id), { recursive: true });
  fs.writeFileSync(path.join(reviewDirectory(review.id), 'review.json'), JSON.stringify(review));
  assert.throws(() => assertReviewContext(context), (error) => error.code === 'REVIEW_TARGET_UNAVAILABLE');
  assert.notEqual(reviewId(path.join(root, 'repo'), 'same-id'), review.id);
});

test('cleanup removes reviews whose repository has long been gone and keeps those whose implementation ended', (t) => {
  const { root, review, other } = setup(t);
  activate(path.join(root, 'archived'), 'archived-id');
  const archived = registerReview(path.join(root, 'archived'), 'archived-id', 'Archived');
  execFileSync('git', ['update-ref', '-d', 'refs/semantic-review/active/archived-id'], { cwd: path.join(root, 'archived') });
  assert.equal(readReview(review.id).gitCommonDir, fs.realpathSync(path.join(root, 'repo', '.git')));
  fs.rmSync(path.join(root, 'other'), { recursive: true });
  fs.mkdirSync(path.join(reviewsFolder(), '.deleted-00000000-0000-0000-0000-000000000000'));
  // The first cleanup that finds the Git directory missing records when.
  let listed = registeredReviews();
  assert.deepEqual(listed.map((entry) => entry.id).sort(), [archived.id, other.id, review.id].sort());
  assert.equal(listed.find((entry) => entry.id === other.id).available, false);
  assert.ok(Date.now() - Date.parse(readReview(other.id).missingSince) < 60_000);
  assert.equal(readReview(review.id).missingSince, undefined);
  // Folders of committed deletions are removed at once.
  assert.deepEqual(retiredFolders(), []);
  // A missing repository may be on a drive that is not mounted: the review stays for 30 days.
  missingFor(other, 29);
  listed = registeredReviews();
  assert.deepEqual(listed.map((entry) => entry.id).sort(), [archived.id, other.id, review.id].sort());
  missingFor(other, 31);
  listed = registeredReviews();
  assert.deepEqual(listed.map((entry) => entry.id).sort(), [archived.id, review.id].sort());
  assert.equal(listed.find((entry) => entry.id === archived.id).available, false);
  assert.equal(fs.existsSync(reviewDirectory(other.id)), false);
  assert.deepEqual(retiredFolders(), []);
  // Registering a review also cleans up.
  fs.rmSync(path.join(root, 'archived'), { recursive: true });
  registerReview(path.join(root, 'repo'), 'same-id', 'Review');
  assert.equal(typeof readReview(archived.id).missingSince, 'string');
  missingFor(archived, 31);
  registerReview(path.join(root, 'repo'), 'same-id', 'Review');
  assert.equal(fs.existsSync(reviewDirectory(archived.id)), false);
  assert.equal(readReview(review.id).generation, review.generation);
});

test('a long unused review whose repository just went missing stays for the whole grace period', (t) => {
  const { root, review } = setup(t), moved = path.join(root, 'moved');
  // Unused for a year, then its repository is moved, or its drive unmounted.
  age(review, 365);
  fs.renameSync(path.join(root, 'repo'), moved);
  registeredReviews();
  assert.equal(readReview(review.id).generation, review.generation);
  const since = readReview(review.id).missingSince;
  assert.ok(Date.now() - Date.parse(since) < 60_000);
  // Later cleanups keep the time it was first found missing.
  registeredReviews();
  assert.equal(readReview(review.id).missingSince, since);
  // Found again, by cleanup or by a command run from the repository, the grace period ends.
  fs.renameSync(moved, path.join(root, 'repo'));
  registeredReviews();
  assert.equal(readReview(review.id).missingSince, undefined);
  missingFor(review, 31);
  registerReview(path.join(root, 'repo'), 'same-id', 'Review');
  assert.equal(readReview(review.id).missingSince, undefined);
});

test('cleanup leaves a review alone when its Git directory cannot be checked or its lock is busy', (t) => {
  const { root, other } = setup(t), common = readReview(other.id).gitCommonDir;
  fs.rmSync(path.join(root, 'other'), { recursive: true });
  // Only a missing path counts as missing; a denied permission tells nothing.
  const stat = fs.statSync;
  const denied = t.mock.method(fs, 'statSync', (file, ...args) => {
    if (String(file) === common) throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    return stat(file, ...args);
  });
  missingFor(other, 365); age(other, 365);
  removeOrphanedReviews();
  assert.equal(readReview(other.id).generation, other.generation);
  denied.mock.restore();
  // Cleanup never waits for a busy review.
  const lock = path.join(process.env.SEMANTIC_FLOW_HOME, 'locks', other.id + '.lock');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner-00000000-0000-0000-0000-000000000001.json'), JSON.stringify({ pid: process.pid }));
  const started = Date.now();
  removeOrphanedReviews();
  assert.ok(Date.now() - started < 5000, 'cleanup waited for a busy review');
  assert.equal(readReview(other.id).generation, other.generation);
  fs.rmSync(lock, { recursive: true });
  removeOrphanedReviews();
  assert.equal(fs.existsSync(reviewDirectory(other.id)), false);
});

test('registering a repository that moved with its Git directory keeps its long unused review', (t) => {
  const { root, review } = setup(t), moved = path.join(root, 'moved');
  patchReviewState(review.id, review.generation, [change('comments', [{ mode: 'personal', body: 'Keep me' }])]);
  age(review, 365);
  fs.renameSync(path.join(root, 'repo'), moved);
  const registered = registerReview(moved, 'same-id', 'Review');
  assert.equal(registered.id, review.id);
  assert.equal(registered.generation, review.generation);
  assert.deepEqual(readReview(review.id).state.comments, [{ mode: 'personal', body: 'Keep me' }]);
  assert.equal(readReview(review.id).repositoryRoot, fs.realpathSync(moved));
  assert.equal(readReview(review.id).gitCommonDir, fs.realpathSync(path.join(moved, '.git')));
  registeredReviews();
  assert.equal(readReview(review.id).generation, review.generation);
});

test('deletion rejects an outdated preview and works after the recorded worktree is removed', (t) => {
  const { root } = setup(t), linked = path.join(root, 'linked');
  execFileSync('git', ['worktree', 'add', '-q', '--detach', linked], { cwd: path.join(root, 'repo') });
  activate(linked, 'linked-id');
  const review = registerReview(linked, 'linked-id', 'Linked'), before = preview(review);
  patchReviewState(review.id, review.generation, [change('comments', [{ body: 'New work' }])]);
  assert.throws(() => deleteReviewData(review.id, review.generation, before.fingerprint), /changed since/);
  fs.rmSync(linked, { recursive: true });
  assert.equal(registeredReviews().find((entry) => entry.id === review.id).available, false);
  assert.deepEqual(deleteReviewData(review.id, review.generation, preview(review).fingerprint), { deleted: true });
  // The repository's other worktree still has the implementation; it got a fresh review ID.
  assert.notEqual(storedReviewId(path.join(root, 'repo'), 'linked-id'), review.id);
});

test('deletion gives a bare repository a new review ID after its only worktree was removed', (t) => {
  const { root } = setup(t), bare = path.join(root, 'bare.git'), linked = path.join(root, 'bare-linked');
  execFileSync('git', ['clone', '-q', '--bare', path.join(root, 'repo'), bare]);
  execFileSync('git', ['worktree', 'add', '-q', '--detach', linked], { cwd: bare });
  activate(linked, 'bare-id');
  const review = registerReview(linked, 'bare-id', 'Bare');
  assert.equal(review.gitCommonDir, fs.realpathSync(bare));
  fs.rmSync(linked, { recursive: true });
  assert.deepEqual(deleteReviewData(review.id, review.generation, preview(review).fingerprint), { deleted: true });
  assert.notEqual(storedReviewId(bare, 'bare-id'), review.id);
  assert.equal(fs.existsSync(reviewDirectory(review.id)), false);
});

test('a deleted review stays deleted when its registration waited for the deletion', async (t) => {
  const { root, review } = setup(t), repo = path.join(root, 'repo'), ready = path.join(root, 'ready');
  const moduleUrl = new URL('../../src/semantic-view.ts', import.meta.url).href, storeUrl = new URL('../../src/shared/review-store.ts', import.meta.url).href;
  // The child takes the review's lock first and deletes the review while the registration below waits for it.
  const source = `import fs from 'node:fs'; import { deleteReviewData } from ${JSON.stringify(moduleUrl)}; import { withReviewLock } from ${JSON.stringify(storeUrl)};
    const [id, generation, fingerprint, ready] = process.argv.slice(1);
    withReviewLock(id, () => { fs.writeFileSync(ready, ''); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750); deleteReviewData(id, generation, fingerprint); });`;
  const deletion = promisify(execFile)(process.execPath, [...sourceLoader, '--input-type=module', '-e', source, review.id, review.generation, preview(review).fingerprint, ready]);
  while (!fs.existsSync(ready)) await new Promise((resolve) => setTimeout(resolve, 10));
  const registered = registerReview(repo, 'same-id', 'Review');
  await deletion;
  assert.notEqual(registered.id, review.id);
  assert.equal(storedReviewId(repo, 'same-id'), registered.id);
  assert.equal(fs.existsSync(reviewDirectory(review.id)), false);
  assert.throws(() => readReview(review.id), /deleted/);
});

test('a deletion whose new review ID cannot be stored moves the review back and changes nothing', (t) => {
  const { root, review } = setup(t), repo = path.join(root, 'repo'), live = reviewDirectory(review.id);
  const file = oldAttachment(review, 'kept');
  const bytes = fs.readFileSync(path.join(live, 'review.json'));
  // Git cannot move the implementation's ref while another process holds its lock file.
  const refLock = path.join(repo, '.git', 'refs', 'semantic-review', 'active', 'same-id.lock');
  fs.writeFileSync(refLock, '');
  assert.throws(() => deleteReviewData(review.id, review.generation, preview(review).fingerprint), /same-id/);
  assert.deepEqual(fs.readFileSync(path.join(live, 'review.json')), bytes);
  assert.ok(fs.existsSync(resolveAttachment(review.id, file.id).localPath));
  assert.deepEqual(retiredFolders(), []);
  assert.equal(storedReviewId(repo, 'same-id'), review.id);
  // The review is untouched, so its writers still work.
  patchReviewState(review.id, review.generation, [change('after', true)]);
  fs.rmSync(refLock);
  assert.deepEqual(deleteReviewData(review.id, review.generation, preview(review).fingerprint), { deleted: true });
  assert.notEqual(storedReviewId(repo, 'same-id'), review.id);
});

test('cleanup during a deletion that rolls back leaves the review intact', async (t) => {
  const { root, review } = setup(t), repo = path.join(root, 'repo');
  const file = oldAttachment(review, 'kept');
  const bytes = fs.readFileSync(path.join(reviewDirectory(review.id), 'review.json'));
  // Git waits for the implementation's ref lock, then fails, so the deletion rolls back.
  execFileSync('git', ['config', 'core.filesRefLockTimeout', '2000'], { cwd: repo });
  fs.writeFileSync(path.join(repo, '.git', 'refs', 'semantic-review', 'active', 'same-id.lock'), '');
  const moduleUrl = new URL('../../src/semantic-view.ts', import.meta.url).href;
  const source = `import { deleteReviewData } from ${JSON.stringify(moduleUrl)};
    try { deleteReviewData(...process.argv.slice(1)); console.log('deleted'); } catch (error) { console.log(error.message); }`;
  const deletion = promisify(execFile)(process.execPath, [...sourceLoader, '--input-type=module', '-e', source, review.id, review.generation, preview(review).fingerprint]);
  while (fs.existsSync(reviewDirectory(review.id))) await new Promise((resolve) => setTimeout(resolve, 10));
  // Cleanup runs while the folder is moved aside and the deletion may still roll back.
  registeredReviews();
  const { stdout } = await deletion;
  assert.match(stdout, /same-id/);
  assert.deepEqual(fs.readFileSync(path.join(reviewDirectory(review.id), 'review.json')), bytes);
  assert.ok(fs.existsSync(resolveAttachment(review.id, file.id).localPath));
  assert.equal(fs.existsSync(pendingFolder(review)), false);
  assert.equal(storedReviewId(repo, 'same-id'), review.id);
});

test('a deletion interrupted before it gave the implementation a new review ID is rolled back', (t) => {
  const { root, review } = setup(t), repo = path.join(root, 'repo');
  patchReviewState(review.id, review.generation, [change('comments', [{ mode: 'personal', body: 'Keep me' }])]);
  // A crash left the folder under its pending name while the implementation still
  // holds the ID, so the deletion did not commit: cleanup moves the folder back.
  fs.renameSync(reviewDirectory(review.id), pendingFolder(review));
  registeredReviews();
  assert.equal(fs.existsSync(pendingFolder(review)), false);
  assert.deepEqual(readReview(review.id).state.comments, [{ mode: 'personal', body: 'Keep me' }]);
  // So does registration, before anything else.
  fs.renameSync(reviewDirectory(review.id), pendingFolder(review));
  const registered = registerReview(repo, 'same-id', 'Review');
  assert.equal(registered.id, review.id);
  assert.equal(registered.generation, review.generation);
  assert.deepEqual(readReview(review.id).state.comments, [{ mode: 'personal', body: 'Keep me' }]);
  assert.equal(fs.existsSync(pendingFolder(review)), false);
  // So does a deletion, which then completes.
  const fingerprint = preview(review).fingerprint;
  fs.renameSync(reviewDirectory(review.id), pendingFolder(review));
  assert.deepEqual(deleteReviewData(review.id, review.generation, fingerprint), { deleted: true });
  assert.equal(fs.existsSync(pendingFolder(review)), false);
  assert.equal(fs.existsSync(reviewDirectory(review.id)), false);
  assert.notEqual(storedReviewId(repo, 'same-id'), review.id);
});

/** Gives the implementation a fresh review ID, as a deletion does before it completes. */
function rotateStoredReviewId(review) {
  assert.ok(replaceArtifactFileInGitDirectory(review.gitCommonDir, review.implementationId, 'review.json', () => Buffer.from(JSON.stringify({ reviewId: newReviewId('repo', review.implementationId) }))));
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
/** Moves the active artifact to an archiving claim, as an archive in progress does. */
function claimForArchive(repo, implementationId) {
  const snapshot = git(repo, 'rev-parse', activeRef(implementationId));
  git(repo, 'update-ref', archivingRef(implementationId), snapshot, '0'.repeat(40));
  git(repo, 'update-ref', '-d', activeRef(implementationId), snapshot);
  return snapshot;
}
/** Puts the snapshot back from the claim, as a failing archive does. */
function failArchive(repo, implementationId, snapshot) {
  git(repo, 'update-ref', activeRef(implementationId), snapshot, '0'.repeat(40));
  git(repo, 'update-ref', '-d', archivingRef(implementationId), snapshot);
}

test('a deletion interrupted after it gave the implementation a new review ID is completed, never moved back', (t) => {
  const { root, review } = setup(t), repo = path.join(root, 'repo');
  patchReviewState(review.id, review.generation, [change('comments', [{ mode: 'personal', body: 'Deleted' }])]);
  // A crash after the new ID was stored left the folder under its pending name.
  fs.renameSync(reviewDirectory(review.id), pendingFolder(review));
  rotateStoredReviewId(review);
  registeredReviews();
  assert.equal(fs.existsSync(pendingFolder(review)), false);
  assert.equal(fs.existsSync(reviewDirectory(review.id)), false);
  assert.deepEqual(retiredFolders(), []);
  // Registration does the same, and starts the new, empty review.
  const second = registerReview(repo, 'same-id', 'Second');
  fs.renameSync(reviewDirectory(second.id), pendingFolder(second));
  rotateStoredReviewId(second);
  const third = registerReview(repo, 'same-id', 'Third');
  assert.notEqual(third.id, second.id);
  assert.deepEqual(third.state, {});
  assert.equal(fs.existsSync(pendingFolder(second)), false);
  assert.equal(fs.existsSync(reviewDirectory(second.id)), false);
  // A missing implementation proves nothing, since the repository may have moved:
  // the folder stays pending until the implementation is found again.
  fs.renameSync(reviewDirectory(third.id), pendingFolder(third));
  const snapshot = git(repo, 'rev-parse', activeRef('same-id'));
  git(repo, 'update-ref', '-d', activeRef('same-id'));
  registeredReviews();
  assert.ok(fs.existsSync(pendingFolder(third)));
  assert.deepEqual(retiredFolders(), ['.deleting-' + third.id]);
  git(repo, 'update-ref', activeRef('same-id'), snapshot, '0'.repeat(40));
  registeredReviews();
  assert.equal(fs.existsSync(pendingFolder(third)), false);
  assert.equal(readReview(third.id).generation, third.generation);
});

test('an interrupted deletion stays pending while its repository cannot be reached or an archive claims its ID', (t) => {
  const { root, review } = setup(t), repo = path.join(root, 'repo'), away = path.join(root, 'away');
  fs.renameSync(reviewDirectory(review.id), pendingFolder(review));
  fs.renameSync(repo, away);
  registeredReviews();
  assert.ok(fs.existsSync(pendingFolder(review)));
  assert.throws(() => deleteReviewData(review.id, review.generation, 'any'), /interrupted/);
  assert.ok(fs.existsSync(pendingFolder(review)));
  fs.renameSync(away, repo);
  const snapshot = claimForArchive(repo, 'same-id');
  registeredReviews();
  assert.ok(fs.existsSync(pendingFolder(review)));
  // The archive fails and puts the snapshot back, which still holds the ID: the deletion did not commit.
  failArchive(repo, 'same-id', snapshot);
  registeredReviews();
  assert.equal(fs.existsSync(pendingFolder(review)), false);
  assert.equal(readReview(review.id).generation, review.generation);
});

test('a committed deletion whose folder cannot be renamed keeps it whole until cleanup completes it', (t) => {
  const { review } = setup(t), pending = pendingFolder(review), rename = fs.renameSync, remove = fs.rmSync;
  const file = oldAttachment(review, 'kept');
  const removed = [];
  const renaming = t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(from) === pending && path.basename(String(to)).startsWith('.deleted-')) throw Object.assign(new Error('File is open'), { code: 'EBUSY' });
    return rename(from, to);
  });
  const removing = t.mock.method(fs, 'rmSync', (target, options) => { removed.push(String(target)); return remove(target, options); });
  assert.deepEqual(deleteReviewData(review.id, review.generation, preview(review).fingerprint), { deleted: true });
  // Nothing is removed from a folder still under the review's own or pending name.
  assert.equal(removed.some((target) => target === pending || target.startsWith(pending + path.sep) || target.startsWith(reviewDirectory(review.id))), false);
  assert.ok(fs.existsSync(path.join(pending, 'attachments', file.id, 'content.bin')));
  renaming.mock.restore(); removing.mock.restore();
  registeredReviews();
  assert.equal(fs.existsSync(pending), false);
  assert.deepEqual(retiredFolders(), []);
});

test('a review deleted while an archive claims its implementation stays deleted when the archive fails', (t) => {
  const { root, review } = setup(t), repo = path.join(root, 'repo');
  const fingerprint = preview(review).fingerprint;
  const snapshot = claimForArchive(repo, 'same-id');
  assert.deepEqual(deleteReviewData(review.id, review.generation, fingerprint), { deleted: true });
  assert.equal(fs.existsSync(reviewDirectory(review.id)), false);
  // Replacement of the ID could not be established, so it is marked retired.
  assert.ok(fs.existsSync(retiredMarker(review)));
  registeredReviews();
  assert.ok(fs.existsSync(retiredMarker(review)));
  // The archive fails and puts back the snapshot, which still holds the old ID.
  failArchive(repo, 'same-id', snapshot);
  assert.equal(storedReviewId(repo, 'same-id'), review.id);
  const registered = registerReview(repo, 'same-id', 'Fresh');
  assert.notEqual(registered.id, review.id);
  assert.deepEqual(registered.state, {});
  assert.equal(storedReviewId(repo, 'same-id'), registered.id);
  assert.equal(fs.existsSync(retiredMarker(review)), false);
  assert.equal(fs.existsSync(reviewDirectory(review.id)), false);
});

test('a retired ID keeps its marker while an archive claims it', (t) => {
  const { root, review } = setup(t), repo = path.join(root, 'repo'), away = path.join(root, 'away');
  fs.renameSync(repo, away);
  assert.deepEqual(deleteReviewData(review.id, review.generation, preview(review).fingerprint), { deleted: true });
  assert.ok(fs.existsSync(retiredMarker(review)));
  fs.renameSync(away, repo);
  const snapshot = claimForArchive(repo, 'same-id');
  // Nothing can register the implementation while it is claimed, and the marker stays.
  assert.throws(() => registerReview(repo, 'same-id', 'Fresh'), /no longer active|being archived|No active/);
  assert.ok(fs.existsSync(retiredMarker(review)));
  failArchive(repo, 'same-id', snapshot);
  const registered = registerReview(repo, 'same-id', 'Fresh');
  assert.notEqual(registered.id, review.id);
  assert.equal(fs.existsSync(retiredMarker(review)), false);
});

test('an interrupted deletion is completed only when a reachable artifact holds another review ID', (t) => {
  const { root, review } = setup(t), repo = path.join(root, 'repo'), moved = path.join(root, 'moved');
  patchReviewState(review.id, review.generation, [change('comments', [{ mode: 'personal', body: 'Keep me' }])]);
  // A crash left the folder under its pending name, and then the repository moved.
  fs.renameSync(reviewDirectory(review.id), pendingFolder(review));
  fs.renameSync(repo, moved);
  // An unrelated repository at the recorded location has no such implementation:
  // that proves nothing, so cleanup leaves the folder pending.
  activate(repo, 'unrelated-id');
  registeredReviews();
  assert.ok(fs.existsSync(pendingFolder(review)));
  // Neither does one holding an implementation of the same ID under its own review
  // ID: registration from the moved repository, which it has just verified, decides.
  activate(repo, 'same-id');
  const registered = registerReview(moved, 'same-id', 'Review');
  assert.equal(registered.id, review.id);
  assert.equal(registered.generation, review.generation);
  assert.equal(registered.repositoryRoot, fs.realpathSync(moved));
  assert.deepEqual(registered.state.comments, [{ mode: 'personal', body: 'Keep me' }]);
  assert.equal(fs.existsSync(pendingFolder(review)), false);
});

test('a deletion that reads the refs during an archive rollback does not take the review ID for gone', (t) => {
  const { root, review } = setup(t), repo = path.join(root, 'repo');
  const fingerprint = preview(review).fingerprint;
  const snapshot = claimForArchive(repo, 'same-id');
  const spawn = childProcess.spawnSync;
  let torn = false;
  t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    if (!torn && command === 'git' && args.includes('for-each-ref') && args.includes(archivingRef('same-id'))) {
      // The archive fails while both refs are read: the active ref is read before
      // the rollback puts it back, the claim after the rollback removed it.
      torn = true;
      failArchive(repo, 'same-id', snapshot);
      const empty = Buffer.alloc(0);
      return { pid: 0, output: [null, empty, empty], stdout: empty, stderr: empty, status: 0, signal: null };
    }
    return spawn(command, args, options);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.deepEqual(deleteReviewData(review.id, review.generation, fingerprint), { deleted: true });
  assert.ok(torn);
  // The refs did not confirm the read, so the deletion looked again and replaced the ID.
  assert.notEqual(storedReviewId(repo, 'same-id'), review.id);
  const registered = registerReview(repo, 'same-id', 'Fresh');
  assert.notEqual(registered.id, review.id);
  assert.deepEqual(registered.state, {});
});

test('a committed deletion whose folder waits for cleanup does not block the fresh review of a retired ID', (t) => {
  const { root, review } = setup(t), repo = path.join(root, 'repo'), away = path.join(root, 'away');
  const pending = pendingFolder(review), rename = fs.renameSync, fingerprint = preview(review).fingerprint;
  const renaming = t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(from) === pending && path.basename(String(to)).startsWith('.deleted-')) throw Object.assign(new Error('File is open'), { code: 'EBUSY' });
    return rename(from, to);
  });
  // The repository cannot be reached, so the deletion marks the ID retired, and
  // its folder keeps the pending name since it cannot be renamed as deleted.
  fs.renameSync(repo, away);
  assert.deepEqual(deleteReviewData(review.id, review.generation, fingerprint), { deleted: true });
  assert.ok(fs.existsSync(retiredMarker(review)));
  assert.ok(fs.existsSync(pending));
  fs.renameSync(away, repo);
  const registered = registerReview(repo, 'same-id', 'Fresh');
  assert.notEqual(registered.id, review.id);
  assert.deepEqual(registered.state, {});
  assert.equal(storedReviewId(repo, 'same-id'), registered.id);
  assert.equal(fs.existsSync(retiredMarker(review)), false);
  // Cleanup completes the deletion once the folder can be renamed.
  assert.ok(fs.existsSync(pending));
  renaming.mock.restore();
  registeredReviews();
  assert.equal(fs.existsSync(pending), false);
  assert.deepEqual(retiredFolders(), []);
});

test('a deletion that found no snapshot holding the ID records that it committed until its folder is gone', (t) => {
  const { root, review } = setup(t), repo = path.join(root, 'repo');
  const pending = pendingFolder(review), rename = fs.renameSync, fingerprint = preview(review).fingerprint;
  git(repo, 'update-ref', '-d', activeRef('same-id'));
  const renaming = t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(from) === pending && path.basename(String(to)).startsWith('.deleted-')) throw Object.assign(new Error('File is open'), { code: 'EBUSY' });
    return rename(from, to);
  });
  assert.deepEqual(deleteReviewData(review.id, review.generation, fingerprint), { deleted: true });
  // A missing implementation proves nothing, so the mark is what lets cleanup complete it.
  assert.ok(fs.existsSync(retiredMarker(review)));
  renaming.mock.restore();
  registeredReviews();
  assert.equal(fs.existsSync(pending), false);
  // A deletion that removes its folder at once leaves no mark.
  const second = registerReview(path.join(root, 'other'), 'same-id', 'Other');
  git(path.join(root, 'other'), 'update-ref', '-d', activeRef('same-id'));
  assert.deepEqual(deleteReviewData(second.id, second.generation, preview(second).fingerprint), { deleted: true });
  assert.equal(fs.existsSync(retiredMarker(second)), false);
  assert.equal(fs.existsSync(pendingFolder(second)), false);
});

test('a deletion check never waits for a busy review lock', (t) => {
  const { review } = setup(t), context = captureReviewContext(review.id);
  const check = reviewRetirementCheck(context);
  deleteReviewData(review.id, review.generation, preview(review).fingerprint);
  // Another process holds the review's lock, as a deletion in progress would.
  const lock = path.join(process.env.SEMANTIC_FLOW_HOME, 'locks', review.id + '.lock');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner-00000000-0000-0000-0000-000000000001.json'), JSON.stringify({ pid: process.pid }));
  const started = Date.now();
  assert.equal(reviewSessionUnavailable(context), false);
  assert.equal(check(), false);
  assert.ok(Date.now() - started < 2000, 'a deletion check waited for a busy review lock');
  // Once the lock is free, the next check confirms the deletion.
  fs.rmSync(lock, { recursive: true });
  assert.equal(reviewSessionUnavailable(context), true);
  assert.equal(check(), true);
});

test('a viewer launch that read the review before another worktree was recorded is not current', (t) => {
  const { root } = setup(t), repo = path.join(root, 'repo'), linked = path.join(root, 'linked');
  git(repo, 'worktree', 'add', '-q', '--detach', linked);
  activate(linked, 'launch-id');
  const review = registerReview(linked, 'launch-id', 'Launch');
  const stale = captureReviewContext(review.id);
  assert.equal(viewerLaunchCurrent(stale), true);
  // Another launch records the main worktree once the linked one stops reaching the review.
  git(repo, 'worktree', 'remove', '--force', linked);
  assert.equal(registerReview(repo, 'launch-id', 'Launch').repositoryRoot, fs.realpathSync(repo));
  assert.equal(viewerLaunchCurrent(stale), false);
  assert.equal(viewerLaunchCurrent(captureReviewContext(review.id)), true);
});

test('deletion gives a new review ID through the recorded Git directory when bare repositories must be explicit', (t) => {
  const { root } = setup(t), bare = path.join(root, 'bare.git'), linked = path.join(root, 'bare-linked');
  execFileSync('git', ['clone', '-q', '--bare', path.join(root, 'repo'), bare]);
  execFileSync('git', ['worktree', 'add', '-q', '--detach', linked], { cwd: bare });
  activate(linked, 'bare-id');
  const review = registerReview(linked, 'bare-id', 'Bare');
  fs.rmSync(linked, { recursive: true });
  const saved = { ...process.env };
  t.after(() => { for (const key of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; });
  Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.bareRepository', GIT_CONFIG_VALUE_0: 'explicit' });
  // Git refuses to discover the bare repository from its directory.
  assert.throws(() => execFileSync('git', ['rev-parse', '--git-dir'], { cwd: bare, stdio: 'pipe' }));
  assert.deepEqual(deleteReviewData(review.id, review.generation, preview(review).fingerprint), { deleted: true });
  assert.equal(fs.existsSync(reviewDirectory(review.id)), false);
  delete process.env.GIT_CONFIG_COUNT;
  assert.notEqual(storedReviewId(bare, 'bare-id'), review.id);
});

test('a review deleted while its repository is unreachable gets a new ID when the repository is used again', (t) => {
  const { root, review } = setup(t), repo = path.join(root, 'repo'), away = path.join(root, 'away');
  fs.renameSync(repo, away);
  assert.deepEqual(deleteReviewData(review.id, review.generation, preview(review).fingerprint), { deleted: true });
  assert.equal(fs.existsSync(reviewDirectory(review.id)), false);
  // The artifact still holds the old ID, which is marked retired; cleanup keeps the marker.
  assert.equal(storedReviewId(away, 'same-id'), review.id);
  assert.ok(fs.existsSync(retiredMarker(review)));
  registeredReviews();
  assert.ok(fs.existsSync(retiredMarker(review)));
  assert.deepEqual(retiredFolders(), ['.retired-' + review.id]);
  // Registration stores a fresh ID first, so the deleted review is never recreated.
  fs.renameSync(away, repo);
  const registered = registerReview(repo, 'same-id', 'Fresh');
  assert.notEqual(registered.id, review.id);
  assert.deepEqual(registered.state, {});
  assert.equal(storedReviewId(repo, 'same-id'), registered.id);
  assert.equal(fs.existsSync(retiredMarker(review)), false);
  assert.equal(fs.existsSync(reviewDirectory(review.id)), false);
  assert.deepEqual(retiredFolders(), []);
});

test('an open viewer keeps working when a deletion of its review rolls back', (t) => {
  const { review } = setup(t), context = { reviewId: review.id, generation: review.generation, repositoryRoot: review.repositoryRoot, implementationId: review.implementationId };
  const check = reviewRetirementCheck(context);
  // While a deletion has moved the folder aside, it may still roll back.
  fs.renameSync(reviewDirectory(review.id), pendingFolder(review));
  assert.equal(reviewSessionUnavailable(context), false);
  assert.equal(check(), false);
  const late = reviewRetirementCheck(context);
  fs.renameSync(pendingFolder(review), reviewDirectory(review.id));
  assert.equal(reviewSessionUnavailable(context), false);
  assert.equal(check(), false);
  assert.equal(late(), false);
  patchReviewState(review.id, review.generation, [change('after', true)]);
  deleteReviewData(review.id, review.generation, preview(review).fingerprint);
  assert.equal(reviewSessionUnavailable(context), true);
  assert.equal(check(), true);
  assert.equal(late(), true);
});

test('writers of a deleted review fail and do not recreate its folder', (t) => {
  const { review } = setup(t);
  deleteReviewData(review.id, review.generation, preview(review).fingerprint);
  assert.throws(() => patchReviewState(review.id, review.generation, [change('late', true)]), /deleted/);
  assert.throws(() => storeAttachment(review.id, review.generation, 'late', 'text/plain', Buffer.from('late')), /deleted/);
  assert.throws(() => setReviewCompleted(review.id, review.generation, true, null), /deleted/);
  assert.throws(() => recordViewer(review.id, review.generation, { port: 1, processId: process.pid, viewerVersion: 'v', skillDirectory: '/' }), /deleted/);
  assert.equal(fs.existsSync(reviewDirectory(review.id)), false);
});

test('files that cannot be removed yet do not keep a deleted review and a later cleanup removes them', (t) => {
  const { root, review } = setup(t), before = preview(review), remove = fs.rmSync;
  const mock = t.mock.method(fs, 'rmSync', (file, options) => {
    if (path.basename(String(file)).startsWith('.deleted-')) throw Object.assign(new Error('File is open'), { code: 'EBUSY' });
    return remove(file, options);
  });
  assert.deepEqual(deleteReviewData(review.id, review.generation, before.fingerprint), { deleted: true });
  assert.throws(() => readReview(review.id), /deleted/);
  assert.equal(retiredFolders().length, 1);
  assert.equal(registeredReviews().some((entry) => entry.id === review.id), false);
  assert.throws(() => storeAttachment(review.id, review.generation, 'late', 'text/plain', Buffer.alloc(0)), /deleted/);
  assert.notEqual(registerReview(path.join(root, 'repo'), 'same-id', 'Fresh').id, review.id);
  mock.mock.restore();
  registeredReviews();
  assert.deepEqual(retiredFolders(), []);
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
  const moduleUrl = new URL('../../src/semantic-view.ts', import.meta.url).href;
  const source = `import { patchReviewState } from ${JSON.stringify(moduleUrl)}; try { patchReviewState(process.argv[1], process.argv[2], JSON.parse(process.argv[3])); } catch {} `;
  const writers = Array.from({ length: 8 }, (_, i) => promisify(execFile)(process.execPath, [...sourceLoader, '--input-type=module', '-e', source, review.id, review.generation, JSON.stringify([change('draft' + i, 'late')])]));
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


test('retirement retries an unknown startup identity and still rejects replaced generations', (t) => {
  const { review } = setup(t), context = { reviewId: review.id, generation: review.generation, repositoryRoot: review.repositoryRoot, implementationId: review.implementationId };
  const stat = fs.statSync;
  let denied = true;
  const mock = t.mock.method(fs, 'statSync', (file, ...args) => {
    if (denied && String(file) === reviewDirectory(review.id)) throw Object.assign(new Error('Temporarily denied'), { code: 'EACCES' });
    return stat(file, ...args);
  });
  const check = reviewRetirementCheck(context), unknown = reviewRetirementCheck(context);
  assert.equal(check(), false); denied = false;
  assert.equal(check(), false); // Successful recovery establishes the same live session.
  denied = true; assert.equal(check(), false); denied = false;
  deleteReviewData(review.id, review.generation, preview(review).fingerprint);
  assert.equal(check(), true);
  registerReview(review.repositoryRoot, review.implementationId, review.title);
  assert.equal(unknown(), true); // Never accept a replacement as the unknown baseline.
  mock.mock.restore();
});


test('a review folder that cannot be moved reports its path, keeps its files and allows retry', (t) => {
  const { root, review, other } = setup(t), original = preview(review), live = reviewDirectory(review.id);
  const bytes = fs.readFileSync(path.join(live, 'review.json'));
  const rename = fs.renameSync;
  const locked = t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(from) === live) throw Object.assign(new Error('File is open'), { code: 'EBUSY', path: live });
    return rename(from, to);
  });
  assert.throws(() => deleteReviewData(review.id, review.generation, original.fingerprint), (error) => {
    assert.ok(error.message.includes(JSON.stringify(live)));
    assert.match(error.message, /EBUSY/);
    assert.match(error.message, /retry deletion/);
    assert.match(error.message, /Do not delete review files manually/);
    return true;
  });
  assert.deepEqual(fs.readFileSync(path.join(live, 'review.json')), bytes);
  assert.equal(readReview(other.id).generation, other.generation);
  // Nothing changed: the implementation keeps this review, which stays available.
  assert.equal(storedReviewId(path.join(root, 'repo'), 'same-id'), review.id);
  assert.equal(registeredReviews().find((entry) => entry.id === review.id).available, true);
  locked.mock.restore();
  assert.deepEqual(deleteReviewData(review.id, review.generation, preview(review).fingerprint), { deleted: true });
  assert.equal(fs.existsSync(live), false);
});

test('unused cleanup reports the retired file and leaves saved state unchanged until retry', (t) => {
  const { review } = setup(t), unused = oldAttachment(review, 'unused');
  patchReviewState(review.id, review.generation, [change('comments', [{ mode: 'personal', body: 'Keep me' }])]);
  const saved = readReview(review.id).state, original = preview(review), remove = fs.rmSync;
  let blocked;
  const mock = t.mock.method(fs, 'rmSync', (file, options) => {
    if (String(file).includes(path.sep + '.cleanup' + path.sep)) {
      blocked = path.join(file, 'content.bin');
      throw Object.assign(new Error('File is open'), { code: 'EPERM', path: blocked });
    }
    return remove(file, options);
  });
  const result = cleanUnusedReviewFiles(review.id, review.generation, original.fingerprint);
  assert.equal(result.failures.length, 1);
  assert.ok(result.failures[0].includes(JSON.stringify(blocked)));
  assert.match(result.failures[0], /Clean unused files again/);
  assert.deepEqual(readReview(review.id).state, saved);
  assert.throws(() => resolveAttachment(review.id, unused.id));
  mock.mock.restore();
  assert.ok(cleanUnusedReviewFiles(review.id, review.generation, preview(review).fingerprint).reclaimedBytes > 0);
  assert.deepEqual(readReview(review.id).state, saved);
});


test('review lock contention identifies the lock location and recorded owner PID', (t) => {
  const { review } = setup(t);
  const lock = path.join(process.env.SEMANTIC_FLOW_HOME, 'locks', review.id + '.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner-00000000-0000-0000-0000-000000000001.json'), JSON.stringify({ pid: process.pid }));
  let now = Date.now();
  const clock = t.mock.method(Date, 'now', () => now += 10001);
  assert.throws(() => preview(review), error => {
    assert.ok(error.message.includes(JSON.stringify(lock)));
    assert.ok(error.message.includes(`PID ${process.pid}`));
    assert.match(error.message, /then retry/);
    assert.match(error.message, /Do not delete lock or review files manually/);
    return true;
  });
  clock.mock.restore();
  fs.rmSync(lock, { recursive: true });
  assert.equal(preview(review).review.id, review.id);
});


test('a file locked during preflight reports recovery without retiring the review', (t) => {
  const { root, review } = setup(t), original = preview(review), read = fs.readFileSync;
  const file = path.join(reviewDirectory(review.id), 'review.json');
  const mock = t.mock.method(fs, 'readFileSync', (target, ...args) => {
    if (String(target) === file) throw Object.assign(new Error('Locked during preflight'), { code: 'EACCES', path: file });
    return read(target, ...args);
  });
  assert.throws(() => deleteReviewData(review.id, review.generation, original.fingerprint), error => {
    assert.ok(error.message.includes(JSON.stringify(file)));
    assert.match(error.message, /Refresh details, then retry deletion/);
    return true;
  });
  mock.mock.restore();
  assert.equal(readReview(review.id).generation, review.generation);
  assert.equal(storedReviewId(path.join(root, 'repo'), 'same-id'), review.id);
  assert.deepEqual(deleteReviewData(review.id, review.generation, original.fingerprint), { deleted: true });
});
