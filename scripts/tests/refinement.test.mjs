import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Ajv from 'ajv';
import { plan } from '../evaluations/refinement/plan.mjs';
import { codexTelemetry } from '../evaluations/refinement/telemetry.mjs';
import { checked, environment, execute, inside, readJson, repository, snapshot, writeJson } from '../evaluations/refinement/common.mjs';
import { begin, finish, initialize, prepareFixture, priceAcceptance, scenarios, verifyFixture } from '../evaluations/refinement/scenarios.mjs';
import { adapterFor, checkPins, launch, loadSession, prepare, runEvaluations, runJob, verify, withLock } from '../evaluations/refinement/session.mjs';
import { collectResults, grade, invalidate, redact, report, validateGrades } from '../evaluations/refinement/grading.mjs';
import { gradeSchema } from '../evaluations/refinement/grade-schema.mjs';
import { sandboxProbeCommand } from '../evaluations/refinement/preflight.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), skill = path.join(source, 'skills/semantic-flow');
const sample = () => readJson(path.join(source, '.agents/skills/refine-semantic-flow/assets/baseline.json'));
const calibration = { mechanicsStop: 1, productQuestion: 0, stageOnlyTraceability: 10, ambiguousClarity: 3, neutralMaintainability: 6, routineInsightPolicy: true, missingSignificantInsightPolicy: false };
function temp(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refinement tests ')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function fixture(t, scenario) { const root = temp(t), env = environment(root); return { root, env, fixture: prepareFixture(root, skill, scenario, env) }; }

function completeCompatible(f, env) {
  const r = repository(f.repo, skill, env), manifest = readJson(path.join(f.repo, '.semantic-review/manifest.json'));
  const stage = readJson(path.join(f.repo, '.semantic-review/stages/notifications.json'));
  const finalBranch = r.git('branch', '--show-current');
  // Evaluator-controlled known-good completion: replay the stage onto the updated target.
  const rebase = execute(['git', 'rebase', '--onto', 'main', manifest.baseRevision, stage.change.branch], f.repo, env);
  assert.notEqual(rebase.exitCode, 0); // The deliberately compatible textual conflict.
  r.write('notifications.json', '{"enabled":true,"format":"html","retries":2}\n'); r.git('add', 'notifications.json');
  checked(['git', '-c', 'core.editor=true', 'rebase', '--continue'], f.repo, env);
  r.git('switch', 'main'); r.cli('semantic-implementation', 'restack', '--base', 'main'); r.git('switch', finalBranch);
  r.cli('review-feedback', 'thread', 'reply', '--id', 'delivery-retries', '--comment-id', 'agent-retries', '--author', 'agent', '--body', 'Set two retries; enabled confirmations and HTML formatting are preserved.');
}

test('plans count grader calls, retain exact roles, pair variants and enforce the budget', () => {
  const config = sample(), baseline = plan(config, source);
  assert.equal(baseline.jobs.length, 8); assert.equal(baseline.gradeJobs.length, 4); assert.equal(baseline.totalModelRuns, 12);
  assert.equal(baseline.implementers.length, 1); assert.equal(baseline.grader.model, 'gpt-6-astra');
  config.budget.maxModelRuns = 11; assert.throws(() => plan(config), /budget is 11/);
  config.mode = 'compare'; config.budget.maxModelRuns = 43;
  config.variants.push({ id: 'candidate', skill }); config.scenarios.forEach(s => { s.repetitions = 3; });
  const comparison = plan(config); assert.equal(comparison.jobs.length, 36); assert.equal(comparison.gradeJobs.length, 7);
  assert.deepEqual(comparison.jobs.slice(0, 4).map(j => j.variant), ['baseline', 'candidate', 'candidate', 'baseline']);
  config.scenarios.pop(); assert.throws(() => plan(config), /full broad set/);
});

test('rejects unsafe identifiers, duplicate selections and unknown placeholder typos', () => {
  const c = sample(); c.implementers[0].id = '../escape'; assert.throws(() => plan(c), /needs id/);
  const d = sample(); d.scenarios.push(d.scenarios[0]); assert.throws(() => plan(d), /Duplicate scenario/);
  const e = sample(); e.grader.command.push('{modle}'); assert.throws(() => plan(e), /Unknown command placeholder/);
});

test('environment isolates cache/temp/review paths while preserving harness authentication roots', t => {
  const root = temp(t), env = environment(root);
  for (const key of ['TMPDIR', 'TMP', 'TEMP', 'SEMANTIC_FLOW_HOME', 'npm_config_cache', 'NPM_CONFIG_CACHE', 'XDG_CACHE_HOME', 'YARN_CACHE_FOLDER']) assert.ok(env[key].startsWith(root + path.sep));
  assert.equal(env.HOME, process.env.HOME); assert.equal(env.CODEX_HOME, process.env.CODEX_HOME);
});

test('worktree containment accepts physical aliases and rejects symlink escapes, including new files', t => {
  const root = temp(t), actual = path.join(root, 'actual'), alias = path.join(root, 'alias'), outside = path.join(root, 'outside');
  fs.mkdirSync(actual); fs.mkdirSync(outside); fs.mkdirSync(path.join(actual, 'project'));
  fs.symlinkSync(actual, alias, 'junction'); fs.symlinkSync(outside, path.join(actual, 'escape'), 'junction');
  assert.equal(inside(alias, path.join(actual, 'project')), true);
  assert.equal(inside(actual, path.join(alias, 'project/new/file')), true);
  assert.equal(inside(actual, path.join(actual, 'escape/new/file')), false);
  assert.equal(inside(actual, outside), false);
});

test('telemetry counts unique asynchronous tools and separates cached tokens', () => {
  const text = [
    { type: 'turn.started' },
    { type: 'item.started', item: { id: '1', type: 'command_execution' } },
    { type: 'item.completed', item: { id: '1', type: 'command_execution' } },
    { type: 'item.started', item: { id: '2', type: 'command_execution' } },
    { type: 'item.completed', item: { id: '3', type: 'agent_message', text: 'Done' } },
    { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 } },
  ].map(JSON.stringify).join('\n');
  const result = codexTelemetry(text); assert.equal(result.tools, 2); assert.equal(result.completed, true);
  assert.deepEqual(result.tokens, { input: 20, cachedInput: 80, output: 10 }); assert.equal(result.bytesRead, null);
  assert.equal(codexTelemetry('{bad').errors.length, 1); assert.equal(codexTelemetry('{"type":"turn.started"}').completed, false);
});

