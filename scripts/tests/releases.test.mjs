import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import net from 'node:net';
import { ZipFile } from 'yazl';
import { nextVersion, compareVersions, parseVersion, RELEASE_REPOSITORY, assetName, isPrerelease, normalVersion } from '../src/shared/release-version.ts';
import { MINIMUM_NODE_MAJOR, sha256, skillFiles, unpackDistribution, validateDistribution } from '../src/shared/distribution.ts';
import { selectRelease, upgradeNotes, githubBytes, listReleases, newestVersion } from '../src/shared/release-client.ts';
import { validateNotes, releaseBody, smokeTestInstallation, bumpArguments } from '../src/release.ts';
import { probeViewer, stopViewerAndWait } from '../src/shared/viewer-lifecycle.ts';
import { viewerFetch, viewerKey } from './helpers/viewer-client.mjs';
import { createRepository, scriptsDirectory, initializeImplementation } from './helpers/repository.mjs';

const api = `https://api.github.com/repos/${RELEASE_REPOSITORY}`;
function release(version, overrides = {}) {
  const name = assetName(version);
  return { id: 1, tag_name: `v${version}`, draft: false, prerelease: false, body: `## Breaking changes\nUpgrade instructions for ${version}.`,
    html_url: `https://github.com/${RELEASE_REPOSITORY}/releases/tag/v${version}`,
    assets: [{ name, url: `${api}/releases/assets/1` }, { name: `${name}.sha256`, url: `${api}/releases/assets/2` }], ...overrides };
}
function temp(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'semantic-release-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function distribution(version = '0.2.0', extraFiles = {}) {
  const root = path.resolve(scriptsDirectory, '..');
  const files = new Map(skillFiles(root).map((name) => [name, fs.readFileSync(path.join(root, name))]));
  // A null content removes a file the current skill has.
  for (const [name, content] of Object.entries(extraFiles)) content === null ? files.delete(name) : files.set(name, Buffer.from(content));
  files.set('VERSION', Buffer.from(`${version}\n`));
  files.delete('RELEASE.json');
  const metadata = { repository: RELEASE_REPOSITORY, sourceCommit: 'a'.repeat(40), version, minimumNodeMajor: MINIMUM_NODE_MAJOR,
    files: Object.fromEntries([...files].map(([name, bytes]) => [name, sha256(bytes)])) };
  files.set('RELEASE.json', Buffer.from(JSON.stringify(metadata)));
  return files;
}
async function archive(files, options = {}) {
  const zip = new ZipFile(), chunks = [];
  zip.outputStream.on('data', (chunk) => chunks.push(chunk));
  const finished = once(zip.outputStream, 'end');
  for (const [name, bytes] of files) zip.addBuffer(bytes, `semantic-flow/${name}`, options);
  zip.end();
  await finished;
  return Buffer.concat(chunks);
}

test('version policy keeps all 0.x changes experimental and applies highest selected impact after 1.0', () => {
  for (const kind of ['breaking', 'feature', 'fix']) assert.equal(nextVersion('0.2.9', kind), '0.3.0');
  assert.equal(nextVersion('1.2.3', 'breaking'), '2.0.0');
  assert.equal(nextVersion('1.2.3', 'feature'), '1.3.0');
  assert.equal(nextVersion('1.2.3', 'fix'), '1.2.4');
  assert.equal(nextVersion('0.9.0', 'feature', { stable: true }), '1.0.0');
  assert.throws(() => nextVersion('1.0.0', 'fix', { stable: true }), /only applies before/);
  assert.throws(() => nextVersion('0.2.0', 'none'), /no releasable/);
  for (const invalid of ['01.0.0', 'v0.2.0', '0.2', '1.0.9007199254740992']) assert.throws(() => parseVersion(invalid));
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
});

test('release selection ignores previews, drafts, and publication order; missing latest assets fail closed', () => {
  const versions = [release('0.9.0'), release('0.10.0'), release('1.0.0', { draft: true }), release('2.0.0', { prerelease: true }), release('0.1.0')];
  assert.equal(selectRelease(versions).tag_name, 'v0.10.0');
  assert.equal(selectRelease(versions, { requested: '0.9.0' }).tag_name, 'v0.9.0');
  assert.throws(() => selectRelease([]), /No published/);
  assert.throws(() => selectRelease(versions, { requested: '1.0.0' }), /No published/);
  assert.throws(() => selectRelease([...versions, release('0.11.0', { assets: [] })]), /missing/);
  const notes = upgradeNotes(versions, '0.1.0', '0.10.0');
  assert.match(notes, /Upgrade instructions for 0.9.0/);
  assert.match(notes, /Upgrade instructions for 0.10.0/);
  assert.doesNotMatch(notes, /Upgrade instructions for 0.1.0/);
});

test('prerelease versions order before their normal release and accept only the -rc.N form', () => {
  const ordered = ['0.14.0', '0.15.0-rc.1', '0.15.0-rc.2', '0.15.0-rc.10', '0.15.0', '0.15.1-rc.1', '1.0.0-rc.1', '1.0.0'];
  for (let i = 0; i < ordered.length; i++) {
    assert.equal(compareVersions(ordered[i], ordered[i]), 0);
    for (let j = i + 1; j < ordered.length; j++) {
      assert.equal(compareVersions(ordered[i], ordered[j]), -1, `${ordered[i]} < ${ordered[j]}`);
      assert.equal(compareVersions(ordered[j], ordered[i]), 1, `${ordered[j]} > ${ordered[i]}`);
    }
  }
  assert.deepEqual(parseVersion('0.15.0-rc.2'), { major: 0, minor: 15, patch: 0, prerelease: 2 });
  assert.equal(isPrerelease('0.15.0-rc.1'), true);
  assert.equal(isPrerelease('0.15.0'), false);
  assert.equal(normalVersion('0.15.0-rc.2'), '0.15.0');
  assert.equal(assetName('0.15.0-rc.1'), 'semantic-flow-0.15.0-rc.1.zip');
  for (const invalid of ['0.15.0-rc', '0.15.0-rc.0', '0.15.0-rc.01', '0.15.0-beta.1', '0.15.0-RC.1', '0.15.0-rc.1.1', '0.15.0-rc1', '0.15.0+build', '0.15.0-rc.9007199254740992']) {
    assert.throws(() => parseVersion(invalid), undefined, invalid);
  }
});

