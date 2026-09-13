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
import { nextVersion, compareVersions, parseVersion, RELEASE_REPOSITORY, assetName } from '../src/shared/release-version.ts';
import { sha256, skillFiles, unpackDistribution, validateDistribution } from '../src/shared/distribution.ts';
import { selectRelease, upgradeNotes, githubBytes, listReleases } from '../src/shared/release-client.ts';
import { validateNotes, releaseBody } from '../src/release.ts';
import { probeViewer, stopViewerAndWait } from '../src/shared/viewer-lifecycle.ts';
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
function distribution(version = '0.2.0') {
  const root = path.resolve(scriptsDirectory, '..');
  const files = new Map(skillFiles(root).map((name) => [name, fs.readFileSync(path.join(root, name))]));
  files.set('VERSION', Buffer.from(`${version}\n`));
  files.delete('RELEASE.json');
  const metadata = { repository: RELEASE_REPOSITORY, sourceCommit: 'a'.repeat(40), version, minimumNodeMajor: 20,
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
  assert.equal(nextVersion('0.9.0', 'feature', true), '1.0.0');
  assert.throws(() => nextVersion('1.0.0', 'fix', true), /only applies before/);
  assert.throws(() => nextVersion('0.2.0', 'none'), /no releasable/);
  for (const invalid of ['01.0.0', 'v0.2.0', '0.2', '1.0.0-rc.1', '1.0.9007199254740992']) assert.throws(() => parseVersion(invalid));
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
});

test('release selection ignores previews, drafts, and publication order; missing latest assets fail closed', () => {
  const versions = [release('0.9.0'), release('0.10.0'), release('1.0.0', { draft: true }), release('2.0.0', { prerelease: true }), release('0.1.0')];
  assert.equal(selectRelease(versions).tag_name, 'v0.10.0');
  assert.equal(selectRelease(versions, '0.9.0').tag_name, 'v0.9.0');
  assert.throws(() => selectRelease([]), /No published/);
  assert.throws(() => selectRelease(versions, '1.0.0'), /No published/);
  assert.throws(() => selectRelease([...versions, release('0.11.0', { assets: [] })]), /missing/);
  const notes = upgradeNotes(versions, '0.1.0', '0.10.0');
  assert.match(notes, /Upgrade instructions for 0.9.0/);
  assert.match(notes, /Upgrade instructions for 0.10.0/);
  assert.doesNotMatch(notes, /Upgrade instructions for 0.1.0/);
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
});

test('archive validation rejects wrong versions, missing files, changed contents, incompatible runtime, traversal, duplicates, and symlinks', async (t) => {
  const root = temp(t);
  const original = distribution();
  assert.throws(() => validateDistribution(original, '0.3.0'), /does not match/);
  assert.throws(() => validateDistribution(original, '0.2.0', 18), /requires Node/);
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

test('GitHub client paginates and reports network, auth, and size errors without exposing credentials', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let calls = 0;
  globalThis.fetch = async () => new Response(JSON.stringify(++calls === 1 ? Array.from({ length: 100 }, () => release('0.1.0')) : [release('0.2.0')]));
  assert.equal((await listReleases()).length, 101);
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
  const zip = await archive(distribution());
  fs.writeFileSync(path.join(root, 'asset.zip'), options.corrupt ? Buffer.from('corrupt') : zip);
  const responses = [release('0.2.0'), release('0.1.5')];
  if (options.missing) responses[0].assets = [];
  fs.writeFileSync(path.join(root, 'responses.json'), JSON.stringify(responses));
  const preload = path.join(root, 'fetch.mjs');
  fs.writeFileSync(preload, `
import fs from 'node:fs';
const original = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (!String(url).startsWith(${JSON.stringify(api)})) return original(url, options);
  if (String(url).includes('/assets/1')) return new Response(fs.readFileSync(${JSON.stringify(path.join(root, 'asset.zip'))}));
  if (String(url).includes('/assets/2')) return new Response(${JSON.stringify(`${sha256(zip)}  semantic-flow-0.2.0.zip\n`)});
  return new Response(fs.readFileSync(${JSON.stringify(path.join(root, 'responses.json'))}));
};
${options.failReplacement ? `const rename = fs.renameSync; fs.renameSync = (from, to) => { if (String(from).includes('.semantic-flow-update-')) throw new Error('Injected replacement failure'); return rename(from, to); };` : ''}
`);
  const cli = path.join(installed, 'scripts/semantic-flow.mjs');
  async function run(args = [], env = {}) {
    const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, cli, 'update', ...args], {
      cwd: repository.root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    const [status] = await once(child, 'close');
    return { status, stdout, stderr };
  }
  return { root, repository, installed, cli, run };
}

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

for (const options of [{ corrupt: true }, { missing: true }, { failReplacement: true }]) {
  test(`failed release update preserves installation: ${Object.keys(options)[0]}`, async (t) => {
    const fixture = await updateFixture(t, options);
    const before = new Map(skillFiles(fixture.installed).map((name) => [name, sha256(fs.readFileSync(path.join(fixture.installed, name)))]));
    const result = await fixture.run();
    assert.notEqual(result.status, 0);
    for (const [name, digest] of before) assert.equal(sha256(fs.readFileSync(path.join(fixture.installed, name))), digest);
  });
}

test('release update restarts the matching viewer and preserves repository artifacts', async (t) => {
  let port;
  t.after(async () => {
    if (port) { const viewer = await probeViewer(port); if (viewer) await stopViewerAndWait(viewer, port); }
  });
  const fixture = await updateFixture(t);
  initializeImplementation(fixture.repository);
  const beforeArtifact = fixture.repository.read('.semantic-review/manifest.json');
  const server = net.createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  port = server.address().port; server.close(); await once(server, 'close');
  const env = { SEMANTIC_VIEW_PORT: String(port), SEMANTIC_VIEW_NO_OPEN: '1' };
  const launch = spawnSync(process.execPath, [fixture.cli, 'review'], { cwd: fixture.repository.root, env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.equal(launch.status, 0, launch.stderr);
  const before = await fetch(`http://127.0.0.1:${port}/api/whoami`).then((r) => r.json());
  const result = await fixture.run([], env);
  assert.equal(result.status, 0, result.stderr);
  const after = await fetch(`http://127.0.0.1:${port}/api/whoami`).then((r) => r.json());
  assert.notEqual(before.processId, after.processId);
  assert.equal(after.skillDirectory, fixture.installed);
  assert.equal(beforeArtifact, fixture.repository.read('.semantic-review/manifest.json'));
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
    if (args[1] === 'create') { state = release('0.2.0', { draft: true, body: fs.readFileSync(args[args.indexOf('--notes-file') + 1], 'utf8') }); return ''; }
    if (args[1] === 'edit' && args.includes('--notes-file')) state.body = fs.readFileSync(args[args.indexOf('--notes-file') + 1], 'utf8');
    if (args[1] === 'upload') { assert.equal(state.draft, true); return ''; }
    if (args[1] === 'download') {
      const destination = args[args.indexOf('--dir') + 1];
      for (const file of [artifact.archive, artifact.checksum]) fs.copyFileSync(file, path.join(destination, path.basename(file)));
      if (corrupt) fs.appendFileSync(path.join(destination, path.basename(artifact.archive)), 'bad');
      return '';
    }
    if (args[1] === 'view') return JSON.stringify({ body: corruptBody ? fs.readFileSync(notesFile, 'utf8') : state.body, isDraft: state.draft, isPrerelease: false, url: state.html_url });
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
