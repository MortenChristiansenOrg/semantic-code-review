import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { checkIds, preflight, prepare, verify } from '../evaluations/adapters/chat-app.mjs';
import { environment, repository, snapshot, writeJson } from '../evaluations/refinement/common.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const skill = path.join(source, 'skills/semantic-flow');
const correct = `export function previewMessage(body, maxLength = 80) {
  if (typeof body !== 'string') throw new TypeError('Body must be a string');
  if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > 4000) throw new RangeError('Invalid length');
  const normalized = body.replace(/\\s+/g, ' ').trim();
  const points = Array.from(normalized);
  return points.length <= maxLength ? normalized : points.slice(0, maxLength - 1).join('') + '…';
}\n`;
const authoredTests = `import {test} from 'node:test'; import assert from 'node:assert/strict'; import {previewMessage} from './message-preview.mjs';
test('preview basic text', () => assert.equal(previewMessage('hello'), 'hello'));\n`;

async function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'chat adapter '));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const original = path.join(workspace, 'original'), root = path.join(workspace, 'case');
  fs.mkdirSync(original); fs.mkdirSync(root);
  const env = environment(root), r = repository(original, skill, env);
  r.git('init', '-b', 'main'); r.git('config', 'user.name', 'Fixture'); r.git('config', 'user.email', 'fixture@example.invalid');
  for (const [file, content] of Object.entries({
    '.gitignore': 'team-chat/convex/_generated/\n.env*\n',
    'team-chat/package.json': JSON.stringify({ name: 'team-chat', version: '0.1.0', scripts: { dev: 'next dev' }, dependencies: { convex: '^1.44.0' } }),
    'team-chat/app/page.tsx': 'export default function Page() { return null; }\n',
    'team-chat/convex/chat.ts': 'export const original = true;\n',
    'team-chat/convex/_generated/api.js': 'export const api = {};\n',
    'team-chat/lib/utils.ts': 'export function untouched() { return true; }\n',
    'team-chat/.env.local': 'DO_NOT_EXPORT=this-is-a-fixture-secret\n',
    'team-chat/public/credential.txt': 'omit credential\n',
    '.agents/skills/semantic-flow/SKILL.md': 'Old installed instructions\n',
    '.semantic-review/manifest.json': '{"old":true}\n',
  })) r.write(file, content);
  r.git('add', '--force', '.'); r.git('commit', '-qm', 'Pinned source fixture');
  const revision = r.git('rev-parse', 'HEAD');
  // A dirty original checkout must not leak into an export or be altered.
  r.write('team-chat/lib/utils.ts', 'Uncommitted user work\n');
  const beforeOriginal = snapshot(original, env.SEMANTIC_FLOW_HOME);
  const capabilities = await preflight({ options: { project: original, revision }, workspace });
  const f = await prepare({ root, skill, env, capabilities });
  return { workspace, original, beforeOriginal, root, env, capabilities, f, r: repository(f.repo, skill, env) };
}
function complete(context, implementation = correct, { changeSource = false, brokenTests = false } = {}) {
  const { r, root, f } = context;
  r.cli('semantic-implementation', 'init', '--implementation-id', 'preview', '--title', 'Message previews', '--summary', 'Pure local utility', '--target-branch', 'main', '--specification-id', 'story', '--specification-title', 'Preview utility', '--specification-summary', 'Preview text locally', '--source-kind', 'local', '--source-reference', 'fixture', '--criterion', 'works=Message previews normalize whitespace and respect code-point limits.');
  r.cli('semantic-implementation', 'stage', 'begin', '--id', 'preview', '--title', 'Preview utility', '--summary', 'Add the utility', '--rationale', 'Keep local utility reviewable', '--specification-ref', 'story#works');
  r.write('team-chat/lib/message-preview.mjs', implementation);
  r.write('team-chat/lib/message-preview.test.mjs', brokenTests ? "import {test} from 'node:test'; test('broken', () => {throw new Error('failed project check')});\n" : authoredTests);
  r.write('team-chat/package.json', JSON.stringify({ ...f.before.package, scripts: { ...f.before.package.scripts, 'test:message-preview': 'node --test lib/message-preview.test.mjs' } }, null, 2) + '\n');
  const changed = ['team-chat/lib/message-preview.mjs', 'team-chat/lib/message-preview.test.mjs', 'team-chat/package.json'];
  if (changeSource) { r.write('team-chat/lib/utils.ts', 'Source was lost\n'); changed.push('team-chat/lib/utils.ts'); }
  r.git('add', '--', ...changed); r.git('commit', '-qm', 'Implement previews');
  const organization = path.join(root, 'tmp', 'preview-organization.json');
  writeJson(organization, { $schema: 'https://semantic-code-review.dev/skills/semantic-flow/v0.1/stage-organization.schema.json', nodes: [{ id: 'preview', description: 'Preview utility and tests', changes: changed.map(name => ({ path: name, classification: name.endsWith('.test.mjs') ? 'test' : 'behavior' })) }], itemLinks: [] });
  r.cli('semantic-implementation', 'stage', 'organize', '--file', organization);
  r.cli('semantic-implementation', 'stage', 'finish', '--id', 'preview');
}
const check = async context => verify({ fixture: context.f, root: context.root, skill, env: context.env, capabilities: context.capabilities });
const byId = result => Object.fromEntries(result.checks.map(item => [item.id, item]));