test('the release helper bumps through prereleases to their normal release', () => {
  // 0.x: one minor increment, whatever the change; the prerelease keeps its normal version.
  assert.equal(nextVersion('0.14.0', 'feature', { prerelease: true }), '0.15.0-rc.1');
  assert.equal(nextVersion('0.15.0-rc.1', 'breaking', { prerelease: true }), '0.15.0-rc.2');
  assert.equal(nextVersion('0.15.0-rc.2', 'fix'), '0.15.0');
  assert.equal(nextVersion('0.15.0', 'fix', { prerelease: true }), '0.16.0-rc.1');
  assert.throws(() => nextVersion('0.15.0-rc.1', 'none'), /no releasable/);
  assert.throws(() => nextVersion('0.15.0-rc.1', 'none', { prerelease: true }), /no releasable/);
  // From 1.0: a change needing a larger increment than the prerelease already has moves it.
  assert.equal(nextVersion('1.2.3', 'fix', { prerelease: true }), '1.2.4-rc.1');
  assert.equal(nextVersion('1.2.4-rc.1', 'fix', { prerelease: true }), '1.2.4-rc.2');
  assert.equal(nextVersion('1.2.4-rc.2', 'fix'), '1.2.4');
  assert.equal(nextVersion('1.2.4-rc.2', 'feature', { prerelease: true }), '1.3.0-rc.1');
  assert.equal(nextVersion('1.3.0-rc.1', 'feature'), '1.3.0');
  assert.equal(nextVersion('1.3.0-rc.1', 'fix', { prerelease: true }), '1.3.0-rc.2');
  assert.equal(nextVersion('1.3.0-rc.1', 'breaking'), '2.0.0');
  assert.equal(nextVersion('1.3.0-rc.1', 'breaking', { prerelease: true }), '2.0.0-rc.1');
  assert.equal(nextVersion('2.0.0-rc.1', 'breaking', { prerelease: true }), '2.0.0-rc.2');
  assert.equal(nextVersion('2.0.0-rc.2', 'fix'), '2.0.0');
  // --stable targets 1.0.0 while the current version is below it, including its prereleases.
  assert.equal(nextVersion('0.15.0', 'feature', { stable: true, prerelease: true }), '1.0.0-rc.1');
  assert.equal(nextVersion('0.15.0-rc.2', 'feature', { stable: true, prerelease: true }), '1.0.0-rc.1');
  assert.equal(nextVersion('1.0.0-rc.1', 'feature', { stable: true, prerelease: true }), '1.0.0-rc.2');
  assert.equal(nextVersion('1.0.0-rc.2', 'feature', { stable: true }), '1.0.0');
  assert.equal(nextVersion('1.0.0-rc.2', 'fix'), '1.0.0');
  assert.throws(() => nextVersion('1.0.0', 'feature', { stable: true, prerelease: true }), /only applies before/);
  assert.throws(() => nextVersion('0.15.0-rc.1', 'none', { stable: true, prerelease: true }), /no releasable/);
  assert.throws(() => nextVersion('0.15.0', 'none', { stable: true }), /no releasable/);
});

test('the release helper command accepts --prerelease and --stable in either order', () => {
  assert.deepEqual(bumpArguments(['feature']), { change: 'feature', stable: false, prerelease: false });
  assert.deepEqual(bumpArguments(['feature', '--prerelease']), { change: 'feature', stable: false, prerelease: true });
  assert.deepEqual(bumpArguments(['feature', '--prerelease', '--stable']), { change: 'feature', stable: true, prerelease: true });
  assert.deepEqual(bumpArguments(['feature', '--stable', '--prerelease']), { change: 'feature', stable: true, prerelease: true });
  for (const invalid of [[], ['feature', '--prerelease', '--prerelease'], ['feature', '--beta'], ['feature', '-p']]) assert.throws(() => bumpArguments(invalid), /Usage/);
});

test('release selection includes prereleases only on request or by explicit version', () => {
  const pre = (version, overrides = {}) => release(version, { prerelease: true, ...overrides });
  const versions = [release('0.13.0'), pre('0.15.0-rc.1'), release('0.14.0'), pre('0.15.0-rc.2'), release('0.15.0-rc.3', { draft: true, prerelease: true })];
  assert.equal(selectRelease(versions).tag_name, 'v0.14.0');
  assert.equal(selectRelease(versions, { prerelease: true }).tag_name, 'v0.15.0-rc.2');
  assert.equal(selectRelease(versions, { requested: '0.15.0-rc.1' }).tag_name, 'v0.15.0-rc.1');
  assert.equal(selectRelease(versions, { requested: '0.14.0', prerelease: true }).tag_name, 'v0.14.0');
  assert.throws(() => selectRelease(versions, { requested: '0.15.0-rc.3' }), /No published release v0.15.0-rc.3/);
  // The normal release outranks its prereleases on both paths.
  const released = [...versions, release('0.15.0')];
  assert.equal(selectRelease(released).tag_name, 'v0.15.0');
  assert.equal(selectRelease(released, { prerelease: true }).tag_name, 'v0.15.0');
  // A broken newest release on the chosen path is reported, never skipped.
  const broken = [...versions, pre('0.15.0-rc.4', { assets: [] })];
  assert.throws(() => selectRelease(broken, { prerelease: true }), /missing/);
  assert.equal(selectRelease(broken).tag_name, 'v0.14.0');
  assert.equal(newestVersion(versions), '0.14.0');
  assert.equal(newestVersion(versions, true), '0.15.0-rc.2');
  assert.equal(newestVersion([pre('0.15.0-rc.1')]), null);
  // A release whose GitHub flag disagrees with its version is never installed, and
  // when it is the newest on the chosen path, it is reported rather than skipped.
  const flaggedNormal = [...versions, release('0.16.0', { prerelease: true })];
  assert.equal(selectRelease(flaggedNormal).tag_name, 'v0.14.0', 'plain update ignores GitHub prereleases');
  assert.throws(() => selectRelease(flaggedNormal, { prerelease: true }), /marked as a GitHub prerelease, but its version is a normal release/);
  assert.throws(() => selectRelease(flaggedNormal, { requested: '0.16.0' }), /marked as a GitHub prerelease, but its version is a normal release/);
  const unflaggedPrerelease = [...versions, release('0.17.0-rc.1')];
  assert.throws(() => selectRelease(unflaggedPrerelease), /not marked as a GitHub prerelease/);
  assert.throws(() => selectRelease(unflaggedPrerelease, { prerelease: true }), /not marked as a GitHub prerelease/);
  assert.throws(() => selectRelease(unflaggedPrerelease, { requested: '0.17.0-rc.1' }), /not marked as a GitHub prerelease/);
  assert.throws(() => selectRelease([...versions, release('0.18.0', { prerelease: null })]), /no valid prerelease flag/);
  assert.doesNotMatch(upgradeNotes([...unflaggedPrerelease, release('0.18.0', { prerelease: null })], '0.13.0', '0.18.0'), /0.17.0-rc.1|0.18.0/);
});

