// Runs the scripted interactive agent beside the scripted reviewer, as the evaluation runner does.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drive, preflight, prepare, verify } from '../../evaluations/adapters/interactive-review.mjs';
import { environment } from '../../evaluations/refinement/common.mjs';
import { launch } from '../../evaluations/refinement/session.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const skill = path.join(source, 'skills/semantic-flow');
const agent = path.join(source, 'scripts/tests/helpers/interactive-agent.mjs');
const timing = { pollMs: 200, listenMinutes: 1, roundMinutes: 1.5, questionMinutes: 1, stopMinutes: 1 };

export async function setup(t) {
  const workspace = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'interactive review '));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const root = path.join(workspace, 'case'); fs.mkdirSync(root);
  const env = environment(root);
  const capabilities = await preflight({ options: { timing }, workspace });
  const fixture = { ...await prepare({ root, skill, env, capabilities }), root };
  return { root, env, capabilities, fixture };
}

/** `clock` stamps the agent's exit; it defaults to the wall clock, as in the runner. */
export async function session(t, mode, { clock = () => new Date() } = {}) {
  const context = await setup(t), { root, env, fixture } = context;
  const running = launch([process.execPath, agent, skill, mode], { cwd: fixture.repo, env, prompt: 'Review interactively.',
    stdoutFile: path.join(root, 'agent.out'), stderrFile: path.join(root, 'agent.err'), timeoutMs: 300_000 });
  const agentStderr = () => { try { return fs.readFileSync(path.join(root, 'agent.err'), 'utf8'); } catch { return ''; } };
  let driver;
  try { driver = await drive({ ...context, skill, signal: new AbortController().signal, agentExited: running.then(execution => ({ ...execution, at: clock().toISOString() })) }); }
  catch (error) {
    const execution = await running;
    throw new Error(`The scripted reviewer failed (agent exit code ${execution.exitCode}): ${error.message}\nAgent stderr:\n${agentStderr()}`, { cause: error });
  }
  const execution = await running;
  const result = await verify({ ...context, skill, driver });
  return { context, driver, execution, stderr: agentStderr(), checks: Object.fromEntries(result.checks.map(check => [check.id, check])), result };
}