test('independent acceptance rejects unchanged totals even when its own test passes', t => {
  const { root, env, fixture: f } = fixture(t, 'implement-small');
  assert.equal(execute([process.execPath, '--test'], f.repo, env).exitCode, 0);
  const check = () => execute([process.execPath, '--input-type=module', '-e', priceAcceptance, pathToFileURL(path.join(f.repo, 'prices.js')).href], root, env);
  assert.notEqual(check().exitCode, 0);
  fs.writeFileSync(path.join(f.repo, 'prices.js'), 'export function total(items,d=0) {if(!Number.isFinite(d)||d<0||d>100)throw new RangeError(); return items.reduce((s,i)=>s+i.price*i.quantity,0)*(1-d/100)}');
  assert.equal(check().exitCode, 0);
});

test('status and help checks detect mutations, and verification itself is read-only', t => {
  const { root, env, fixture: f } = fixture(t, 'status');
  assert.ok(verifyFixture(f, root, skill, 'status', env).checks.every(c => c.passed));
  fs.writeFileSync(path.join(f.repo, 'README.md'), 'Unexpected edit');
  assert.equal(verifyFixture(f, root, skill, 'status', env).checks[0].passed, false);
});

test('ambiguous feedback permits diagnostic refs but catches changed product or review state', t => {
  const { root, env, fixture: f } = fixture(t, 'feedback-conflicting-intent');
  checked(['git', 'branch', 'diagnostic-snapshot'], f.repo, env);
  assert.ok(verifyFixture(f, root, skill, 'feedback-conflicting-intent', env).checks.every(c => c.passed));
  fs.writeFileSync(path.join(f.repo, 'notifications.json'), '{}');
  assert.equal(verifyFixture(f, root, skill, 'feedback-conflicting-intent', env).checks.find(c => c.id === 'original-content-preserved').passed, false);
});