test('update notes cover the releases on the path and skip prereleases a shown normal release covers', () => {
  const pre = (version) => release(version, { prerelease: true });
  const releases = [release('0.13.0'), release('0.14.0'), pre('0.15.0-rc.1'), pre('0.15.0-rc.2'), release('0.15.0'), pre('0.16.0-rc.1'), pre('0.16.0-rc.2')];
  const shown = (previous, target) => [...upgradeNotes(releases, previous, target).matchAll(/Upgrade instructions for (\S+)\./g)].map((match) => match[1]);
  assert.deepEqual(shown('0.13.0', '0.15.0'), ['0.14.0', '0.15.0']);
  assert.deepEqual(shown('0.15.0-rc.1', '0.15.0'), ['0.15.0']);
  assert.deepEqual(shown('0.14.0', '0.15.0-rc.2'), ['0.15.0-rc.1', '0.15.0-rc.2']);
  assert.deepEqual(shown('0.15.0-rc.1', '0.15.0-rc.2'), ['0.15.0-rc.2']);
  assert.deepEqual(shown('0.14.0', '0.16.0-rc.2'), ['0.15.0', '0.16.0-rc.1', '0.16.0-rc.2']);
  assert.deepEqual(shown('0.15.0', '0.15.0-rc.2'), ['0.15.0-rc.2']);
  assert.deepEqual(shown('unversioned', '0.15.0'), ['0.13.0', '0.14.0', '0.15.0']);
});

test('prerelease notes are validated like other notes and must say they are a prerelease', () => {
  const notes = '# v0.15.0-rc.1 — 2026-11-21\n\n## Overview\nA prerelease of 0.15.0.\n\n## Breaking changes\nNone.\n\n## Updating\nRun `/semantic-flow update -p`. Releases are experimental.\n';
  validateNotes(notes, '0.15.0-rc.1');
  assert.equal(releaseBody(notes, '0.15.0-rc.1'), notes.split('\n').slice(2).join('\n'));
  assert.throws(() => validateNotes(notes, '0.15.0'), /matching version/);
  const unsaid = notes.replace('A prerelease of 0.15.0.', 'A test version.');
  assert.throws(() => validateNotes(unsaid, '0.15.0-rc.1'), /say that this is a prerelease/);
  // A template comment or a later section does not count; the Overview must say it.
  assert.throws(() => validateNotes(unsaid.replace('## Overview\nA test version.', '<!-- Say in the Overview that it is a prerelease. -->\n## Overview\nA test version.'), '0.15.0-rc.1'), /say that this is a prerelease/);
  assert.throws(() => validateNotes(unsaid.replace('A test version.', 'A test version. [Details](https://example.invalid/prerelease)'), '0.15.0-rc.1'), /say that this is a prerelease/);
  validateNotes(notes.replace('A prerelease of 0.15.0.', 'A [prerelease](https://example.invalid/notes) of 0.15.0.'), '0.15.0-rc.1');
  assert.throws(() => validateNotes(unsaid.replace('Releases are experimental.', 'Releases are experimental; this is a prerelease.'), '0.15.0-rc.1'), /say that this is a prerelease/);
});