test('preflight/prepare pin committed application source, omit secrets and old skills, preserve original work', async t => {
  const c = await fixture(t);
  assert.deepEqual(snapshot(c.original, c.env.SEMANTIC_FLOW_HOME), c.beforeOriginal);
  assert.equal(c.r.git('remote'), '');
  for (const file of ['team-chat/.env.local', 'team-chat/public/credential.txt', '.agents/skills/semantic-flow/SKILL.md', '.semantic-review/manifest.json']) assert.equal(fs.existsSync(path.join(c.f.repo, file)), false, file);
  assert.equal(fs.readFileSync(path.join(c.f.repo, 'team-chat/lib/utils.ts'), 'utf8'), 'export function untouched() { return true; }\n');
  assert.equal(c.r.git('ls-files', '--', 'team-chat/convex/_generated/api.js'), 'team-chat/convex/_generated/api.js');
  assert.equal(c.capabilities.sourceTreeHash, c.f.before.sourceTreeHash);
  assert.equal(c.capabilities.acceptanceHash.length, 64);
  assert.match(c.f.request, /Consumer integration is explicitly deferred/);
  assert.doesNotMatch(c.f.request + c.f.agentSetup, /Independent message preview acceptance|assert\.equal/);
});

test('known-good verifier passes every fixed check from registered cumulative commit despite main checkout', async t => {
  const c = await fixture(t); complete(c);
  c.r.git('switch', 'main');
  const before = snapshot(c.f.repo, c.env.SEMANTIC_FLOW_HOME);
  const result = await check(c);
  assert.deepEqual(result.checks.map(item => item.id), checkIds);
  assert.ok(result.checks.every(item => item.passed), JSON.stringify(result.checks, null, 2));
  assert.deepEqual(snapshot(c.f.repo, c.env.SEMANTIC_FLOW_HOME), before);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('independent verifier catches UTF-16 truncation even when agent tests pass', async t => {
  const c = await fixture(t);
  complete(c, correct.replace('const points = Array.from(normalized);', "const points = normalized.split('');"));
  const checks = byId(await check(c));
  assert.equal(checks['project-tests'].passed, true);
  assert.equal(checks['application-acceptance'].passed, false);
  assert.equal(checks['artifact-publication'].passed, true);
});

test('independent verifier catches whitespace, limit, and type bugs in otherwise valid completions', async t => {
  for (const [name, broken] of [
    ['whitespace', correct.replace("body.replace(/\\s+/g, ' ').trim()", 'body.trim()')],
    ['off-by-one', correct.replace('maxLength - 1', 'maxLength')],
    ['invalid-limit', correct.replace('maxLength < 1', 'maxLength < 0')],
    ['body-type', correct.replace("if (typeof body !== 'string') throw new TypeError('Body must be a string');", 'body = String(body);')],
  ]) await t.test(name, async subtest => {
    const c = await fixture(subtest); complete(c, broken);
    assert.equal(byId(await check(c))['application-acceptance'].passed, false);
  });
});

test('source deletion/change and failing authored tests are task failures, not infrastructure exclusions', async t => {
  const c = await fixture(t); complete(c, correct, { changeSource: true, brokenTests: true });
  const checks = byId(await check(c));
  assert.equal(checks['application-acceptance'].passed, true);
  assert.equal(checks['source-preserved'].passed, false);
  assert.equal(checks['project-tests'].passed, false);
});

test('missing artifact fails all declared checks and an unregistered correct HEAD is not accepted', async t => {
  const c = await fixture(t);
  c.r.commit('team-chat/lib/message-preview.mjs', correct, 'Unregistered implementation');
  const result = await check(c);
  assert.deepEqual(result.checks.map(item => item.id), checkIds);
  assert.equal(byId(result)['application-acceptance'].passed, false);
  assert.equal(byId(result)['worktree-scope'].passed, false);
});

test('frozen standalone copy imports and executes its contract without relative dependencies', async t => {
  const c = await fixture(t);
  const file = path.join(c.workspace, 'frozen-adapter.mjs');
  fs.copyFileSync(path.join(source, 'scripts/evaluations/adapters/chat-app.mjs'), file);
  const frozen = await import(pathToFileURL(file).href);
  assert.deepEqual(frozen.checkIds, checkIds);
  const root = path.join(c.workspace, 'frozen-case'); fs.mkdirSync(root);
  const env = environment(root);
  const f = await frozen.prepare({ root, env, capabilities: c.capabilities });
  assert.equal(fs.existsSync(path.join(f.repo, 'team-chat/package.json')), true);
});