test('compatible feedback verifier uses artifact publication gate and never resolves an open replied thread', t => {
  const { root, env, fixture: f } = fixture(t, 'feedback-compatible');
  completeCompatible(f, env);
  const before = snapshot(f.repo, env.SEMANTIC_FLOW_HOME), checks = verifyFixture(f, root, skill, 'feedback-compatible', env);
  assert.ok(checks.checks.every(c => c.passed), JSON.stringify(checks.checks));
  assert.deepEqual(snapshot(f.repo, env.SEMANTIC_FLOW_HOME), before);
  assert.notEqual(execute([process.execPath, path.join(skill, 'scripts/semantic-flow.mjs'), 'validate', '--publish'], f.repo, env).exitCode, 0);
});

test('category fixture injects the intended real contract failure without leaving a corrupt decision', t => {
  const { fixture: f } = fixture(t, 'cli-recovery-category');
  assert.match(f.request, /category must be equal to one of the allowed values/);
  const stage = readJson(path.join(f.repo, '.semantic-review/.work/stages/discount.json'));
  assert.deepEqual(stage.decisions, []);
});

test('launch records failures and enforces timeouts without shell interpolation', async t => {
  const root = temp(t), env = environment(root), options = { cwd: root, env, prompt: 'test', stdoutFile: path.join(root, 'out'), stderrFile: path.join(root, 'err'), timeoutMs: 100 };
  const missing = await launch(['missing-refinement-executable-xyz'], options); assert.ok(missing.error);
  const timeout = await launch([process.execPath, '-e', 'setTimeout(()=>{},10000)'], options); assert.equal(timeout.timedOut, true);
  const literal = 'spaces; $(echo wrong)';
  const normal = await launch([process.execPath, '-e', 'console.log(process.argv[1])', literal], { ...options, timeoutMs: 5000 });
  assert.equal(normal.exitCode, 0); assert.equal(fs.readFileSync(options.stdoutFile, 'utf8').trim(), literal);
});

test('grader rejects incomplete checks, fake calibration and duplicated document grades', () => {
  const packet = { kind: 'runs', runs: [{ id: 'run-1', transcriptChecks: ['acceptance'] }] };
  assert.throws(() => validateGrades({ calibration: {}, runs: [] }, packet), /calibration/);
  assert.throws(() => validateGrades({ calibration, runs: [{ id: 'run-1', checks: [] }] }, packet), /missing=\["acceptance"\]/);
  const instructions = { kind: 'instructions', labels: ['A'], documents: [{ label: 'A', path: 'SKILL.md' }] };
  assert.throws(() => validateGrades({ calibration, documents: [], consistency: [] }, instructions), /every instruction document/);
  assert.equal(redact('/secret/install/file /secret/run/file', [['/secret/install', '<skill>'], ['/secret/run', '<fixture>']]), '<skill>/file <fixture>/file');
});

