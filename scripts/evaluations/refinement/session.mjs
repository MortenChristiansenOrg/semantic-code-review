import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadPlan } from './plan.mjs';
import { checked, environment, hash, inside, inventory, instructionSizes, readJson, writeJson } from './common.mjs';
import { prepareFixture, verifyFixture } from './scenarios.mjs';
import { codexTelemetry } from './telemetry.mjs';
import { preflightAgent } from './preflight.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const skillSource = path.join(source, '.agents/skills/refine-semantic-flow');
const sessionFile = dir => path.join(dir, 'session.json');
const recordFile = (dir, id) => path.join(dir, 'runs', id, 'result.json');
export function loadSession(directory) {
  const session = readJson(sessionFile(directory));
  if (session.version !== 1 || !path.isAbsolute(session.workspace) || !fs.existsSync(session.workspace)) throw new Error('Missing or unsupported session workspace');
  if (readJson(path.join(session.workspace, '.refinement-owner.json')).id !== session.id) throw new Error('Workspace ownership marker differs');
  return session;
}
export function checkPins(session) {
  if (session.rubric && hash(JSON.stringify(inventory(session.rubric.path))) !== session.rubric.hash) throw new Error('Frozen rubric changed; prepare a fresh session');
  if (hash(JSON.stringify(inventory(path.join(source, 'scripts/evaluations/refinement')))) !== session.runnerHash) throw new Error('Runner changed; prepare a fresh session instead of mixing verifier versions');
  for (const variant of session.plan.variants) {
    if (hash(JSON.stringify(inventory(variant.install))) !== variant.hash) throw new Error(`Copied skill changed: ${variant.id}`);
  }
  for (const scenario of session.plan.scenarios) if (scenario.adapter && hash(fs.readFileSync(scenario.adapter)) !== scenario.adapterHash) throw new Error(`Adapter changed: ${scenario.id}`);
}
export async function adapterFor(selection) {
  if (!selection.adapter) return null;
  const adapter = await import(pathToFileURL(selection.adapter).href);
  for (const name of ['preflight', 'prepare', 'verify']) if (typeof adapter[name] !== 'function') throw new Error(`Adapter ${selection.id} must export ${name}()`);
  if (!Array.isArray(adapter.transcriptChecks) || !adapter.transcriptChecks.length || !Array.isArray(adapter.checkIds) || !adapter.checkIds.length) throw new Error('Adapter must declare nonempty transcriptChecks and checkIds');
  if (!adapter.transcriptCriteria || JSON.stringify(Object.keys(adapter.transcriptCriteria).sort()) !== JSON.stringify([...adapter.transcriptChecks].sort()) || Object.values(adapter.transcriptCriteria).some(value => typeof value !== 'string' || !value.trim())) throw new Error('Adapter must define a nonempty transcriptCriteria rule for every transcript check, including applicability');
  return adapter;
}
export async function prepare(configFile, directory) {
  directory = path.resolve(directory);
  if (fs.existsSync(directory)) throw new Error('Session destination already exists; use a new name');
  const plan = loadPlan(configFile);
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node 20 or later is required');
  const versions = { node: process.version, git: checked(['git', '--version'], source), platform: process.platform, arch: process.arch };
  for (const [role, agents] of [['implementer', plan.implementers], ['grader', [plan.grader]]]) for (const a of agents) versions[`${role}:${a.id}`] = checked(a.versionCommand, source);
  // Validate installations before creating any session files or launching models.
  for (const variant of plan.variants) for (const name of ['SKILL.md', 'scripts/semantic-flow.mjs', 'scripts/semantic-implementation.mjs', 'scripts/review-feedback.mjs']) {
    if (!fs.statSync(path.join(variant.skill, name)).isFile()) throw new Error(`Missing built skill resource: ${name}`);
  }
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-refinement-'));
  const id = randomUUID(); writeJson(path.join(workspace, '.refinement-owner.json'), { id });
  fs.mkdirSync(directory, { recursive: true });
  const session = { version: 1, id, createdAt: new Date().toISOString(), workspace, plan, versions,
    sourceRevision: checked(['git', 'rev-parse', 'HEAD'], source), sourceStatus: checked(['git', 'status', '--short'], source),
    runnerHash: hash(JSON.stringify(inventory(path.join(source, 'scripts/evaluations/refinement')))), state: 'preparing' };
  writeJson(sessionFile(directory), session);
  try {
    session.capabilities = {};
    for (const [role, agents] of [['implementer', plan.implementers], ['grader', [plan.grader]]]) for (const agent of agents) {
      session.capabilities[`${role}:${agent.id}`] = preflightAgent(agent, role, path.join(workspace, 'preflight', `${role}-${agent.id}`), path.join(directory, 'preflight', `${role}-${agent.id}.json`));
    }
    for (const variant of plan.variants) {
      variant.install = path.join(workspace, 'installs', variant.id, 'semantic-flow');
      fs.cpSync(variant.skill, variant.install, { recursive: true, dereference: true });
      variant.hash = hash(JSON.stringify(inventory(variant.install))); variant.sizes = instructionSizes(variant.install);
    }
    for (const selection of plan.scenarios) {
      const adapter = await adapterFor(selection);
      if (adapter) {
        // A custom adapter is one self-contained maintainer-owned module, frozen before use.
        const copy = path.join(workspace, 'adapters', `${selection.id}.mjs`); fs.mkdirSync(path.dirname(copy), { recursive: true }); fs.copyFileSync(selection.adapter, copy); selection.adapter = copy;
        selection.capabilities = await adapter.preflight({ options: selection.options ?? {}, source, workspace });
        if (!selection.capabilities || typeof selection.capabilities !== 'object') throw new Error('Adapter preflight must return the verified capability fingerprint');
      }
    }
    // All fixture/preflight failures happen before model budget is spent.
    for (const job of plan.jobs) {
      const variant = plan.variants.find(v => v.id === job.variant), selection = plan.scenarios.find(s => s.id === job.scenario);
      const root = path.join(workspace, 'cases', job.id); fs.mkdirSync(root, { recursive: true }); const env = environment(root);
      const adapter = await adapterFor(selection);
      const args = { root, skill: variant.install, env, options: selection.options ?? {}, capabilities: selection.capabilities };
      const fixture = adapter ? await adapter.prepare(args) : prepareFixture(root, variant.install, job.scenario, env);
      if (!fixture?.request || !fixture?.repo || !inside(root, fixture.repo)) throw new Error(`Invalid fixture from ${job.scenario}`);
      fixture.root = root;
      writeJson(path.join(directory, 'runs', job.id, 'fixture.json'), fixture);
      fs.writeFileSync(path.join(directory, 'runs', job.id, 'prompt.txt'), [
        `Use the Semantic Flow skill at ${path.join(variant.install, 'SKILL.md')}.`,
        `Repository: ${fixture.repo}. All writes (including worktrees, temporary files and caches) must stay under ${root}.`,
        `SEMANTIC_FLOW_HOME=${env.SEMANTIC_FLOW_HOME}; temporary files: ${env.TMPDIR}; npm cache: ${env.npm_config_cache}.`,
        'Do not edit the installed skill or perform remote operations. This is a non-interactive run. If user input is essential, state the exact question and stop dependent work; no scripted reply is available.',
        fixture.agentSetup ?? '', '', fixture.request, '',
      ].join('\n'));
    }
    // Freeze grading instructions too; later documentation edits cannot silently change the rubric.
    fs.cpSync(path.join(skillSource, 'references'), path.join(directory, 'rubric'), { recursive: true });
    session.rubric = { path: path.join(directory, 'rubric'), hash: hash(JSON.stringify(inventory(path.join(directory, 'rubric')))) };
    session.state = 'ready'; writeJson(sessionFile(directory), session);
  } catch (error) {
    session.state = 'setup-failed'; session.error = error.message; writeJson(sessionFile(directory), session); throw error;
  }
  return session;
}