test('published release body omits only the source title and retains every notes section', () => {
  const notes = fs.readFileSync(new URL('../../releases/0.2.0.md', import.meta.url), 'utf8');
  const body = releaseBody(notes, '0.2.0');
  assert.equal(body, notes.split('\n').slice(2).join('\n'));
  assert.match(body, /^## Overview\n/);
  assert.doesNotMatch(body, /^# v/m);
  for (const heading of ['Overview', 'Breaking changes', 'Improvements', 'Bug fixes', 'Updating', 'Known issues']) {
    assert.ok(body.includes(`## ${heading}\n`));
  }
  assert.throws(() => releaseBody(notes, '0.3.0'));
});

test('release notes require matching version and meaningful required sections', () => {
  const notes = fs.readFileSync(new URL('../../releases/0.2.0.md', import.meta.url), 'utf8');
  validateNotes(notes, '0.2.0');
  assert.throws(() => validateNotes(notes, '0.3.0'));
  assert.throws(() => validateNotes(notes.replace('## Updating', '## Missing'), '0.2.0'));
  assert.throws(() => validateNotes('# v0.2.0 — 2026-09-09\n\n## Overview\nTODO\n', '0.2.0'));
});

test('actual archive installs complete CLI without a source checkout and reports release provenance', async (t) => {
  const root = temp(t), destination = path.join(root, 'semantic-flow');
  await unpackDistribution(await archive(distribution()), destination, '0.2.0');
  const result = spawnSync(process.execPath, [path.join(destination, 'scripts/semantic-flow.mjs'), 'version', '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).sourceCommit, 'a'.repeat(40));
  assert.equal(JSON.parse(result.stdout).skillVersion, '0.2.0');
  assert.ok(fs.existsSync(path.join(destination, 'viewer/app.js')));
  assert.deepEqual(fs.readdirSync(path.join(destination, 'scripts')).filter((file) => file.endsWith('.mjs')), ['semantic-flow.mjs']);
  // The packaging smoke test runs every command group of the installed copy.
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  smokeTestInstallation(destination, workspace, '0.2.0', 'a'.repeat(40));
  assert.throws(() => smokeTestInstallation(destination, workspace, '0.3.0', 'a'.repeat(40)), /incorrect release provenance/);
  const pending = ['commands/report.md'];
  const visited = new Set();
  while (pending.length) {
    const relative = pending.pop();
    if (visited.has(relative)) continue;
    visited.add(relative);
    const file = path.resolve(destination, relative);
    assert.ok(file.startsWith(`${destination}${path.sep}`), `Report reference escapes installation: ${relative}`);
    const content = fs.readFileSync(file, 'utf8');
    for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const link = match[1].split('#')[0];
      if (!link || /^[a-z]+:/i.test(link)) continue;
      pending.push(path.relative(destination, path.resolve(path.dirname(file), link)));
    }
  }
  assert.ok(visited.has(path.join('assets', 'bug-report.md')));
  assert.ok(visited.has(path.join('references', 'report', 'source-repair.md')));

});

test('archive validation rejects wrong versions, missing files, changed contents, incompatible runtime, traversal, duplicates, and symlinks', async (t) => {
  const root = temp(t);
  const original = distribution();
  assert.throws(() => validateDistribution(original, '0.3.0'), /does not match/);
  assert.throws(() => validateDistribution(original, '0.2.0', 18), /requires Node/);
  // A script the page loads must ship with it; older pages load no start script.
  assert.throws(() => validateDistribution(distribution('0.2.0', { 'viewer/boot.js': null }), '0.2.0'), /missing viewer\/boot\.js/);
  const olderPage = '<script src="implementation-data.js"></script>\n<script src="app.js"></script>\n';
  validateDistribution(distribution('0.2.0', { 'viewer/boot.js': null, 'viewer/index.html': olderPage }), '0.2.0');
  // The script is found whatever the order and quoting of its attributes.
  const reordered = '<div id="app"></div>\n<script defer src="boot.js"></script>\n';
  assert.throws(() => validateDistribution(distribution('0.2.0', { 'viewer/boot.js': null, 'viewer/index.html': reordered }), '0.2.0'), /missing viewer\/boot\.js/);
  const quoted = '<script title="a > b" defer src="boot.js"></script>\n';
  assert.throws(() => validateDistribution(distribution('0.2.0', { 'viewer/boot.js': null, 'viewer/index.html': quoted }), '0.2.0'), /missing viewer\/boot\.js/);
  assert.throws(() => validateDistribution(original, '0.2.0', MINIMUM_NODE_MAJOR - 1), new RegExp(`requires Node\\.js ${MINIMUM_NODE_MAJOR} or newer`));
  for (const mutate of [
    (files) => files.delete('viewer/app.js'),
    (files) => files.set('scripts/semantic-flow.mjs', Buffer.from('tampered')),
    (files) => files.set('extra.txt', Buffer.from('extra')),
  ]) {
    const files = new Map(original); mutate(files);
    await assert.rejects(unpackDistribution(await archive(files), path.join(root, 'bad'), '0.2.0'));
    assert.equal(fs.existsSync(path.join(root, 'bad')), false);
  }
  const symlink = await archive(new Map([['link', Buffer.from('../outside')]]), { mode: 0o120777 });
  await assert.rejects(unpackDistribution(symlink, path.join(root, 'bad'), '0.2.0'), /Unsafe archive/);
  const safe = await archive(new Map([['aa', Buffer.from('bad')]]));
  const traversal = Buffer.from(safe.toString('latin1').replaceAll('semantic-flow/aa', 'semantic-flow/..'), 'latin1');
  await assert.rejects(unpackDistribution(traversal, path.join(root, 'bad'), '0.2.0'));
  const duplicates = await archive(new Map([['VERSION', Buffer.from('x')], ['version', Buffer.from('x')]]));
  await assert.rejects(unpackDistribution(duplicates, path.join(root, 'bad'), '0.2.0'), /Duplicate/);
  assert.equal(fs.existsSync(path.join(root, 'bad')), false);
});

test('validated release metadata keeps the checksum of every file', () => {
  const files = distribution();
  const metadata = JSON.parse(files.get('RELEASE.json').toString());
  files.delete('RELEASE.json');
  files.set('__proto__', Buffer.from('root file'));
  metadata.files = Object.fromEntries([...files].map(([name, bytes]) => [name, sha256(bytes)]));
  files.set('RELEASE.json', Buffer.from(JSON.stringify(metadata)));
  const verified = validateDistribution(files, '0.2.0').files;
  assert.ok(Object.hasOwn(verified, '__proto__'));
  assert.equal(verified['__proto__'], sha256(Buffer.from('root file')));
});

test('GitHub client paginates and reports network, auth, and size errors without exposing credentials', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let calls = 0;
  globalThis.fetch = async () => new Response(JSON.stringify(++calls === 1 ? Array.from({ length: 100 }, () => release('0.1.0')) : [release('0.2.0')]));
  assert.equal((await listReleases()).length, 101);
  // Only GitHub's own booleans count: a missing draft flag is a draft and a malformed prerelease flag is none.
  globalThis.fetch = async () => new Response(JSON.stringify([{ ...release('0.2.0'), draft: undefined }, { ...release('0.3.0'), prerelease: 'false' }]));
  const [unknownDraft, malformed] = await listReleases();
  assert.equal(unknownDraft.draft, true);
  assert.equal(malformed.prerelease, null);
  globalThis.fetch = async () => new Response('no', { status: 403 });
  await assert.rejects(githubBytes(`${api}/releases`, 100), /HTTP 403/);
  globalThis.fetch = async () => { throw new Error('offline'); };
  await assert.rejects(githubBytes(`${api}/releases`, 100), /check your connection/);
  globalThis.fetch = async () => new Response('oversized');
  await assert.rejects(githubBytes(`${api}/releases`, 2), /too large/);
  await assert.rejects(githubBytes('https://example.com/token', 10), /Unexpected/);
});

async function updateFixture(t, options = {}) {
  const root = temp(t), repository = createRepository(t);
  const installed = path.join(root, 'installed');
  fs.cpSync(path.resolve(scriptsDirectory, '..'), installed, { recursive: true });
  fs.writeFileSync(path.join(installed, 'VERSION'), `${options.previous || '0.1.0'}\n`);
  const version = options.version || '0.2.0';
  const zip = await archive(distribution(version, options.files));
  fs.writeFileSync(path.join(root, 'asset.zip'), options.corrupt ? Buffer.from('corrupt') : zip);
  const responses = options.releases || [release('0.2.0'), release('0.1.5')];
  if (options.missing) responses[0].assets = [];
  fs.writeFileSync(path.join(root, 'responses.json'), JSON.stringify(responses));
  const preload = path.join(root, 'fetch.mjs');
  fs.writeFileSync(preload, `
import fs from 'node:fs';
const original = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (!String(url).startsWith(${JSON.stringify(api)})) return original(url, options);
  if (String(url).includes('/assets/1')) return new Response(fs.readFileSync(${JSON.stringify(path.join(root, 'asset.zip'))}));
  if (String(url).includes('/assets/2')) return new Response(${JSON.stringify(`${sha256(zip)}  ${assetName(version)}\n`)});
  return new Response(fs.readFileSync(${JSON.stringify(path.join(root, 'responses.json'))}));
};
${options.failBackupDeletion ? `const remove = fs.rmSync; fs.rmSync = (target, ...rest) => { if (String(target).includes('.semantic-flow-backup-')) { remove(target + '/VERSION'); throw Object.assign(new Error('EBUSY: resource busy or locked, rmdir'), { code: 'EBUSY' }); } return remove(target, ...rest); };` : ''}
${options.failReplacement ? `const rename = fs.renameSync; fs.renameSync = (from, to) => { if (String(from).includes('.semantic-flow-update-')) throw new Error('Injected replacement failure'); return rename(from, to); };` : ''}
`);
  const cli = path.join(installed, 'scripts/semantic-flow.mjs');
  async function run(args = [], env = {}, cwd = repository.root) {
    const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, cli, 'update', ...args], {
      cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    const [status] = await once(child, 'close');
    return { status, stdout, stderr };
  }
  return { root, repository, installed, cli, run };
}

test('release update replaces an installation outside Git', async (t) => {
  const fixture = await updateFixture(t);
  const result = await fixture.run([], {}, fixture.root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Updated semantic-flow 0.1.0 -> 0.2.0/);
  assert.equal(fs.readFileSync(path.join(fixture.installed, 'VERSION'), 'utf8'), '0.2.0\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.installed, 'RELEASE.json'), 'utf8')).sourceCommit, 'a'.repeat(40));
});

test('release update handles skipped versions, official same-version transition, current installs, and explicit recovery', async (t) => {
  const fixture = await updateFixture(t);
  const original = fixture.repository.read('README.md');
  const result = await fixture.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Upgrade instructions for 0.1.5/);
  assert.match(result.stdout, /Updated semantic-flow 0.1.0 -> 0.2.0/);
  assert.equal(fixture.repository.read('README.md'), original);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.installed, 'RELEASE.json'), 'utf8')).sourceCommit, 'a'.repeat(40));
  const current = await fixture.run();
  assert.equal(current.status, 0, current.stderr);
  assert.match(current.stdout, /already current/);
  fs.writeFileSync(path.join(fixture.installed, 'VERSION'), '0.3.0\n');
  assert.notEqual((await fixture.run()).status, 0);
  assert.notEqual((await fixture.run(['--allow-downgrade'])).status, 0);
  const recovery = await fixture.run(['--version', '0.2.0', '--allow-downgrade']);
  assert.equal(recovery.status, 0, recovery.stderr);
  fs.rmSync(path.join(fixture.installed, 'RELEASE.json'));
  assert.match((await fixture.run()).stdout, /Updated semantic-flow 0.2.0 -> 0.2.0/);
});