test('full harness lifecycle with scripted models: budget, resume, verification, blind grading and report', async t => {
  const root = temp(t), config = sample(), configFile = path.join(root, 'config.json'), directory = path.join(root, 'records');
  const fake = path.join(root, 'fake-model.mjs');
  // A deterministic harness double exercises orchestration, not model behavior.
  fs.writeFileSync(fake, `import fs from 'node:fs'; import path from 'node:path';
let prompt=''; for await (const part of process.stdin) prompt+=part;
let result='The implementation has two finalized stages: notifications and delivery-docs.';
if(fs.existsSync(path.join(process.cwd(),'packet.json'))){
 const packet=JSON.parse(fs.readFileSync('packet.json')); result=JSON.stringify({calibration:{mechanicsStop:1,productQuestion:0,stageOnlyTraceability:10,ambiguousClarity:3,neutralMaintainability:6,routineInsightPolicy:true,missingSignificantInsightPolicy:false},runs:packet.runs.map(r=>({id:r.id,checks:r.transcriptChecks.map(id=>({id,passed:true,evidence:'Scripted fixture check'})),violations:[],cliRejected:0,cliUnrecovered:0,prompts:0,countEvidence:'Scripted harness transcript',subjective:Object.fromEntries(['organization','insights','traceability','readability','responses','followability'].map(k=>[k,{score:null,reason:'Harness double, no behavioral grading'}]))}))});
}
console.log(JSON.stringify({type:'turn.started'}));
console.log(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:result}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:30,output_tokens:10}}));
`);
  for (const agent of [...config.implementers, config.grader]) { agent.command = [process.execPath, fake, '{model}', '{effort}']; agent.versionCommand = [process.execPath, '--version']; agent.isolation = 'prompt'; agent.preflight = 'none'; }
  config.variants[0].skill = skill; config.scenarios = [{ id: 'status', repetitions: 1 }]; config.grading.instructions = false;
  writeJson(configFile, config); const session = await prepare(configFile, directory); t.after(() => fs.rmSync(session.workspace, { recursive: true, force: true }));
  assert.equal(session.plan.totalModelRuns, 2); assert.equal(collectResults(directory)[0].success, null);
  await withLock(directory, () => runEvaluations(directory));
  const resultFile = path.join(directory, 'runs', session.plan.jobs[0].id, 'result.json'), first = fs.readFileSync(resultFile, 'utf8');
  await runEvaluations(directory); assert.equal(fs.readFileSync(resultFile, 'utf8'), first);
  await verify(directory); assert.equal(collectResults(directory)[0].success, null);
  await grade(directory);
  const packet = readJson(path.join(session.workspace, 'graders/grade-runs-1/packet.json'));
  assert.deepEqual(packet.runs[0].rules.transcriptCriteria, scenarios.status.transcriptCriteria);
  assert.deepEqual(packet.scoreScale, session.rubric.subjectiveScale);
  assert.equal(session.rubric.subjectiveScale.maximum, 10);
  const rows = report(directory); assert.equal(rows[0].success, 1); assert.equal(rows[0].state, 'scored');
  assert.deepEqual(rows[0].tokens, { input: 70, cachedInput: 30, output: 10 });
  assert.match(fs.readFileSync(path.join(directory, 'report.md'), 'utf8'), /Uncached input/);
  assert.match(fs.readFileSync(path.join(directory, 'report.md'), 'utf8'), /Scores are 1–10/);
  const rawGrade = fs.readFileSync(path.join(directory, 'runs/grade-runs-1/grades.json'), 'utf8');
  // Legacy metadata must retain its historical scale when reporting, without regrading.
  const legacySession = structuredClone(session); delete legacySession.rubric.subjectiveScale;
  writeJson(path.join(directory, 'session.json'), legacySession);
  report(directory);
  assert.match(fs.readFileSync(path.join(directory, 'report.md'), 'utf8'), /Scores are 1–5/);
  assert.equal(fs.readFileSync(path.join(directory, 'runs/grade-runs-1/grades.json'), 'utf8'), rawGrade);
  writeJson(path.join(directory, 'session.json'), session);
  invalidate(directory, session.plan.jobs[0].id, 'Observed infrastructure workaround; exclude this evidence.');
  assert.equal(collectResults(directory)[0].state, 'invalid'); assert.equal(collectResults(directory)[0].success, null);
  assert.equal(collectResults(directory)[0].fixedChecksPassed, true);
  assert.equal(fs.readFileSync(path.join(directory, 'runs/grade-runs-1/grades.json'), 'utf8'), rawGrade);
  assert.equal(fs.readFileSync(resultFile, 'utf8'), first);
  assert.throws(() => invalidate(directory, session.plan.jobs[0].id, 'Different reason'), /already recorded/);
  fs.appendFileSync(path.join(session.plan.variants[0].install, 'SKILL.md'), '\nChanged');
  assert.throws(() => checkPins(loadSession(directory)), /Copied skill changed/);
});

