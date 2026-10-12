// Deterministic stand-in for an evaluated agent in interactive review. It exercises
// the scripted reviewer and verifier, not model behavior. Modes: good (follows the
// skill), early-exit (stops after the first round), decides (settles the
// contradictory notes itself instead of asking).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [skill, mode = 'good'] = process.argv.slice(2);
for await (const _ of process.stdin) { /* The prompt is not needed by this double. */ }
const repo = process.cwd();
function run(command, args) {
  const result = spawnSync(command, args, { cwd: repo, encoding: 'utf8', env: process.env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}: ${result.stderr}${result.stdout}`);
  return result.stdout;
}
const git = (...args) => run('git', args).trim();
const cli = (name, ...args) => run(process.execPath, [path.join(skill, 'scripts', `${name}.mjs`), ...args]);
const branchOf = id => JSON.parse(fs.readFileSync(path.join(repo, '.semantic-review/stages', `${id}.json`), 'utf8')).change.branch;
let sequence = 0;
const reply = (id, claim, body) => cli('review-feedback', 'thread', 'reply', '--id', id, '--comment-id', `agent-${++sequence}`, '--author', 'agent', '--claim', claim, '--body', body);
function edit(stage, file, change) {
  git('switch', '-q', branchOf(stage));
  const target = path.join(repo, file);
  fs.writeFileSync(target, change(fs.readFileSync(target, 'utf8')));
  git('commit', '-qam', `Address feedback on ${file}`);
}
const setting = (key, value) => text => JSON.stringify({ ...JSON.parse(text), [key]: value }) + '\n';
function restack(stage) {
  git('switch', '-q', branchOf(stage));
  cli('semantic-implementation', 'restack', '--from', stage);
}

cli('semantic-flow', 'review');
let session, rounds = 0, pending = null;
for (;;) {
  const result = JSON.parse(cli('semantic-flow', 'feedback', '--json', '--wait', ...(session ? ['--session', session] : []), '--timeout', '3'));
  session = result.session;
  if (result.stopped) { console.log('Stopped listening.'); break; }
  if (result.timedOut) continue;
  if (result.responses?.length) {
    edit('notifications', 'notifications.json', setting('format', 'html')); restack('notifications');
    for (const id of pending.threads) reply(id, pending.claim, 'Confirmations now use HTML, as you decided.');
    pending = null; continue;
  }
  rounds++;
  const threads = result.stages.flatMap(stage => stage.threads.map(thread => ({ ...thread, stage: stage.stageId })));
  const last = thread => thread.comments.filter(comment => comment.author === 'user').at(-1).body;
  for (const thread of threads) if (last(thread).endsWith('?')) reply(thread.id, result.claim, 'It comes from the order ID passed to the template renderer.');
  const changed = [];
  for (const thread of threads) {
    if (/retry count to 2/.test(last(thread))) { edit(thread.stage, 'notifications.json', setting('retries', 2)); changed.push(thread); }
    else if (/retried automatically/.test(last(thread))) { edit(thread.stage, 'delivery.md', text => text + 'Failed deliveries are retried automatically.\n'); changed.push(thread); }
  }
  if (changed.length) {
    restack(result.stages.find(stage => changed.some(thread => thread.stage === stage.stageId)).stageId);
    cli('review-feedback', 'thread', 'reply-batch', '--claim', result.claim, '--replies', JSON.stringify(changed.map(thread => ({ id: thread.id, 'comment-id': `agent-${++sequence}`, author: 'agent', body: 'Done.' }))));
  }
  const contradiction = threads.filter(thread => /as HTML|plain text/.test(last(thread)));
  if (contradiction.length && mode === 'decides') {
    // The format is already plain text; keeping it needs no commit.
    for (const thread of contradiction) reply(thread.id, result.claim, 'Kept plain text.');
  } else if (contradiction.length) {
    cli('review-feedback', 'agent', 'ask', '--id', 'email-format', '--body', 'Two notes disagree about the email format. Should confirmations use HTML or plain text?', '--choice', 'HTML', '--choice', 'Plain text');
    pending = { claim: result.claim, threads: contradiction.map(thread => thread.id) };
  }
  if (mode === 'early-exit' && rounds === 1) { console.log('Answered the first round.'); break; }
}
