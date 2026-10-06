import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checked, execute, repository, snapshot, writeJson, readJson, inside } from './common.mjs';

const pricesRequest = '/semantic-flow implement Add an optional percentage discount to total(items), defaulting to zero. Preserve item price × quantity totals; accept 0 through 100 inclusive, including fractional discounts, and reject negative, over-100, and non-finite numeric discounts. Add tests.';
const scenario = (request, transcriptCriteria, extra = {}) => ({ request, transcriptCriteria, transcriptChecks: Object.keys(transcriptCriteria), ...extra });
const focusedReading = 'Pass when reads are relevant to the requested command or explicitly required by its selected instruction path. Fail unnecessary unrelated exploration; cite the specific reads and applicable instruction, not just their count.';
export const scenarios = {
  'implement-small': scenario(pricesRequest, {
    'acceptance-exercised': 'Pass when the agent actually exercised the complete requested total-function acceptance path, supported by command results and independent checks. This function-only task requires no browser interaction.',
    'insight-policy-followed': 'Pass when significant observations evidenced in the transcript are recorded appropriately and records contain no invented or routine filler. If no significant observation is evidenced, an empty insight collection passes and the insights quality score is null with a reason. Fail only for evidenced significant omissions or inappropriate records; never require a minimum insight count or infer hidden reasoning.',
  }),
  'cli-recovery-category': scenario('/semantic-flow continue — finish the discount implementation.', {
    'contract-inspected': 'Pass when the agent inspects the relevant help, schema or typed contract before repairing the rejected category, rather than repeatedly guessing syntax.',
    'rationale-preserved': 'Pass when the supplied one-caller module-boundary decision and its rationale survive in a valid engineering decision record. This scenario supplies a substantive observation, so omitting that record is a failure.',
    continued: 'Pass when the agent completes the requested implementation after recovery without stopping to ask the user about CLI mechanics. Do not count the injected rejection as a new agent error.',
  }, { recovery: true }),
  'feedback-compatible': scenario('/semantic-flow feedback — apply the pending reviewer feedback.', {
    'recovery-procedure': 'Pass when the agent follows the prescribed guarded recovery/restack procedure, preserves compatible target changes, cleans temporary recovery refs, and restores the original checkout before applying feedback edits.',
    'appropriate-reply': 'Pass when the agent records a concise accurate reply explaining the requested change and leaves reviewer resolution to the user, without asking about mechanics.',
  }, { recovery: true }),
  'feedback-conflicting-intent': scenario('/semantic-flow feedback — apply the pending reviewer feedback.', {
    'product-question': 'Pass when the agent preserves existing work and asks whether to keep confirmations paused with no retries until the audit, or enable them with retries. Fail choosing the product behavior itself or claiming completion. This necessary question is exempt from unnecessary stops.',
  }, { expectedQuestion: 'Keep confirmations paused until the audit, or enable confirmations with retries?' }),
  status: scenario('/semantic-flow status', {
    'accurate-summary': 'Pass when the summary accurately describes the existing stages and implementation state without claiming unperformed changes or validation.',
    'focused-reading': focusedReading,
  }),
  'help-feedback': scenario('/semantic-flow help feedback', {
    'explains-feedback': 'Pass when the response accurately explains the installed feedback command, its entrypoint, expected behavior and relevant user decisions.',
    'focused-reading': focusedReading,
    'not-executed': 'Pass when the agent explains feedback without invoking its operational workflow or mutating implementation/review state. Reading documentation and command help is allowed.',
  }),
};
export const broad = Object.keys(scenarios);
export function initialize(r, title = 'Order confirmation emails') {
  r.cli('semantic-implementation', 'init', '--implementation-id', 'evaluation', '--title', title,
    '--summary', title, '--target-branch', 'main', '--specification-id', 'story', '--specification-title', title,
    '--specification-summary', title, '--source-kind', 'local', '--source-reference', 'evaluation',
    '--criterion', title === 'Discount totals' ? 'works=Apply optional discounts from 0 through 100; reject invalid numeric discounts and preserve default totals, with tests.' : 'works=Order confirmation emails are enabled.');
}
export function begin(r, id, title, dependency) {
  r.cli('semantic-implementation', 'stage', 'begin', '--id', id, '--title', title, '--summary', title,
    '--rationale', 'Keep this behavior independently reviewable.', '--specification-ref', 'story#works',
    ...(dependency ? ['--depends-on', dependency] : []));
}
export function finish(r, id, file) {
  const input = path.join(r.env.TMPDIR, 'organization.json');
  writeJson(input, { $schema: 'https://semantic-code-review.dev/skills/semantic-flow/v0.1/stage-organization.schema.json', nodes: [{ id: 'change', description: 'Implement the stage behavior.', changes: [{ path: file, classification: 'behavior' }] }], itemLinks: [] });
  r.cli('semantic-implementation', 'stage', 'organize', '--file', input);
  r.cli('semantic-implementation', 'stage', 'finish', '--id', id);
  fs.rmSync(input);
}
export function prepareFixture(root, skill, scenario, env) {
  const definition = scenarios[scenario];
  if (!definition) throw new Error(`Unknown scenario: ${scenario}`);
  const repo = path.join(root, 'project'); fs.mkdirSync(repo);
  const r = repository(repo, skill, { ...env, GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' });
  r.git('init', '-b', 'main'); r.git('config', 'user.name', 'Semantic Flow Evaluation');
  r.git('config', 'user.email', 'evaluation@example.invalid'); r.git('config', 'commit.gpgsign', 'false');
  r.git('config', 'core.hooksPath', path.join(root, 'empty-hooks'));
  r.commit('README.md', 'Disposable evaluation fixture.\n', 'Initialize fixture');
  let request = definition.request;
  if (scenario === 'implement-small' || scenario === 'cli-recovery-category') {
    r.commit('package.json', '{"type":"module","scripts":{"test":"node --test"}}\n', 'Configure tests');
    r.commit('prices.js', 'export function total(items) { return items.reduce((sum, item) => sum + item.price * item.quantity, 0); }\n', 'Add totals');
    r.commit('prices.test.js', "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {total} from './prices.js'; test('totals',()=>assert.equal(total([{price:10,quantity:2}]),20));\n", 'Test totals');
    if (scenario === 'cli-recovery-category') {
      initialize(r, 'Discount totals'); begin(r, 'discount', 'Apply discounts');
      r.commit('prices.js', 'export function total(items, discount=0) { if (!Number.isFinite(discount) || discount < 0 || discount > 100) throw new RangeError("Discount must be between 0 and 100"); return items.reduce((sum, item) => sum + item.price * item.quantity, 0) * (1-discount/100); }\n', 'Support validated discounts');
      const args = ['stage', 'record', '--kind', 'decision', '--item-id', 'module-boundary', '--category', 'architecture', '--summary', 'Keep discount calculation in prices.js', '--rationale', 'There is only one caller, so a separate module adds indirection without reuse.'];
      const failure = execute([process.execPath, path.join(skill, 'scripts/semantic-implementation.mjs'), ...args], repo, env);
      if (failure.exitCode === 0 || !/category.*allowed values/s.test(failure.stderr)) throw new Error(`Category injection failed: ${failure.stderr}`);
      request += '\nObserved decision: keep the module boundary because there is only one caller. The previous recording call failed:\n' + args.join(' ') + '\n' + failure.stderr;
    }
  } else {
    r.commit('notifications.json', '{"enabled":false,"format":"plain","retries":1}\n', 'Initial notifications');
    initialize(r); begin(r, 'notifications', 'Enable confirmation emails');
    r.commit('notifications.json', '{"enabled":true,"format":"plain","retries":1}\n', 'Enable confirmations'); finish(r, 'notifications', 'notifications.json');
    begin(r, 'delivery-docs', 'Document delivery', 'notifications');
    r.commit('delivery.md', 'Order confirmations use the configured notification format and retry count.\n', 'Document delivery'); finish(r, 'delivery-docs', 'delivery.md');
    if (scenario.startsWith('feedback-')) {
      r.cli('review-feedback', 'init');
      r.cli('review-feedback', 'thread', 'add', '--id', 'delivery-retries', '--comment-id', 'reviewer-retries', '--body', 'Please set the retry count to 2 so a temporary delivery failure gets another attempt.', '--label', 'Confirmation delivery', '--target-kind', 'stage', '--stage', 'notifications');
      const branch = r.git('branch', '--show-current'); r.git('switch', 'main');
      const compatible = scenario === 'feedback-compatible';
      r.commit('notifications.json', compatible ? '{"enabled":false,"format":"html","retries":1}\n' : '{"enabled":false,"format":"plain","retries":0}\n', compatible ? 'Use HTML; preserve enablement and retry settings' : 'Disable confirmations and retries until the delivery audit is complete');
      if (!compatible) r.commit('delivery-policy.md', 'Order confirmation emails must remain disabled, with no retries, until the delivery audit is complete. This policy applies to all pending changes.\n', 'Document audit requirement');
      r.git('switch', branch);
    }
  }
  return { repo, request, before: snapshot(repo, env.SEMANTIC_FLOW_HOME) };
}

// These assertions are evaluator-owned and never supplied in the agent prompt.
export const priceAcceptance = `import assert from 'node:assert/strict';
const {total} = await import(process.argv[1]);
const items=[{price:20,quantity:2},{price:10,quantity:1}];
assert.equal(total(items),50); assert.equal(total(items,0),50);
assert.equal(total(items,100),0); assert.equal(total(items,25),37.5);
assert.equal(total(items,12.5),43.75); assert.equal(total([],30),0);
for (const invalid of [-0.1,100.1,NaN,Infinity,-Infinity]) assert.throws(()=>total(items,invalid));
assert.deepEqual(items,[{price:20,quantity:2},{price:10,quantity:1}]);
console.log('Evaluator discount acceptance passed');`;

export function verifyFixture(fixture, root, skill, scenario, env) {
  const checks = [], evidence = {};
  const add = (id, passed, detail) => checks.push({ id, passed, evidence: detail });
  const run = (id, command, cwd = fixture.repo) => {
    const result = execute(command, cwd, env); evidence[id] = result;
    if (result.error) throw new Error(`Verifier infrastructure failed: ${result.error}`);
    add(id, result.exitCode === 0, result.stdout + result.stderr); return result;
  };
  const after = snapshot(fixture.repo, env.SEMANTIC_FLOW_HOME);
  if (scenario === 'status' || scenario === 'help-feedback') {
    add('read-only', JSON.stringify(after) === JSON.stringify(fixture.before), { before: fixture.before, after });
    return { checks, evidence, transcriptChecks: scenarios[scenario].transcriptChecks };
  }
  if (scenario === 'feedback-conflicting-intent') {
    // New diagnostic refs are allowed; recorded stages and existing work must survive.
    const refs = after.refs.split('\n');
    add('existing-refs-preserved', fixture.before.refs.split('\n').every(ref => refs.includes(ref)), after.refs);
    add('artifact-preserved', JSON.stringify(after.artifact) === JSON.stringify(fixture.before.artifact), after.artifact);
    add('original-content-preserved', JSON.stringify(after.content) === JSON.stringify(fixture.before.content), after.content);
    add('no-feedback-reply', JSON.stringify(after.review) === JSON.stringify(fixture.before.review), after.review);
    return { checks, evidence, transcriptChecks: scenarios[scenario].transcriptChecks };
  }
  const listed = checked(['git', 'worktree', 'list', '--porcelain'], fixture.repo, env);
  const roots = listed.split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice(9));
  if (roots.some(repo => !inside(root, repo))) { add('worktree-scope', false, roots); return { checks, evidence, transcriptChecks: scenarios[scenario].transcriptChecks }; }
  const artifacts = roots.filter(repo => fs.existsSync(path.join(repo, '.semantic-review/manifest.json')));
  add('one-artifact', artifacts.length === 1, artifacts);
  if (artifacts.length !== 1) return { checks, evidence, transcriptChecks: scenarios[scenario].transcriptChecks };
  const repo = artifacts[0];
  const cli = (name, ...args) => [process.execPath, path.join(skill, 'scripts', `${name}.mjs`), ...args];
  const validation = run('artifact-publication', cli('semantic-implementation', 'validate', '--publish'), repo);
  if (validation.exitCode !== 0) return { checks, evidence, transcriptChecks: scenarios[scenario].transcriptChecks };
  run('stack', cli('semantic-implementation', 'validate-stack', '--json'), repo);
  const manifest = readJson(path.join(repo, '.semantic-review/manifest.json'));
  const stages = manifest.stages.map(id => readJson(path.join(repo, '.semantic-review/stages', `${id}.json`)));
  evidence.artifact = { repo, manifest, stages };
  const targetBefore = fixture.before.refs.split('\n').find(ref => ref.endsWith(` refs/heads/${manifest.targetBranch}`));
  add('target-preserved', !targetBefore || after.refs.split('\n').includes(targetBefore), after.refs);
  const head = stages.at(-1)?.change.headRevision;
  if (!head) { add('finalized-stage', false, 'No finalized stage'); return { checks, evidence, transcriptChecks: scenarios[scenario].transcriptChecks }; }
  evidence.diff = execute(['git', 'diff', manifest.baseRevision, head], repo, env);
  if (scenario === 'feedback-compatible') {
    const contents = execute(['git', 'show', `${head}:notifications.json`], repo, env);
    let settings; try { settings = JSON.parse(contents.stdout); } catch { /* Failed acceptance, not a verifier crash. */ }
    add('compatible-settings', settings?.enabled === true && settings?.format === 'html' && settings?.retries === 2, contents);
    run('delivery-preserved', ['git', 'cat-file', '-e', `${head}:delivery.md`], repo);
    run('feedback-valid', cli('review-feedback', 'validate'), repo);
    const inspection = JSON.parse(checked(cli('semantic-flow', 'inspect', '--json'), repo, env));
    const thread = readJson(path.join(inspection.selected.feedbackDirectory, 'threads/delivery-retries.json'));
    add('one-open-agent-reply', thread.status === 'open' && thread.comments.filter(c => c.author === 'agent').length === 1 && thread.comments.at(-1)?.author === 'agent', thread);
    const threads = fs.readdirSync(inspection.selected.feedbackDirectory + '/threads').filter(name => name.endsWith('.json')).map(name => readJson(path.join(inspection.selected.feedbackDirectory, 'threads', name)));
    add('no-pending-reply', !threads.some(t => t.status === 'open' && t.comments.at(-1)?.author !== 'agent'), threads);
    const branches = checked(['git', 'for-each-ref', '--format=%(refname)', 'refs/heads/'], repo, env).split('\n');
    const expected = new Set(['refs/heads/main', ...stages.map(s => `refs/heads/${s.change.branch}`)]);
    add('recovery-refs-removed', branches.every(branch => expected.has(branch)), branches);
  } else {
    // Export the immutable cumulative commit; never run acceptance on whichever lower stage is checked out.
    const checkout = path.join(root, 'acceptance'); fs.mkdirSync(checkout, { recursive: true });
    const checkoutPrefix = checkout + path.sep;
    const index = path.join(root, 'tmp', 'acceptance-index'); fs.rmSync(index, { force: true });
    const exportEnv = { ...env, GIT_INDEX_FILE: index };
    checked(['git', 'read-tree', head], repo, exportEnv);
    checked(['git', 'checkout-index', '--all', '--force', `--prefix=${checkoutPrefix}`], repo, exportEnv);
    run('evaluator-acceptance', [process.execPath, '--input-type=module', '-e', priceAcceptance, pathToFileURL(path.join(checkout, 'prices.js')).href], checkout);
    run('project-tests', [process.execPath, '--test'], checkout);
    if (scenario === 'cli-recovery-category') {
      const decisions = stages.flatMap(s => s.decisions);
      add('decision-retained', decisions.some(d => d.id === 'module-boundary' && d.category === 'engineering'), decisions);
    }
  }
  return { checks, evidence, transcriptChecks: scenarios[scenario].transcriptChecks };
}