test('generated grader schema rejects the live-trial mistakes before coverage validation', () => {
  const packet = { kind: 'runs', runs: [{ id: 'run-1', transcriptChecks: ['acceptance'] }] };
  const check = new Ajv().compile(gradeSchema(packet));
  const valid = { calibration, runs: [{ id: 'run-1', checks: [{ id: 'acceptance', passed: true, evidence: 'Transcript item 1' }], violations: [], cliRejected: 0, cliUnrecovered: 0, prompts: 0, countEvidence: 'Inspected full transcript', subjective: Object.fromEntries(['organization', 'insights', 'traceability', 'readability', 'responses', 'followability'].map(k => [k, { score: null, reason: 'Not applicable' }])) }] };
  assert.equal(check(valid), true, JSON.stringify(check.errors));
  const miscalibrated = structuredClone(valid); miscalibrated.calibration.routineInsightPolicy = false;
  assert.throws(() => validateGrades(miscalibrated, packet), /calibration mismatch/);
  miscalibrated.calibration.routineInsightPolicy = true; miscalibrated.calibration.missingSignificantInsightPolicy = true;
  assert.throws(() => validateGrades(miscalibrated, packet), /calibration mismatch/);
  const extra = structuredClone(valid); extra.runs[0].checks.push({ id: 'artifact-publication', passed: true, evidence: 'Deterministic check' });
  assert.equal(check(extra), false);
  assert.throws(() => validateGrades(extra, packet), /missing=\[\], unexpected=\["artifact-publication"\], duplicates=\[\]/);
  const omitted = structuredClone(valid); delete omitted.runs[0].countEvidence; assert.equal(check(omitted), false);
  const instructionCheck = new Ajv().compile(gradeSchema({ kind: 'instructions', labels: ['A'], documents: [{ label: 'A', path: 'SKILL.md' }] }));
  assert.equal(instructionCheck({ calibration, documents: [{ label: 'A', path: 'SKILL.md', clarity: 5, reason: 'Clear' }], consistency: [{ label: 'A', findings: [] }], maintainability: [] }), true);
});

test('ten-level subjective scores agree across schema and runtime without bounding objective counts', () => {
  const packet = { kind: 'runs', runs: [{ id: 'run-1', transcriptChecks: ['acceptance'] }] };
  const check = new Ajv().compile(gradeSchema(packet));
  const answer = { calibration, runs: [{ id: 'run-1', checks: [{ id: 'acceptance', passed: true, evidence: 'Item 1' }], violations: [], cliRejected: 21, cliUnrecovered: 20, prompts: 12, countEvidence: 'Counted transcript invocations and stops', subjective: Object.fromEntries(['organization', 'insights', 'traceability', 'readability', 'responses', 'followability'].map(k => [k, { score: null, reason: 'Not applicable' }])) }] };
  for (const score of [null, ...Array.from({ length: 10 }, (_, i) => i + 1)]) {
    for (const metric of Object.values(answer.runs[0].subjective)) metric.score = score;
    assert.equal(check(answer), true, JSON.stringify(check.errors));
    assert.doesNotThrow(() => validateGrades(answer, packet));
  }
  for (const score of [0, 11, 5.5]) {
    answer.runs[0].subjective.organization.score = score;
    assert.equal(check(answer), false);
    assert.throws(() => validateGrades(answer, packet), /organization/);
  }
  for (const [anchor, wrong] of [['stageOnlyTraceability', 5], ['ambiguousClarity', 6], ['neutralMaintainability', 5]]) {
    const miscalibrated = structuredClone(answer); miscalibrated.calibration[anchor] = wrong;
    assert.throws(() => validateGrades(miscalibrated, packet), /calibration mismatch/);
  }

  const instructions = { kind: 'instructions', labels: ['A', 'B'], documents: [{ label: 'A', path: 'SKILL.md' }, { label: 'B', path: 'SKILL.md' }] };
  const instructionCheck = new Ajv().compile(gradeSchema(instructions));
  const grade = { calibration, documents: instructions.documents.map(d => ({ ...d, clarity: 10, reason: 'Fully satisfies the anchor' })), consistency: instructions.labels.map(label => ({ label, findings: [] })), maintainability: [{ from: 'A', to: 'B', score: 6, reason: 'Neutral' }, { from: 'B', to: 'A', score: 6, reason: 'Neutral' }] };
  for (const score of Array.from({ length: 10 }, (_, i) => i + 1)) {
    for (const document of grade.documents) document.clarity = score;
    for (const direction of grade.maintainability) direction.score = score;
    assert.equal(instructionCheck(grade), true, JSON.stringify(instructionCheck.errors));
    assert.doesNotThrow(() => validateGrades(grade, instructions));
  }
  for (const score of [0, 11, 5.5]) {
    grade.documents[0].clarity = score;
    assert.equal(instructionCheck(grade), false);
    assert.throws(() => validateGrades(grade, instructions), /clarity/);
    grade.documents[0].clarity = 10; grade.maintainability[0].score = score;
    assert.equal(instructionCheck(grade), false);
    assert.throws(() => validateGrades(grade, instructions), /maintainability/);
    grade.maintainability[0].score = 6;
  }
});

