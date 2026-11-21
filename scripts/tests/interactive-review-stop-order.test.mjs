import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verify } from '../evaluations/adapters/interactive-review.mjs';
import { session, skill } from './helpers/interactive-session.mjs';

const stopCheck = async (context, driver) => (await verify({ ...context, skill, driver })).checks.find(check => check.id === 'stopped-on-request');

// The wall clock can step back between two stamps (WSL2 resyncs by about two seconds
// every half minute), so the exit can carry an earlier stamp than the Stop it followed.
test('the stop check orders the exit by cause, not by wall-clock stamps', async t => {
  const { context, driver, execution, stderr, checks } = await session(t, 'good', { clock: () => new Date(Date.now() - 60_000) });
  assert.equal(execution.exitCode, 0, stderr);
  const stop = checks['stopped-on-request'];
  assert.ok(stop.evidence.agentExitedAt < stop.evidence.stopRequestedAt, JSON.stringify(stop.evidence));
  assert.ok(stop.passed, JSON.stringify(stop.evidence));

  // The same record fails when the agent left before any wait read the Stop.
  const { stopRequestedAt, endedAt, endReason, ...live } = driver.sessionAtExit;
  assert.ok(stopRequestedAt && endedAt && endReason === 'stopped');
  assert.equal((await stopCheck(context, { ...driver, sessionAtExit: live })).passed, false);
  assert.equal((await stopCheck(context, { ...driver, sessionAtExit: { ...live, stopRequestedAt } })).passed, false);
  assert.equal((await stopCheck(context, { ...driver, sessionAtExit: null })).passed, false);
});
