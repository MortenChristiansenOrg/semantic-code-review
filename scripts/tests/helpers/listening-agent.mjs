// Deterministic stand-in for an evaluated agent while it listens to a review. It exercises
// the scripted reviewer and verifier, not model behavior. Modes: good (follows the
// skill), early-exit (stops after the first round), decides (settles the
// contradictory notes itself instead of asking), sloppy (documents that deliveries
// are never retried and resolves the reviewer's threads).
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
const cli = (...args) => run(process.execPath, [path.join(skill, 'scripts', 'semantic-flow.mjs'), ...args]);
const branchOf = id => JSON.parse(cli('implementation', 'export')).stages[id].change.branch;
let sequence = 0;
const reply = (id, claim, body) => cli('feedback', 'thread', 'reply', '--id', id, '--comment-id', `agent-${++sequence}`, '--author', 'agent', '--claim', claim, '--body', body);
// Every change names its round, so a round another agent took over changes nothing.
function edit(stage, file, change, claim) {
  git('switch', '-q', branchOf(stage));
  const target = path.join(repo, file);
  fs.writeFileSync(target, change(fs.readFileSync(target, 'utf8')));
  cli('feedback', 'agent', 'progress', '--claim', claim, '--body', `Committing ${file}`);
  git('commit', '-qam', `Address feedback on ${file}`);
}
const setting = (key, value) => text => JSON.stringify({ ...JSON.parse(text), [key]: value }) + '\n';
function restack(stage, claim) {
  git('switch', '-q', branchOf(stage));
  cli('implementation', 'restack', '--from', stage, '--claim', claim);
}

cli('review');
let session, rounds = 0, pending = null;
for (;;) {
  const result = JSON.parse(cli('feedback', '--json', '--wait', ...(session ? ['--session', session] : []), '--timeout', '3'));
  session = result.session;
  if (result.stopped) { console.log('Stopped listening.'); break; }
  if (result.timedOut) continue;
  if (result.responses?.length) {
    edit('notifications', 'notifications.json', setting('format', 'html'), pending.claim); restack('notifications', pending.claim);
    for (const id of pending.threads) reply(id, pending.claim, 'Confirmations now use HTML, as you decided.');
    if (mode === 'sloppy') {
      const reviews = path.join(process.env.SEMANTIC_FLOW_HOME, 'reviews'), threads = path.join(reviews, fs.readdirSync(reviews)[0], 'feedback', 'threads');
      for (const name of fs.readdirSync(threads)) cli('feedback', 'thread', 'resolve', '--id', name.slice(0, -'.json'.length));
    }
    pending = null; continue;
  }
  rounds++;
  const threads = result.stages.flatMap(stage => stage.threads.map(thread => ({ ...thread, stage: stage.stageId })));
  const last = thread => thread.comments.filter(comment => comment.author === 'user').at(-1).body;
  for (const thread of threads) if (last(thread).endsWith('?')) reply(thread.id, result.claim, 'It comes from the order ID passed to the template renderer.');
  const changed = [];
  for (const thread of threads) {
    if (/retry count to 2/.test(last(thread))) { edit(thread.stage, 'notifications.json', setting('retries', 2), result.claim); changed.push(thread); }
    else if (/retried automatically/.test(last(thread))) { edit(thread.stage, 'delivery.md', text => text + (mode === 'sloppy' ? 'Failed deliveries are never retried.\n' : 'Failed deliveries are retried automatically.\n'), result.claim); changed.push(thread); }
  }
  if (changed.length) {
    restack(result.stages.find(stage => changed.some(thread => thread.stage === stage.stageId)).stageId, result.claim);
    cli('feedback', 'thread', 'reply-batch', '--claim', result.claim, '--replies', JSON.stringify(changed.map(thread => ({ id: thread.id, 'comment-id': `agent-${++sequence}`, author: 'agent', body: 'Done.' }))));
  }
  const contradiction = threads.filter(thread => /as HTML|plain text/.test(last(thread)));
  if (contradiction.length && mode === 'decides') {
    // The format is already plain text; keeping it needs no commit.
    for (const thread of contradiction) reply(thread.id, result.claim, 'Kept plain text.');
  } else if (contradiction.length) {
    cli('feedback', 'agent', 'ask', '--id', 'email-format', '--claim', result.claim, '--body', 'Two notes disagree about the email format. Should confirmations use HTML or plain text?', '--choice', 'HTML', '--choice', 'Plain text');
    pending = { claim: result.claim, threads: contradiction.map(thread => thread.id) };
  }
  if (mode === 'early-exit' && rounds === 1) { console.log('Answered the first round.'); break; }
}
