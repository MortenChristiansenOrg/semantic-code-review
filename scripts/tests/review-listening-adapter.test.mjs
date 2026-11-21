import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { checkIds, transcriptChecks, transcriptCriteria } from '../evaluations/adapters/review-listening.mjs';
import { session, setup } from './helpers/listening-session.mjs';

test('prepare finishes three stages and keeps the reviewer script out of the agent request', async t => {
  const { fixture, env } = await setup(t);
  assert.equal(fixture.request, '/semantic-flow review');
  assert.deepEqual(Object.keys(fixture.before.heads), ['notifications', 'delivery-docs', 'templates']);
  assert.ok(fs.existsSync(path.join(env.SEMANTIC_FLOW_HOME, 'reviews')));
  assert.doesNotMatch(fixture.request + fixture.agentSetup, /retry|HTML|plain|placeholder|Stop/i);
  assert.deepEqual(Object.keys(transcriptCriteria), transcriptChecks);
});

test('a known-good listening agent passes every fixed check and its viewer is stopped', async t => {
  const { driver, execution, stderr, checks, result } = await session(t, 'good');
  assert.equal(execution.exitCode, 0, stderr);
  assert.deepEqual(result.checks.map(check => check.id), checkIds);
  for (const check of result.checks) assert.ok(check.passed, `${check.id}: ${JSON.stringify(check.evidence)}`);
  assert.equal(checks['asked-in-viewer'].evidence.detail.via, 'agent-ask');
  assert.ok(driver.events.some(event => event.type === 'viewer-stopped'));
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('an agent that stops listening after the first round fails the listening checks', async t => {
  const { execution, stderr, checks } = await session(t, 'early-exit');
  assert.equal(execution.exitCode, 0, stderr);
  assert.equal(checks.listened.passed, true);
  assert.equal(checks['round-one-changes'].passed, true);
  for (const id of ['follow-up-queued', 'asked-in-viewer', 'decision-applied', 'stopped-on-request']) assert.equal(checks[id].passed, false, id);
});

test('negated retry documentation and resolved reviewer threads fail their checks', async t => {
  const { execution, stderr, checks } = await session(t, 'sloppy');
  assert.equal(execution.exitCode, 0, stderr);
  assert.equal(checks['round-one-changes'].passed, false);
  assert.equal(checks['threads-open'].passed, false);
  assert.equal(checks['decision-applied'].passed, true);
  assert.equal(checks['stopped-on-request'].passed, true);
});

test('an agent that settles contradictory notes itself fails the viewer question check', async t => {
  const { execution, stderr, driver, checks } = await session(t, 'decides');
  assert.equal(execution.exitCode, 0, stderr);
  assert.ok(driver.events.some(event => event.type === 'decided-without-asking'));
  assert.equal(checks['asked-in-viewer'].passed, false);
  assert.equal(checks['decision-applied'].passed, false);
  assert.equal(checks['stopped-on-request'].passed, true);
});