export async function withLock(directory, action) {
  const file = path.join(directory, 'runner.lock');
  if (fs.existsSync(file)) {
    const prior = fs.readFileSync(file, 'utf8'); const lock = JSON.parse(prior);
    try { process.kill(lock.pid, 0); throw new Error(`Session already running under PID ${lock.pid}`); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    if (fs.readFileSync(file, 'utf8') !== prior) throw new Error('Session lock changed');
    fs.unlinkSync(file);
  }
  const fd = fs.openSync(file, 'wx'); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); fs.closeSync(fd);
  try { return await action(); } finally { fs.rmSync(file, { force: true }); }
}
function terminate(child, force = false) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
  } else {
    try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}
export async function launch(command, options) {
  const { cwd, env, prompt, stdoutFile, stderrFile, timeoutMs } = options;
  const out = fs.openSync(stdoutFile, 'w'), err = fs.openSync(stderrFile, 'w');
  return await new Promise(resolve => {
    let timedOut = false, interrupted = false, error = null, killTimer;
    const child = spawn(command[0], command.slice(1), { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', out, err] });
    fs.closeSync(out); fs.closeSync(err);
    child.stdin.on('error', () => {}); child.stdin.end(prompt);
    const stop = () => { terminate(child); killTimer ??= setTimeout(() => terminate(child, true), 1000); };
    const interrupt = () => { interrupted = true; stop(); };
    process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    child.on('error', e => { error = e.message; });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer); clearTimeout(killTimer); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
      // Reap background servers in this run's process group, including on normal completion.
      terminate(child, true);
      resolve({ exitCode, signal, timedOut, interrupted, error });
    });
  });
}
export async function runJob(directory, session, job, agent, root, repo, prompt) {
  const destination = path.join(directory, 'runs', job.id); fs.mkdirSync(destination, { recursive: true });
  const output = path.join(destination, 'final.txt');
  const substitutions = { model: agent.model, effort: agent.effort, case: root, repo, output, schema: path.join(root, 'output-schema.json') };
  const command = agent.command.map(arg => arg.replace(/\{(model|effort|case|repo|output|schema)\}/g, (_, key) => substitutions[key]));
  const spent = [...session.plan.jobs, ...session.plan.gradeJobs].filter(j => fs.existsSync(recordFile(directory, j.id))).length;
  if (spent >= session.plan.budget.maxModelRuns) throw new Error('Model-run budget exhausted');
  const remaining = Date.parse(session.createdAt) + session.plan.budget.wallMinutes * 60_000 - Date.now();
  if (remaining <= 0) throw new Error('Session wall-clock budget exhausted');
  const callTime = job.kind === 'evaluation' ? remaining - session.plan.grading.reserveMinutes * 60_000 : remaining;
  if (callTime <= 0) throw new Error('Remaining time reserved for grading');
  const record = { ...job, state: 'running', startedAt: new Date().toISOString(), modelId: agent.model, effort: agent.effort, command, isolation: agent.isolation };
  writeJson(recordFile(directory, job.id), record); console.log(`Starting ${job.id}`);
  const started = Date.now();
  const execution = await launch(command, { cwd: repo, env: environment(root), prompt, stdoutFile: path.join(destination, 'transcript.jsonl'), stderrFile: path.join(destination, 'stderr.log'), timeoutMs: Math.min(callTime, session.plan.budget.runMinutes * 60_000) });
  const raw = fs.readFileSync(path.join(destination, 'transcript.jsonl'), 'utf8');
  if (execution.timedOut) execution.error = 'Harness timed out';
  if (execution.interrupted) execution.error = 'Harness interrupted';
  const telemetry = agent.transcript === 'codex-jsonl' ? codexTelemetry(raw) : { tools: null, tokens: null, bytesRead: null, final: raw, completed: true, errors: [] };
  // A harness failure is invalid evidence, not an application failure or an unnecessary user stop.
  Object.assign(record, execution, { seconds: (Date.now() - started) / 1000, telemetry, state: execution.exitCode === 0 && !execution.timedOut && !execution.interrupted && telemetry.completed && !telemetry.errors.length ? 'completed' : 'invalid' });
  fs.writeFileSync(output, telemetry.final); writeJson(recordFile(directory, job.id), record);
  console.log(`${job.id}: ${record.state}`); return record;
}
export async function runEvaluations(directory) {
  const session = loadSession(directory); checkPins(session);
  if (session.state !== 'ready') throw new Error('Session preparation did not complete');
  for (const job of session.plan.jobs) {
    // Existing attempts are never silently repeated, even if interrupted or invalid.
    if (fs.existsSync(recordFile(directory, job.id))) continue;
    const remaining = Date.parse(session.createdAt) + session.plan.budget.wallMinutes * 60_000 - Date.now();
    if (remaining <= session.plan.grading.reserveMinutes * 60_000) { console.log('Remaining time reserved for grading; unlaunched evaluations remain not-run.'); break; }
    const fixture = readJson(path.join(directory, 'runs', job.id, 'fixture.json'));
    const agent = session.plan.implementers.find(a => a.id === job.model);
    const result = await runJob(directory, session, job, agent, fixture.root, fixture.repo, fs.readFileSync(path.join(directory, 'runs', job.id, 'prompt.txt'), 'utf8'));
    if (result.state === 'invalid') throw new Error(`Evaluation ${job.id} is invalid; inspect its result and transcript. No automatic retry.`);
  }
  const invalid = session.plan.jobs.filter(job => fs.existsSync(recordFile(directory, job.id)) && readJson(recordFile(directory, job.id)).state !== 'completed');
  if (invalid.length) throw new Error(`Evaluation has incomplete or invalid attempts: ${invalid.map(j => j.id).join(', ')}. Use report to inspect coverage.`);
}
export async function verify(directory) {
  const session = loadSession(directory); checkPins(session);
  for (const job of session.plan.jobs) {
    const resultPath = recordFile(directory, job.id), file = path.join(directory, 'runs', job.id, 'checks.json');
    if (!fs.existsSync(resultPath) || fs.existsSync(file)) continue;
    const result = readJson(resultPath); if (result.state !== 'completed') continue;
    const fixture = readJson(path.join(directory, 'runs', job.id, 'fixture.json')), selection = session.plan.scenarios.find(s => s.id === job.scenario);
    const variant = session.plan.variants.find(v => v.id === job.variant), env = environment(fixture.root);
    let verification;
    try {
      const adapter = await adapterFor(selection);
      verification = adapter ? await adapter.verify({ fixture, root: fixture.root, skill: variant.install, env, options: selection.options ?? {}, capabilities: selection.capabilities }) : verifyFixture(fixture, fixture.root, variant.install, job.scenario, env);
      if (!Array.isArray(verification.checks) || !verification.checks.length || verification.checks.some(c => typeof c.passed !== 'boolean' || !c.id)) throw new Error('Verifier returned invalid checks');
      if (adapter) {
        if (JSON.stringify(verification.checks.map(c => c.id).sort()) !== JSON.stringify([...adapter.checkIds].sort())) throw new Error('Adapter omitted or changed its declared checks');
        verification.transcriptChecks = adapter.transcriptChecks;
        verification.transcriptCriteria = adapter.transcriptCriteria;
      }
      verification.state = 'verified';
    } catch (error) { verification = { state: 'invalid', error: error.message }; }
    writeJson(file, verification);
  }
}