test('plain update leaves a prerelease ahead of every normal release and moves it to its normal release', async (t) => {
  const pre = (version) => release(version, { prerelease: true });
  const ahead = await updateFixture(t, { previous: '0.15.0-rc.2', version: '0.14.0', releases: [release('0.14.0'), pre('0.15.0-rc.1'), pre('0.15.0-rc.2')] });
  const unchanged = await ahead.run();
  assert.equal(unchanged.status, 0, unchanged.stderr);
  assert.match(unchanged.stdout, /0\.15\.0-rc\.2 is a prerelease, newer than the latest release 0\.14\.0; nothing was changed\. Run update --prerelease to get later prereleases\./);
  assert.equal(fs.readFileSync(path.join(ahead.installed, 'VERSION'), 'utf8'), '0.15.0-rc.2\n');
  // Nothing is checked about older releases it will not install.
  const brokenOlder = await updateFixture(t, { previous: '0.15.0-rc.2', releases: [release('0.14.0', { assets: [] }), pre('0.15.0-rc.2')] });
  const kept = await brokenOlder.run();
  assert.equal(kept.status, 0, kept.stderr);
  assert.match(kept.stdout, /nothing was changed/);
  const onlyPrereleases = await updateFixture(t, { previous: '0.15.0-rc.2', releases: [pre('0.15.0-rc.1'), pre('0.15.0-rc.2')] });
  const none = await onlyPrereleases.run();
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stdout, /0\.15\.0-rc\.2 is a prerelease, newer than every release; nothing was changed/);
  // A normal installation newer than the latest release still fails.
  fs.writeFileSync(path.join(ahead.installed, 'VERSION'), '0.15.0\n');
  assert.match((await ahead.run()).stderr, /Installed 0.15.0 is newer than 0.14.0/);

  const released = await updateFixture(t, { previous: '0.15.0-rc.1', version: '0.15.0', releases: [release('0.14.0'), pre('0.15.0-rc.1'), pre('0.15.0-rc.2'), release('0.15.0'), pre('0.16.0-rc.1')] });
  const result = await released.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Updated semantic-flow 0.15.0-rc.1 -> 0.15.0/);
  assert.match(result.stdout, /Upgrade instructions for 0.15.0\./);
  assert.doesNotMatch(result.stdout, /Upgrade instructions for 0.15.0-rc/);
  assert.doesNotMatch(result.stdout, /0.16.0-rc/);
  assert.equal(fs.readFileSync(path.join(released.installed, 'VERSION'), 'utf8'), '0.15.0\n');
});

