import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { checkIds, drive, preflight, prepare, transcriptChecks, transcriptCriteria, verify } from '../evaluations/adapters/interactive-review.mjs';
import { environment } from '../evaluations/refinement/common.mjs';
import { launch } from '../evaluations/refinement/session.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const skill = path.join(source, 'skills/semantic-flow');
const agent = path.join(source, 'scripts/tests/helpers/interactive-agent.mjs');
const timing = { pollMs: 200, listenMinutes: 1, roundMinutes: 1.5, questionMinutes: 1, stopMinutes: 1 };

async function setup(t) {
  const workspace = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'interactive review '));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const root = path.join(workspace, 'case'); fs.mkdirSync(root);
  const env = environment(root);
  const capabilities = await preflight({ options: { timing }, workspace });
  const fixture = { ...await prepare({ root, skill, env, capabilities }), root };
  return { root, env, capabilities, fixture };
}
// Runs the scripted agent and reviewer side by side, as the runner does.
async function session(t, mode) {
  const context = await setup(t), { root, env, fixture } = context;
  const running = launch([process.execPath, agent, skill, mode], { cwd: fixture.repo, env, prompt: 'Review interactively.',
    stdoutFile: path.join(root, 'agent.out'), stderrFile: path.join(root, 'agent.err'), timeoutMs: 300_000 });
  const driver = await drive({ ...context, skill, signal: new AbortController().signal, agentExited: running.then(execution => ({ ...execution, at: new Date().toISOString() })) });
  const execution = await running;
  const result = await verify({ ...context, skill, driver });
  return { driver, execution, stderr: fs.readFileSync(path.join(root, 'agent.err'), 'utf8'), checks: Object.fromEntries(result.checks.map(check => [check.id, check])), result };
}

test('prepare finishes three stages and keeps the reviewer script out of the agent request', async t => {
  const { fixture, env } = await setup(t);
  assert.equal(fixture.request, '/semantic-flow review -i');
  assert.deepEqual(Object.keys(fixture.before.heads), ['notifications', 'delivery-docs', 'templates']);
  assert.ok(fs.existsSync(path.join(env.SEMANTIC_FLOW_HOME, 'reviews')));
  assert.doesNotMatch(fixture.request + fixture.agentSetup, /retry|HTML|plain|placeholder|Stop/i);
  assert.deepEqual(Object.keys(transcriptCriteria), transcriptChecks);
});

test('a known-good interactive agent passes every fixed check and its viewer is stopped', async t => {
  const { driver, execution, stderr, checks, result } = await session(t, 'good');
  assert.equal(execution.exitCode, 0, stderr);
  assert.deepEqual(result.checks.map(check => check.id), checkIds);
  for (const check of result.checks) assert.ok(check.passed, `${check.id}: ${JSON.stringify(check.evidence)}`);
  assert.equal(checks['asked-in-viewer'].evidence.detail.via, 'agent-ask');
  assert.ok(driver.events.some(event => event.type === 'viewer-stopped'));
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('an agent that stops listening after the first round fails the listening checks', async t => {
  const { execution, checks } = await session(t, 'early-exit');
  assert.equal(execution.exitCode, 0);
  assert.equal(checks.listened.passed, true);
  assert.equal(checks['round-one-changes'].passed, true);
  for (const id of ['follow-up-queued', 'asked-in-viewer', 'decision-applied', 'stopped-on-request']) assert.equal(checks[id].passed, false, id);
});

test('negated retry documentation and resolved reviewer threads fail their checks', async t => {
  const { execution, checks } = await session(t, 'sloppy');
  assert.equal(execution.exitCode, 0);
  assert.equal(checks['round-one-changes'].passed, false);
  assert.equal(checks['threads-open'].passed, false);
  assert.equal(checks['decision-applied'].passed, true);
  assert.equal(checks['stopped-on-request'].passed, true);
});

test('an agent that settles contradictory notes itself fails the viewer question check', async t => {
  const { execution, driver, checks } = await session(t, 'decides');
  assert.equal(execution.exitCode, 0);
  assert.ok(driver.events.some(event => event.type === 'decided-without-asking'));
  assert.equal(checks['asked-in-viewer'].passed, false);
  assert.equal(checks['decision-applied'].passed, false);
  assert.equal(checks['stopped-on-request'].passed, true);
});