test('Codex and Claude discover the same refinement skill and supporting resources', () => {
  const codex = path.join(source, '.agents/skills/refine-semantic-flow');
  const claude = path.join(source, '.claude/skills/refine-semantic-flow');
  assert.equal(fs.realpathSync(claude), fs.realpathSync(codex));
  for (const resource of ['SKILL.md', 'references/harness.md', 'references/metrics.md', 'assets/baseline.json']) {
    assert.equal(fs.realpathSync(path.join(claude, resource)), fs.realpathSync(path.join(codex, resource)));
  }
});

test('sandbox preflight reproduces the declared network and Git permissions without silently broadening them', () => {
  const agent = sample().implementers[0], root = path.resolve('/tmp/probe'), repo = path.join(root, 'project');
  const command = sandboxProbeCommand(agent, root, repo);
  assert.ok(command.includes('permissions.refinement-probe.network.enabled=true'));
  assert.ok(command.some(arg => arg.includes(JSON.stringify(path.join(repo, '.git')) + '="write"')));
  agent.command = agent.command.map(arg => arg.replace('network_access=true', 'network_access=false'));
  assert.ok(sandboxProbeCommand(agent, root, repo).includes('permissions.refinement-probe.network.enabled=false'));
  agent.command.push('-c', 'permissions.custom.filesystem={}');
  assert.throws(() => sandboxProbeCommand(agent, root, repo), /Unsupported preflight permission/);
});

test('failed harness preflight stops preparation before a model attempt and retains the diagnostic', async t => {
  const root = temp(t), config = sample(), configFile = path.join(root, 'config.json'), directory = path.join(root, 'session');
  config.variants[0].skill = skill;
  for (const agent of [...config.implementers, config.grader]) agent.versionCommand = [process.execPath, '--version'];
  config.implementers[0].command[0] = 'missing-refinement-preflight-executable';
  writeJson(configFile, config);
  await assert.rejects(() => prepare(configFile, directory), /Harness capability probe failed/);
  const session = loadSession(directory); t.after(() => fs.rmSync(session.workspace, { recursive: true, force: true }));
  assert.equal(session.state, 'setup-failed');
  assert.equal(readJson(path.join(directory, 'preflight/implementer-sol.json')).status, 'failed');
  assert.equal(fs.existsSync(path.join(directory, 'runs')), false);
});

test('custom scenarios cannot reach grading with undefined transcript acceptance criteria', async t => {
  const root = temp(t);
  const declarations = `export const checkIds=['artifact']; export const transcriptChecks=['observed-behavior'];
export async function preflight(){} export async function prepare(){} export async function verify(){}`;
  const ambiguous = path.join(root, 'ambiguous.mjs'); fs.writeFileSync(ambiguous, declarations);
  await assert.rejects(() => adapterFor({ id: 'custom', adapter: ambiguous }), /transcriptCriteria rule for every transcript check/);
  const explicit = path.join(root, 'explicit.mjs');
  fs.writeFileSync(explicit, declarations + `\nexport const transcriptCriteria={'observed-behavior':'Pass when the agent demonstrates the requested behavior; explain when the check is inapplicable.'};`);
  const adapter = await adapterFor({ id: 'custom', adapter: explicit });
  assert.deepEqual(Object.keys(adapter.transcriptCriteria), adapter.transcriptChecks);
});