test('update --prerelease and an explicit prerelease version install a prerelease; downgrades still need permission', async (t) => {
  const pre = (version) => release(version, { prerelease: true });
  const releases = [release('0.13.0'), release('0.14.0'), pre('0.15.0-rc.1'), pre('0.15.0-rc.2')];
  const fixture = await updateFixture(t, { previous: '0.13.0', version: '0.15.0-rc.2', releases });
  const opted = await fixture.run(['--prerelease']);
  assert.equal(opted.status, 0, opted.stderr);
  assert.match(opted.stdout, /Updated semantic-flow 0.13.0 -> 0.15.0-rc.2/);
  assert.deepEqual([...opted.stdout.matchAll(/Upgrade instructions for (\S+)\./g)].map((match) => match[1]), ['0.14.0', '0.15.0-rc.1', '0.15.0-rc.2']);
  assert.match(opted.stdout, /Release notes: https:\/\/github.com\/.*\/releases\/tag\/v0.15.0-rc.2/);
  assert.equal(fs.readFileSync(path.join(fixture.installed, 'VERSION'), 'utf8'), '0.15.0-rc.2\n');
  assert.match((await fixture.run(['--prerelease'])).stdout, /already current/);
  // An explicit version needs no --prerelease.
  const explicit = await updateFixture(t, { previous: '0.14.0', version: '0.15.0-rc.2', releases });
  const chosen = await explicit.run(['--version', '0.15.0-rc.2']);
  assert.equal(chosen.status, 0, chosen.stderr);
  assert.match(chosen.stdout, /Updated semantic-flow 0.14.0 -> 0.15.0-rc.2/);
  // Going from a normal release to a prerelease of it is a downgrade.
  const downgrade = await updateFixture(t, { previous: '0.15.0', version: '0.15.0-rc.2', releases: [...releases, release('0.15.0')] });
  const refused = await downgrade.run(['--version', '0.15.0-rc.2']);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Installed 0.15.0 is newer than 0.15.0-rc.2/);
  assert.equal(fs.readFileSync(path.join(downgrade.installed, 'VERSION'), 'utf8'), '0.15.0\n');
  const allowed = await downgrade.run(['--version', '0.15.0-rc.2', '--allow-downgrade']);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stdout, /Updated semantic-flow 0.15.0 -> 0.15.0-rc.2/);
  const source = await downgrade.run(['--prerelease', '--source', downgrade.root]);
  assert.notEqual(source.status, 0);
  assert.match(source.stderr, /--source cannot be combined with release version options/);
});

for (const options of [{ corrupt: true }, { missing: true }, { failReplacement: true }]) {
  test(`failed release update preserves installation: ${Object.keys(options)[0]}`, async (t) => {
    const fixture = await updateFixture(t, options);
    const before = new Map(skillFiles(fixture.installed).map((name) => [name, sha256(fs.readFileSync(path.join(fixture.installed, name)))]));
    const result = await fixture.run();
    assert.notEqual(result.status, 0);
    for (const [name, digest] of before) assert.equal(sha256(fs.readFileSync(path.join(fixture.installed, name))), digest);
  });
}

test('release update keeps the new installation when the old one cannot be deleted', async (t) => {
  const fixture = await updateFixture(t, { failBackupDeletion: true });
  const result = await fixture.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Updated semantic-flow 0.1.0 -> 0.2.0/);
  assert.equal(fs.readFileSync(path.join(fixture.installed, 'VERSION'), 'utf8'), '0.2.0\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.installed, 'RELEASE.json'), 'utf8')).sourceCommit, 'a'.repeat(40));
  // The partly deleted previous installation is left and reported.
  const [leftover] = fs.readdirSync(path.dirname(fixture.installed)).filter((name) => name.startsWith('.semantic-flow-backup-'));
  assert.ok(leftover);
  assert.ok(result.stderr.includes(path.join(path.dirname(fixture.installed), leftover)), result.stderr);
});

