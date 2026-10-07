// Local utility coverage in a pinned real application; UI/backend integration is
// deliberately deferred. No installed dependencies, services, or browser needed.
// Options: project (source checkout), revision (full commit; defaults below).
// This module is copied by the harness: use built-ins and verified absolute tools.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const pinnedRevision = 'a741a63421af2e0a0a0d72a5ac7f0aa82f249509';
export const checkIds = ['worktree-scope', 'artifact-publication', 'stack', 'finalized-stage', 'target-preserved', 'source-preserved', 'application-acceptance', 'project-tests'];
export const transcriptCriteria = {
  'acceptance-exercised': 'Pass when the agent exercises the specified utility behavior through successful local tests, including whitespace, Unicode code points, limit boundaries, and invalid inputs. UI/backend integration is explicitly deferred; browser and live-service checks are inapplicable.',
  'insight-policy-followed': 'Pass when evidenced significant observations are recorded appropriately, with no invented routine filler. Empty insights pass if no significant observation arose; insights quality is then null with a reason. Fail only evidenced significant omissions or inappropriate records; require no minimum count.',
};
export const transcriptChecks = Object.keys(transcriptCriteria);
const hash = value => createHash('sha256').update(value).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const inside = (root, file) => {
  try {
    const relative = path.relative(fs.realpathSync(root), fs.realpathSync(file));
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
  } catch { return false; }
};
function executable(name) {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    const file = path.resolve(directory, process.platform === 'win32' ? `${name}.exe` : name);
    try { fs.accessSync(file, fs.constants.X_OK); return fs.realpathSync(file); } catch { /* Next PATH entry. */ }
  }
  throw new Error(`Required executable unavailable: ${name}`);
}
function run(command, cwd, env, { input, timeout = 30_000, binary = false } = {}) {
  // A verifier's regression tests may themselves run inside node:test. Its
  // private context variable would otherwise silently skip authored test files.
  const childEnv = { ...(env ?? process.env) }; delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(command[0], command.slice(1), { cwd, env: childEnv, input, encoding: binary ? undefined : 'utf8', timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  if (['ENOENT', 'EACCES', 'EPERM', 'ENOMEM', 'EAGAIN'].includes(result.error?.code) && fs.existsSync(cwd)) throw new Error(`Evaluator executable failure: ${result.error.message}`);
  return { command, exitCode: result.status, stdout: result.stdout ?? (binary ? Buffer.alloc(0) : ''), stderr: String(result.stderr ?? ''), error: result.error?.message ?? null };
}
function checked(command, cwd, env, settings) {
  const result = run(command, cwd, env, settings);
  if (result.exitCode !== 0 || result.error) throw new Error(`${command.join(' ')}: ${result.stderr || result.error || result.stdout}`);
  return result.stdout;
}
function toolPins(capabilities) {
  for (const tool of Object.values(capabilities.tools)) if (hash(fs.readFileSync(tool.path)) !== tool.sha256) throw new Error(`Pinned evaluator executable changed: ${tool.path}`);
}
// A narrow allowlist exports application source/configuration, never repository
// skills, local environment files, credentials, caches, or previous review state.
const rootFiles = new Set(['AGENTS.md', 'CLAUDE.md', 'README.md', '.gitignore', '.eslintrc.json', '.prettierignore', '.prettierrc', 'components.json', 'eslint.config.mjs', 'next.config.ts', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'postcss.config.mjs', 'skills-lock.json', 'tailwind.config.ts', 'tsconfig.json']);
function allowedSource(name) {
  if (name === '.gitignore') return true;
  if (!name.startsWith('team-chat/')) return false;
  const parts = name.slice(10).split('/');
  if (parts.some(part => /^\.env(?:\.|$)|^\.semantic-review|^\.agents$|^node_modules$|^\.next$|credential|secret|^\.npmrc$/i.test(part)) || /\.(?:pem|key|p12|pfx)$/i.test(name)) return false;
  return parts.length === 1 ? rootFiles.has(parts[0]) : ['app', 'components', 'convex', 'lib', 'public'].includes(parts[0]);
}
function sourceEntries(git, project, revision, env) {
  return checked([git, 'ls-tree', '-r', '-z', revision], project, env).split('\0').filter(Boolean).map(line => {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t(.+)$/.exec(line);
    if (!match) throw new Error('Unreadable source tree');
    return { mode: match[1], type: match[2], blob: match[3], name: match[4] };
  }).filter(entry => allowedSource(entry.name));
}

// Evaluator-owned assertions are never included in request/agentSetup.
const acceptance = `import assert from 'node:assert/strict';
const { previewMessage: p } = await import(process.argv[1]);
assert.equal(typeof p, 'function');
for (const body of ['', ' ', '\\t\\r\\n', '\\u00a0\\u2003\\ufeff']) assert.equal(p(body), '');
assert.equal(p('  one\\t two\\r\\nthree  '), 'one two three');
assert.equal(p('a\\u00a0b\\u2028c\\ufeffd'), 'a b c d');
assert.equal(p('a\\u200bb'), 'a\\u200bb');
assert.equal(p('x'.repeat(80)), 'x'.repeat(80));
assert.equal(p('x'.repeat(81)), 'x'.repeat(79) + '…');
assert.equal(p('hello', 5), 'hello'); assert.equal(p('hello!', 5), 'hell…');
assert.equal(p('long', 1), '…'); assert.equal(p('x', 1), 'x');
assert.equal(p('ab cd', 4), 'ab …');
assert.equal(p('😀😃😄', 3), '😀😃😄'); assert.equal(p('😀😃😄😁', 3), '😀😃…');
assert.equal(p('e\\u0301xy', 3), 'e\\u0301…');
assert.equal(p('👩\\u200d💻x', 3), '👩\\u200d…');
assert.equal(p('z'.repeat(4000), 4000), 'z'.repeat(4000));
assert.equal(p('z'.repeat(4001), 4000), 'z'.repeat(3999) + '…');
for (const bad of [null, undefined, 3, {}, [], true, new String('x')]) assert.throws(() => p(bad), TypeError);
for (const bad of [0, -1, 4001, 1.5, NaN, Infinity, -Infinity, null, '5', {}, true]) assert.throws(() => p('x', bad), RangeError);
assert.equal(p('x', undefined), 'x');
for (const [body, limit] of [['  a  b  c  ', 3], ['😀'.repeat(90), 80], ['e\\u0301'.repeat(10), 7]]) {
  const result = p(body, limit); assert.ok(Array.from(result).length <= limit); assert.equal(p(body, limit), result);
}
console.log('Independent message preview acceptance passed');`;

export async function preflight({ options = {}, workspace }) {
  const project = fs.realpathSync(options.project ?? '/home/morten/code/chat-app');
  const revision = options.revision ?? pinnedRevision;
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Chat fixture requires a full pinned source commit');
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node 20+ required');
  const tools = Object.fromEntries(['git', 'tar'].map(name => { const file = executable(name); return [name, { path: file, sha256: hash(fs.readFileSync(file)), version: checked([file, '--version'], project).trim() }]; }));
  tools.node = { path: fs.realpathSync(process.execPath), sha256: hash(fs.readFileSync(process.execPath)), version: process.version };
  const resolved = checked([tools.git.path, 'rev-parse', `${revision}^{commit}`], project).trim();
  if (resolved !== revision) throw new Error('Source revision did not resolve exactly');
  const entries = sourceEntries(tools.git.path, project, revision);
  if (!entries.length || entries.some(entry => entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode))) throw new Error('Fixture requires regular committed application files only');
  for (const required of ['team-chat/package.json', 'team-chat/app/page.tsx', 'team-chat/convex/chat.ts', 'team-chat/lib/utils.ts']) if (!entries.some(entry => entry.name === required)) throw new Error(`Pinned source missing ${required}`);
  const archive = checked([tools.git.path, 'archive', '--format=tar', revision, '--', ...entries.map(entry => entry.name)], project, undefined, { binary: true });
  const probe = fs.mkdtempSync(path.join(workspace, 'chat-adapter-probe-'));
  try {
    checked([tools.tar.path, '-xf', '-', '-C', probe], project, undefined, { input: archive });
    checked([tools.node.path, '--input-type=module', '-e', "import assert from 'node:assert/strict'; assert.equal(Array.from('😀').length,1);"], probe);
    checked([tools.git.path, 'init', '-b', 'main'], probe);
  } finally { fs.rmSync(probe, { recursive: true, force: true }); }
  return { project, revision, tools, entries, sourceTreeHash: hash(JSON.stringify(entries)), archiveHash: hash(archive), acceptanceHash: hash(acceptance), scope: 'local pure utility only; consumer/UI/backend integration deferred', dependencies: 'none' };
}

export async function prepare({ root, env, capabilities }) {
  toolPins(capabilities);
  const repo = path.join(root, 'project'); fs.mkdirSync(repo);
  const { tools, project, revision, entries } = capabilities;
  const archive = checked([tools.git.path, 'archive', '--format=tar', revision, '--', ...entries.map(entry => entry.name)], project, env, { binary: true });
  if (hash(archive) !== capabilities.archiveHash) throw new Error('Pinned source archive changed');
  checked([tools.tar.path, '-xf', '-', '-C', repo], root, env, { input: archive });
  const git = (...args) => checked([tools.git.path, ...args], repo, env).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Semantic Flow Evaluation'); git('config', 'user.email', 'evaluation@example.invalid'); git('config', 'commit.gpgsign', 'false'); git('config', 'core.hooksPath', path.join(root, 'empty-hooks'));
  // The fresh index must retain even source files matched by exported ignore rules.
  git('add', '--force', '--', ...entries.map(entry => entry.name));
  checked([tools.git.path, 'commit', '-qm', 'Export pinned chat application fixture'], repo, { ...env, GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' });
  if (git('remote')) throw new Error('Disposable fixture unexpectedly has remotes');
  return { repo, before: { baseRevision: git('rev-parse', 'HEAD'), sourceEntries: entries, package: readJson(path.join(repo, 'team-chat/package.json')), revision, sourceTreeHash: capabilities.sourceTreeHash },
    agentSetup: `This is a disposable export of committed chat-app source ${revision}. Runtime: ${tools.node.version}; Node executable: ${tools.node.path}. No node_modules are provided or needed. The Next.js guide instruction applies when using Next.js; this task uses only built-in Node APIs and does not change Next.js or Convex code. Do not install dependencies, run services, access Convex, or use a browser. Run utility tests directly with node --test from team-chat. Consumer/UI/backend integration is deferred; only the pure utility and its tests are in scope.`,
    request: '/semantic-flow implement Add a reusable, dependency-free message preview utility at team-chat/lib/message-preview.mjs exporting previewMessage(body, maxLength = 80). Require a primitive string body (otherwise TypeError). Require maxLength to be an integer number from 1 through 4000 inclusive (otherwise RangeError; omitted/undefined uses 80). Normalize each run of ECMAScript whitespace (the JavaScript \\s class) to one ASCII space, then trim leading/trailing whitespace. Empty normalized text returns an empty string. Count Unicode code points, not UTF-16 code units or grapheme clusters. Return text unchanged when it fits; otherwise take exactly the first maxLength - 1 code points and append U+2026 ellipsis, which counts toward the limit. Do not trim the sliced prefix again. The function must be deterministic and have no side effects or dependencies. Add meaningful Node built-in tests at team-chat/lib/message-preview.test.mjs and add package script "test:message-preview": "node --test lib/message-preview.test.mjs". Preserve all existing application files byte-for-byte except the additive package script; preserve every existing package field/script. Consumer integration is explicitly deferred: do not alter UI, Convex, or existing utilities. Complete the local implementation artifact and validated stage stack, ready for human review.' };
}

export async function verify({ fixture, root, skill, env, capabilities }) {
  toolPins(capabilities);
  const checks = new Map(checkIds.map(id => [id, { id, passed: false, evidence: 'Prerequisite checks did not pass' }])), evidence = {};
  const add = (id, passed, detail) => checks.set(id, { id, passed: Boolean(passed), evidence: detail });
  const invoke = (label, command, cwd = fixture.repo, settings) => { const result = run(command, cwd, env, settings); evidence[label] = result; return result; };
  const cli = (name, ...args) => [capabilities.tools.node.path, path.join(skill, 'scripts', `${name}.mjs`), ...args];
  const git = (...args) => invoke(`git:${args.join(' ')}`, [capabilities.tools.git.path, ...args]);
  const done = () => ({ checks: [...checks.values()], evidence });
  const listed = git('worktree', 'list', '--porcelain', '-z');
  const roots = String(listed.stdout).split('\0').filter(line => line.startsWith('worktree ')).map(line => line.slice(9));
  if (listed.exitCode !== 0 || !roots.length || roots.some(repo => !inside(root, repo))) { add('worktree-scope', false, listed); return done(); }
  const inspection = invoke('inspection', cli('semantic-flow', 'inspect', '--json'));
  let selected;
  try { const parsed = JSON.parse(inspection.stdout); if (parsed.candidates.length !== 1) throw new Error('Expected exactly one linked artifact'); selected = parsed.selected; if (!selected || !roots.includes(selected.worktree)) throw new Error('No selected linked artifact'); }
  catch (error) { add('worktree-scope', false, `${inspection.stderr}\n${error.message}`); return done(); }
  add('worktree-scope', true, { roots, selected: selected.worktree });
  const repo = selected.worktree;
  for (const [id, args] of [['artifact-publication', ['validate', '--publish']], ['stack', ['validate-stack', '--json']]]) { const result = invoke(id, cli('semantic-implementation', ...args), repo); add(id, result.exitCode === 0 && !result.error, result); }
  let manifest, stages, head;
  try {
    manifest = readJson(path.join(repo, '.semantic-review/manifest.json'));
    if (!Array.isArray(manifest.stages) || !manifest.stages.length || manifest.stages.some(id => typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id))) throw new Error('Missing/unsafe finalized stage ids');
    stages = manifest.stages.map(id => readJson(path.join(repo, '.semantic-review/stages', `${id}.json`)));
    head = stages.at(-1).change.headRevision;
    if (!/^[a-f0-9]{40}$/.test(head) || selected.workingStageIds.length) throw new Error('Implementation has no final immutable head or still has working stages');
    const exists = git('cat-file', '-t', head);
    if (exists.exitCode !== 0 || exists.stdout.trim() !== 'commit') throw new Error('Final registered stage commit unavailable');
    add('finalized-stage', true, head); evidence.artifact = { repo, manifest, stages };
  } catch (error) { add('finalized-stage', false, error.message); return done(); }
  const target = git('rev-parse', '--verify', 'refs/heads/main');
  add('target-preserved', target.exitCode === 0 && target.stdout.trim() === fixture.before.baseRevision && manifest.targetBranch === 'main' && manifest.baseRevision === fixture.before.baseRevision, target);
  // Read the cumulative registered commit even when a lower stage is checked out.
  evidence.diff = invoke('diff', [capabilities.tools.git.path, 'diff', fixture.before.baseRevision, head], repo);
  const after = git('ls-tree', '-r', '-z', head);
  const files = new Map(String(after.stdout).split('\0').filter(Boolean).map(line => { const match = /^(\d+) (\w+) ([a-f0-9]+)\t(.+)$/.exec(line); return match ? [match[4], { mode: match[1], type: match[2], blob: match[3] }] : ['', {}]; }));
  let preserved = after.exitCode === 0;
  const lost = [];
  for (const entry of fixture.before.sourceEntries) if (entry.name !== 'team-chat/package.json' && (files.get(entry.name)?.blob !== entry.blob || files.get(entry.name)?.mode !== entry.mode)) { preserved = false; lost.push(entry.name); }
  const packageResult = git('show', `${head}:team-chat/package.json`);
  try {
    const packageBefore = fixture.before.sourceEntries.find(entry => entry.name === 'team-chat/package.json');
    if (files.get('team-chat/package.json')?.mode !== packageBefore.mode) throw new Error('Package file mode changed');
    const current = JSON.parse(packageResult.stdout), original = fixture.before.package;
    if (current.scripts?.['test:message-preview'] !== 'node --test lib/message-preview.test.mjs') throw new Error('Missing expected test command');
    const withoutTest = structuredClone(current); delete withoutTest.scripts['test:message-preview'];
    // Compare JSON values independent of object key order.
    const canonical = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
    if (JSON.stringify(canonical(withoutTest)) !== JSON.stringify(canonical(original))) throw new Error('Existing package fields changed');
  } catch (error) { preserved = false; lost.push(error.message); }
  add('source-preserved', preserved, lost.length ? lost : 'Original source modes/blobs and package fields preserved');
  const checkout = fs.mkdtempSync(path.join(root, 'chat-acceptance-'));
  const archive = invoke('acceptance-archive', [capabilities.tools.git.path, 'archive', '--format=tar', head], repo, { binary: true });
  // Do not save binary archive contents in JSON evidence.
  evidence['acceptance-archive'] = { ...archive, stdout: `<${archive.stdout.length} bytes>` };
  const unsafe = [...files].filter(([name, entry]) => name.split('/').includes('..') || !['100644', '100755'].includes(entry.mode) || entry.type !== 'blob');
  if (archive.exitCode !== 0 || unsafe.length) { add('application-acceptance', false, unsafe.length ? { unsafe } : evidence['acceptance-archive']); return done(); }
  const exported = invoke('acceptance-export', [capabilities.tools.tar.path, '-xf', '-', '-C', checkout], repo, { input: archive.stdout });
  if (exported.exitCode !== 0) { add('application-acceptance', false, exported); return done(); }
  const result = invoke('application-acceptance', [capabilities.tools.node.path, '--input-type=module', '-e', acceptance, pathToFileURL(path.join(checkout, 'team-chat/lib/message-preview.mjs')).href], checkout);
  add('application-acceptance', result.exitCode === 0 && !result.error, result);
  const tests = invoke('project-tests', [capabilities.tools.node.path, '--test', '--test-reporter=tap', 'lib/message-preview.test.mjs'], path.join(checkout, 'team-chat'));
  const count = /# tests (\d+)/.exec(tests.stdout);
  add('project-tests', tests.exitCode === 0 && !tests.error && Number(count?.[1]) > 0, tests);
  return done();
}