test('invalid grader output returns a failing command status and resuming does not retry it', async t => {
  const root = temp(t), config = sample(), configFile = path.join(root, 'config.json'), directory = path.join(root, 'session');
  config.variants[0].skill = skill; config.scenarios = [{ id: 'status', repetitions: 1 }];
  for (const agent of [...config.implementers, config.grader]) {
    agent.command = [process.execPath, '-e', 'console.log("{}")']; agent.versionCommand = [process.execPath, '--version']; agent.transcript = 'text'; agent.preflight = 'none';
  }
  writeJson(configFile, config); const session = await prepare(configFile, directory);
  t.after(() => fs.rmSync(session.workspace, { recursive: true, force: true }));
  await runEvaluations(directory); await verify(directory);
  const result = execute([process.execPath, path.join(source, 'scripts/evaluations/refine.mjs'), 'grade', directory], source);
  assert.equal(result.exitCode, 1); assert.match(result.stderr, /Invalid grader output/);
  const file = path.join(directory, 'runs/grade-instructions/result.json'), raw = fs.readFileSync(file, 'utf8');
  await assert.rejects(() => grade(directory), /Invalid grader output/);
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
  assert.equal(readJson(file).state, 'invalid');
  await assert.rejects(() => grade(directory), /incomplete or invalid attempts/);
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
});

test('grading cannot consume an unfinished group; explicit partial grading closes further evaluations', async t => {
  const root = temp(t), config = sample(), configFile = path.join(root, 'config.json'), directory = path.join(root, 'session');
  config.variants[0].skill = skill; config.scenarios = [{ id: 'status', repetitions: 2 }]; config.grading.instructions = false;
  for (const agent of [...config.implementers, config.grader]) {
    agent.command = [process.execPath, '-e', 'console.log("Status")']; agent.versionCommand = [process.execPath, '--version']; agent.transcript = 'text'; agent.preflight = 'none';
  }
  const answer = { calibration, runs: [{ id: 'run-1', checks: scenarios.status.transcriptChecks.map(id => ({ id, passed: true, evidence: 'Scripted transcript evidence' })), violations: [], cliRejected: 0, cliUnrecovered: 0, prompts: 0, countEvidence: 'Scripted fixture', subjective: Object.fromEntries(['organization', 'insights', 'traceability', 'readability', 'responses', 'followability'].map(k => [k, { score: null, reason: 'Scripted harness' }])) }] };
  const fakeGrader = path.join(root, 'grader.mjs'); fs.writeFileSync(fakeGrader, `console.log(${JSON.stringify(JSON.stringify(answer))});`);
  config.grader.command = [process.execPath, fakeGrader];
  writeJson(configFile, config); const session = await prepare(configFile, directory);
  t.after(() => fs.rmSync(session.workspace, { recursive: true, force: true }));
  const job = session.plan.jobs[0], f = readJson(path.join(directory, 'runs', job.id, 'fixture.json'));
  await runJob(directory, session, job, session.plan.implementers[0], f.root, f.repo, 'Status');
  await assert.rejects(() => grade(directory), /not yet run or verified/);
  await verify(directory);
  await assert.rejects(() => grade(directory), /not yet run or verified/);
  assert.equal(fs.existsSync(path.join(directory, 'runs/grade-runs-1/result.json')), false);
  await grade(directory, { partial: true });
  assert.equal(collectResults(directory)[0].success, 1); assert.equal(collectResults(directory)[1].state, 'not-run');
  await assert.rejects(() => runEvaluations(directory), /closed for partial grading/);
  assert.equal(fs.existsSync(path.join(directory, 'runs', session.plan.jobs[1].id, 'result.json')), false);
});

test('acceptance checks the final cumulative head when a lower stage is checked out', t => {
  const { root, env, fixture: f } = fixture(t, 'implement-small');
  const r = repository(f.repo, skill, env); initialize(r, 'Discount totals');
  begin(r, 'foundation', 'Clarify the total function');
  r.commit('prices.js', 'export function total(items) { return items.reduce((sum,item)=>sum+item.price*item.quantity,0); }\n', 'Clarify totals');
  finish(r, 'foundation', 'prices.js'); const lowerBranch = r.git('branch', '--show-current');
  begin(r, 'discount', 'Apply discounts', 'foundation');
  r.commit('prices.js', 'export function total(items,d=0){if(!Number.isFinite(d)||d<0||d>100)throw new RangeError();return items.reduce((s,i)=>s+i.price*i.quantity,0)*(1-d/100)}\n', 'Apply discounts');
  finish(r, 'discount', 'prices.js'); r.git('switch', lowerBranch);
  const checks = verifyFixture(f, root, skill, 'implement-small', env);
  assert.equal(checks.checks.find(c => c.id === 'evaluator-acceptance').passed, true);
  assert.equal(r.git('branch', '--show-current'), lowerBranch);
});