test('release update restarts the matching viewer and preserves repository artifacts', async (t) => {
  let port;
  t.after(async () => {
    if (port) { const viewer = await probeViewer(port, { key: viewerKey(port) }); if (viewer) await stopViewerAndWait(viewer, port); }
  });
  const fixture = await updateFixture(t);
  initializeImplementation(fixture.repository);
  const beforeArtifact = fixture.repository.artifact.read('manifest.json');
  const server = net.createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  port = server.address().port; server.close(); await once(server, 'close');
  const env = { SEMANTIC_VIEW_PORT: String(port), SEMANTIC_VIEW_NO_OPEN: '1' };
  const launch = spawnSync(process.execPath, [fixture.cli, 'review'], { cwd: fixture.repository.root, env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.equal(launch.status, 0, launch.stderr);
  const before = await viewerFetch(`http://127.0.0.1:${port}/api/whoami`).then((r) => r.json());
  const result = await fixture.run([], env);
  assert.equal(result.status, 0, result.stderr);
  const after = await viewerFetch(`http://127.0.0.1:${port}/api/whoami`).then((r) => r.json());
  assert.notEqual(before.processId, after.processId);
  assert.equal(after.skillDirectory, fixture.installed);
  assert.equal(beforeArtifact, fixture.repository.artifact.read('manifest.json'));
});

test('release downgrade restarts the viewer with the executable the older release ships', async (t) => {
  let port;
  t.after(async () => {
    if (port) { const viewer = await probeViewer(port, { key: viewerKey(port) }); if (viewer) await stopViewerAndWait(viewer, port); }
  });
  // Releases before the single executable started their viewer with `semantic-view.mjs review <path>`.
  const olderViewer = `import fs from 'node:fs';
fs.writeFileSync(process.env.SEMANTIC_FLOW_TEST_VIEWER_ARGS, JSON.stringify(process.argv.slice(2)));
process.send({ type: 'ready', url: 'http://127.0.0.1:1/', repositoryRoot: process.argv[3], processId: process.pid, implementation: { stageCount: 0, fileCount: 0 } }, () => process.disconnect());
`;
  // Releases before viewer access control have no start script and load the review data by script.
  const olderPage = '<!doctype html>\n<div id="app"></div>\n<script src="implementation-data.js"></script>\n<script src="markdown.js"></script>\n<script src="app.js"></script>\n';
  const fixture = await updateFixture(t, { previous: '0.3.0', files: { 'scripts/semantic-view.mjs': olderViewer, 'viewer/index.html': olderPage, 'viewer/boot.js': null } });
  initializeImplementation(fixture.repository);
  const server = net.createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  port = server.address().port; server.close(); await once(server, 'close');
  const env = { SEMANTIC_VIEW_PORT: String(port), SEMANTIC_VIEW_NO_OPEN: '1' };
  const launch = spawnSync(process.execPath, [fixture.cli, 'review'], { cwd: fixture.repository.root, env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.equal(launch.status, 0, launch.stderr);
  const viewerArgs = path.join(fixture.root, 'viewer-args.json');
  const result = await fixture.run(['--version', '0.2.0', '--allow-downgrade'], { ...env, SEMANTIC_FLOW_TEST_VIEWER_ARGS: viewerArgs });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Updated semantic-flow 0.3.0 -> 0.2.0/);
  const [command, worktree, ...rest] = JSON.parse(fs.readFileSync(viewerArgs, 'utf8'));
  assert.equal(command, 'review');
  assert.equal(fs.realpathSync.native(worktree), fs.realpathSync.native(fixture.repository.root));
  assert.deepEqual(rest, []);
});

test('a viewer file left over from an older release does not start the viewer', async (t) => {
  let port;
  t.after(async () => {
    if (port) { const viewer = await probeViewer(port, { key: viewerKey(port) }); if (viewer) await stopViewerAndWait(viewer, port); }
  });
  const fixture = await updateFixture(t);
  // Copying a single-executable release over a four-executable folder keeps the old viewer file.
  const leftover = path.join(fixture.root, 'leftover-args.json');
  fs.writeFileSync(path.join(fixture.installed, 'scripts', 'semantic-view.mjs'),
    `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(leftover)}, '[]'); process.exit(1);\n`);
  const files = Object.fromEntries(skillFiles(fixture.installed).filter((name) => name !== 'RELEASE.json' && name !== 'scripts/semantic-view.mjs').map((name) => [name, 'x']));
  fs.writeFileSync(path.join(fixture.installed, 'RELEASE.json'), JSON.stringify({ repository: RELEASE_REPOSITORY, sourceCommit: 'a'.repeat(40), version: '0.1.0', minimumNodeMajor: 20, files }));
  initializeImplementation(fixture.repository);
  const server = net.createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  port = server.address().port; server.close(); await once(server, 'close');
  const launch = spawnSync(process.execPath, [fixture.cli, 'review'], { cwd: fixture.repository.root, env: { ...process.env, SEMANTIC_VIEW_PORT: String(port), SEMANTIC_VIEW_NO_OPEN: '1' }, encoding: 'utf8' });
  assert.equal(launch.status, 0, launch.stderr);
  assert.match(launch.stdout, /Semantic review viewer: /);
  assert.equal(fs.existsSync(leftover), false);
});

test('publication rehearses draft upload/download, retries failures, and protects published versions and latest selection', async (t) => {
  const { publishRelease } = await import('../src/release.ts');
  const root = temp(t), notesFile = new URL('../../releases/0.2.0.md', import.meta.url);
  const artifact = { version: '0.2.0', sourceCommit: 'a'.repeat(40), archive: path.join(root, 'semantic-flow-0.2.0.zip'), checksum: path.join(root, 'semantic-flow-0.2.0.zip.sha256') };
  fs.writeFileSync(artifact.archive, await archive(distribution()));
  fs.writeFileSync(artifact.checksum, `${sha256(fs.readFileSync(artifact.archive))}  semantic-flow-0.2.0.zip\n`);
  let state = null, corrupt = true, corruptBody = false, latest, wrongCommit = false;
  const calls = [];
  const github = (...args) => {
    calls.push(args);
    if (args[0] === 'api' && args[1].includes('/git/ref/')) return JSON.stringify({ object: { type: 'tag', sha: 'b'.repeat(40) } });
    if (args[0] === 'api' && args[1].includes('/git/tags/')) return JSON.stringify({ object: { type: 'commit', sha: wrongCommit ? 'c'.repeat(40) : artifact.sourceCommit } });
    if (args[0] === 'api') return JSON.stringify([[...(state ? [state] : []), release('0.3.0')]]);
    if (args[1] === 'create') { state = release('0.2.0', { draft: true, prerelease: args.includes('--prerelease=true'), body: fs.readFileSync(args[args.indexOf('--notes-file') + 1], 'utf8') }); return ''; }
    if (args[1] === 'edit' && args.includes('--notes-file')) state.body = fs.readFileSync(args[args.indexOf('--notes-file') + 1], 'utf8');
    if (args[1] === 'upload') { assert.equal(state.draft, true); return ''; }
    if (args[1] === 'download') {
      const destination = args[args.indexOf('--dir') + 1];
      for (const file of [artifact.archive, artifact.checksum]) fs.copyFileSync(file, path.join(destination, path.basename(file)));
      if (corrupt) fs.appendFileSync(path.join(destination, path.basename(artifact.archive)), 'bad');
      return '';
    }
    if (args[1] === 'view') return JSON.stringify({ body: corruptBody ? fs.readFileSync(notesFile, 'utf8') : state.body, isDraft: state.draft, isPrerelease: state.prerelease, url: state.html_url });
    if (args[1] === 'edit') {
      if (args.includes('--draft=false')) { state.draft = false; latest = args.find((arg) => arg.startsWith('--latest=')); }
      return '';
    }
    throw new Error(`Unexpected command ${args}`);
  };
  await assert.rejects(publishRelease(artifact, notesFile, github), /Uploaded release bytes differ/);
  assert.equal(state.draft, true);
  corrupt = false;
  corruptBody = true;
  await assert.rejects(publishRelease(artifact, notesFile, github), /Draft release notes do not match/);
  assert.equal(state.draft, true);
  corruptBody = false;
  state.body = 'stale draft notes';
  assert.equal(await publishRelease(artifact, notesFile, github), state.html_url);
  assert.equal(state.body, releaseBody(fs.readFileSync(notesFile, 'utf8'), '0.2.0'));
  assert.equal(latest, '--latest=false');
  assert.equal(calls.filter((args) => args[1] === 'create').length, 1);
  const uploads = calls.filter((args) => args[1] === 'upload').length;
  await assert.rejects(publishRelease(artifact, notesFile, github), /already published/);
  assert.equal(calls.filter((args) => args[1] === 'upload').length, uploads);
  wrongCommit = true;
  await assert.rejects(publishRelease(artifact, notesFile, github), /Remote release tag/);
});

async function publicationFixture(root, version) {
  const name = assetName(version);
  const notesFile = path.join(root, `${version}.md`);
  fs.writeFileSync(notesFile, `# v${version} — 2026-11-21\n\n## Overview\nA test version of 0.15.0 (a prerelease or not).\n\n## Breaking changes\nNone.\n\n## Updating\nRun \`/semantic-flow update -p\`. Releases are experimental.\n`);
  const artifact = { version, sourceCommit: 'a'.repeat(40), archive: path.join(root, name), checksum: path.join(root, `${name}.sha256`) };
  fs.writeFileSync(artifact.archive, await archive(distribution(version)));
  fs.writeFileSync(artifact.checksum, `${sha256(fs.readFileSync(artifact.archive))}  ${name}\n`);
  return { artifact, notesFile };
}

/** A GitHub that keeps one release of `version` and lists it with `published`;
 * with `ignoreFlag` it never applies the prerelease flag it is given. */
function fakeGithub(version, published, artifact, options = {}) {
  const fake = { state: null, created: [], publishArgs: null };
  fake.call = (...args) => {
    if (args[0] === 'api' && args[1].includes('/git/ref/')) return JSON.stringify({ object: { type: 'commit', sha: artifact.sourceCommit } });
    if (args[0] === 'api') return JSON.stringify([[...(fake.state ? [fake.state] : []), ...published]]);
    const flag = args.find((arg) => arg.startsWith('--prerelease='));
    const notes = () => fs.readFileSync(args[args.indexOf('--notes-file') + 1], 'utf8');
    if (args[1] === 'create') { fake.created.push(args); fake.state = release(version, { draft: true, prerelease: false, body: notes() }); }
    if ((args[1] === 'create' || args[1] === 'edit') && flag && !options.ignoreFlag) fake.state.prerelease = flag === '--prerelease=true';
    if (args[1] === 'create') return '';
    if (args[1] === 'edit' && args.includes('--notes-file')) { fake.state.body = notes(); return ''; }
    if (args[1] === 'upload') return '';
    if (args[1] === 'download') {
      for (const file of [artifact.archive, artifact.checksum]) fs.copyFileSync(file, path.join(args[args.indexOf('--dir') + 1], path.basename(file)));
      return '';
    }
    if (args[1] === 'view') return JSON.stringify({ body: fake.state.body, isDraft: fake.state.draft, isPrerelease: fake.state.prerelease, url: fake.state.html_url });
    if (args[1] === 'edit' && args.includes('--draft=false')) { fake.publishArgs = args; fake.state.draft = false; return ''; }
    throw new Error(`Unexpected command ${args}`);
  };
  return fake;
}

test('publication marks a prerelease version as a GitHub prerelease and never as latest', async (t) => {
  const { publishRelease } = await import('../src/release.ts');
  const root = temp(t);
  const { artifact, notesFile } = await publicationFixture(root, '0.15.0-rc.1');
  // A draft that GitHub did not mark as a prerelease is never published.
  const ignored = fakeGithub('0.15.0-rc.1', [release('0.14.0')], artifact, { ignoreFlag: true });
  await assert.rejects(publishRelease(artifact, notesFile, ignored.call), /not marked as a prerelease/);
  assert.equal(ignored.state.draft, true);
  assert.equal(ignored.publishArgs, null);
  const github = fakeGithub('0.15.0-rc.1', [release('0.14.0')], artifact);
  assert.equal(await publishRelease(artifact, notesFile, github.call), github.state.html_url);
  assert.ok(github.created[0].includes('--prerelease=true'), github.created[0].join(' '));
  assert.equal(github.state.prerelease, true);
  assert.ok(github.publishArgs.includes('--latest=false'), github.publishArgs.join(' '));
  assert.ok(github.publishArgs.includes('--prerelease=true'), github.publishArgs.join(' '));
  await assert.rejects(publishRelease(artifact, notesFile, github.call), /already published/);
  // A retried draft gets the flag again.
  const retried = fakeGithub('0.15.0-rc.1', [], artifact);
  retried.state = release('0.15.0-rc.1', { draft: true, prerelease: false, body: 'stale' });
  await publishRelease(artifact, notesFile, retried.call);
  assert.equal(retried.created.length, 0);
  assert.equal(retried.state.prerelease, true);
  assert.ok(retried.publishArgs.includes('--latest=false'));
});

test('publication never marks a normal version as a prerelease and makes it latest above prereleases', async (t) => {
  const { publishRelease } = await import('../src/release.ts');
  const root = temp(t);
  const { artifact, notesFile } = await publicationFixture(root, '0.15.0');
  const published = [release('0.14.0'), release('0.15.0-rc.1', { prerelease: true }), release('0.16.0-rc.1', { prerelease: true }), release('0.17.0-rc.1')];
  const github = fakeGithub('0.15.0', published, artifact);
  await publishRelease(artifact, notesFile, github.call);
  assert.ok(github.created[0].includes('--prerelease=false'), github.created[0].join(' '));
  assert.equal(github.state.prerelease, false);
  assert.ok(github.publishArgs.includes('--latest=true'), github.publishArgs.join(' '));
  assert.ok(github.publishArgs.includes('--prerelease=false'), github.publishArgs.join(' '));
  const stuck = fakeGithub('0.15.0', [], artifact);
  stuck.state = release('0.15.0', { draft: true, prerelease: true, body: 'stale' });
  const ignoring = fakeGithub('0.15.0', [], artifact, { ignoreFlag: true });
  ignoring.state = stuck.state;
  await assert.rejects(publishRelease(artifact, notesFile, ignoring.call), /is marked as a prerelease, but its version is a normal release/);
});