test('malformed agent artifact is a failed check, not an evaluator infrastructure error', t => {
  const { root, env, fixture: f } = fixture(t, 'implement-small');
  fs.mkdirSync(path.join(f.repo, '.semantic-review')); fs.writeFileSync(path.join(f.repo, '.semantic-review/manifest.json'), '{broken');
  const checks = verifyFixture(f, root, skill, 'implement-small', env);
  assert.equal(checks.checks.find(c => c.id === 'artifact-publication').passed, false);
});

test('nonterminating implementation is a failed acceptance check, while a missing tool is infrastructure', t => {
  const { root, env, fixture: f } = fixture(t, 'implement-small'), r = repository(f.repo, skill, env);
  initialize(r, 'Discount totals'); begin(r, 'discount', 'Discount totals');
  r.commit('prices.js', 'export function total(items,d=0){if(d===25)while(true){}return items.reduce((s,i)=>s+i.price*i.quantity,0)*(1-d/100)}\n', 'Implement discount');
  finish(r, 'discount', 'prices.js');
  const result = verifyFixture(f, root, skill, 'implement-small', env, { acceptanceTimeoutMs: 250 });
  assert.equal(result.checks.find(c => c.id === 'evaluator-acceptance').passed, false);
  assert.equal(result.evidence['evaluator-acceptance'].errorCode, 'ETIMEDOUT');
  assert.match(result.checks.find(c => c.id === 'evaluator-acceptance').evidence, /ETIMEDOUT/);
  assert.equal(execute(['missing-refinement-executable'], root, env).infrastructureFailure, true);
});

test('corrupted or deleted feedback is failed task evidence, not a verifier crash', t => {
  const { root, env, fixture: f } = fixture(t, 'feedback-compatible');
  completeCompatible(f, env);
  assert.ok(verifyFixture(f, root, skill, 'feedback-compatible', env).checks.every(c => c.passed));
  const inspection = JSON.parse(repository(f.repo, skill, env).cli('semantic-flow', 'inspect', '--json'));
  const thread = path.join(inspection.selected.feedbackDirectory, 'threads/delivery-retries.json');
  fs.writeFileSync(thread, '{broken');
  for (const mutate of [() => {}, () => fs.rmSync(thread)]) {
    mutate(); const result = verifyFixture(f, root, skill, 'feedback-compatible', env);
    assert.equal(result.checks.find(c => c.id === 'one-open-agent-reply').passed, false);
    assert.equal(result.checks.find(c => c.id === 'no-pending-reply').passed, false);
  }
});


test('evaluated calls cannot consume the time reserved for graders', async t => {
  const root = temp(t), job = { id: 'slow-evaluation', kind: 'evaluation' };
  const session = { createdAt: new Date(Date.now() - 59_800).toISOString(), plan: {
    jobs: [job], gradeJobs: [], budget: { maxModelRuns: 2, wallMinutes: 2, runMinutes: 1 }, grading: { reserveMinutes: 1 },
  } };
  const agent = { model: 'scripted', effort: 'none', isolation: 'prompt', transcript: 'text', command: [process.execPath, '-e', 'setTimeout(()=>{},10000)'] };
  const result = await runJob(root, session, job, agent, root, root, 'test');
  assert.equal(result.timedOut, true); assert.equal(result.state, 'invalid'); assert.ok(result.seconds < 2);
  const second = { id: 'not-started', kind: 'evaluation' };
  session.createdAt = new Date(Date.now() - 61_000).toISOString();
  await assert.rejects(() => runJob(root, session, second, agent, root, root, 'test'), /reserved for grading/);
  assert.equal(fs.existsSync(path.join(root, 'runs/not-started/result.json')), false);
});
