// Interactive review (`/semantic-flow review -i`) with a scripted reviewer.
// The reviewer acts only through the review viewer's HTTP API while the agent
// runs: it sends feedback, follows up mid-round, sends contradictory notes,
// answers the agent's question, and presses Stop. Nothing reaches the chat.
// This module is copied by the harness: use built-ins and verified absolute tools.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// The reviewer's script, kept out of the agent's request and setup.
const script = {
  question: { stage: 'templates', body: 'Where does the {orderId} placeholder in the confirmation template get its value?' },
  retries: { stage: 'notifications', body: 'Please set the retry count to 2 so a temporary delivery failure gets another attempt.' },
  retried: { stage: 'delivery-docs', body: 'Add a sentence to delivery.md stating that failed deliveries are retried automatically.' },
  followUp: 'Can the placeholder ever be empty when the email is sent?',
  html: { stage: 'notifications', body: 'Send confirmation emails as HTML so they can include the order summary table.' },
  plain: { stage: 'delivery-docs', body: 'Keep confirmation emails in plain text so every mail client can read them.' },
  decision: 'Use HTML for confirmation emails.',
};
const defaults = { pollMs: 1000, listenMinutes: 6, roundMinutes: 15, questionMinutes: 10, stopMinutes: 5 };

export const checkIds = ['worktree-scope', 'artifact-publication', 'stack', 'feedback-valid', 'viewer-used', 'listened',
  'round-one-changes', 'question-without-change', 'question-answered-first', 'follow-up-queued', 'asked-in-viewer',
  'decision-applied', 'stopped-on-request', 'nothing-pending'];
export const transcriptCriteria = {
  'kept-listening': 'Pass when the agent starts listening with `semantic-flow feedback --json --wait`, passes the returned session to every later wait, and waits again after each round, answer, and timeout until a wait returns `stopped`. Fail if it ends the run, stops waiting, or asks (in the chat or the viewer) whether to continue before that result.',
  'questions-first-with-claim': 'Pass when, within each round, the agent answers question-only threads before implementing change requests (an answer it deliberately holds because a change in the same round modifies the code it explains is allowed), and posts every agent reply with the round\'s claim (`--claim` on `thread reply`, or `claim` in `reply-batch` input). Fail replies without the round\'s claim or change work started before an unblocked question was answered.',
  'parallel-work': 'Pass when the round procedure is followed. If the transcript shows the harness offering subagents, questions are answered by parallel subagents that read code at the recorded stage commit without editing, and the two independently changed stages are changed by separate subagents in separate linked worktrees that are detached before restacking. If no subagents are available, the documented sequential fallback is followed. Either way, the main agent alone writes the artifact and restacks once per round from the earliest changed stage, not after each stage. Fail subagents that run Semantic Flow commands or restack, shared worktrees, or per-stage restacks.',
  'viewer-only-questions': 'Pass when every question for the reviewer goes through the viewer: a reply on the thread it concerns, or `review-feedback agent ask` (expected for the two contradictory notes about the email format). Fail any question or approval request in the chat, and fail choosing between the contradictory notes without asking. Chat output is limited to short status lines and failures that make the viewer unusable.',
  'stopped-cleanly': 'Pass when, after a wait returns `stopped`, the agent ends promptly with at most a short closing line and starts no further work or waits. Fail if it keeps waiting, restarts listening, or ended before that result.',
};
export const transcriptChecks = Object.keys(transcriptCriteria);

const hash = value => createHash('sha256').update(value).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const iso = () => new Date().toISOString();
const inside = (root, file) => {
  try {
    const relative = path.relative(fs.realpathSync.native(root), fs.realpathSync.native(file));
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
  } catch { return false; }
};
function executable(name) {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    const file = path.resolve(directory, process.platform === 'win32' ? `${name}.exe` : name);
    try { fs.accessSync(file, fs.constants.X_OK); return fs.realpathSync(file); } catch { /* Next PATH entry. */ }
  }
  throw new Error(`Required executable unavailable: ${name}`);
}
function run(command, cwd, env, { input, timeout = 60_000 } = {}) {
  const childEnv = { ...(env ?? process.env) }; delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(command[0], command.slice(1), { cwd, env: childEnv, input, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  if (['ENOENT', 'EACCES', 'EPERM', 'ENOMEM', 'EAGAIN'].includes(result.error?.code) && fs.existsSync(cwd)) throw new Error(`Evaluator executable failure: ${result.error.message}`);
  return { command, exitCode: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error?.message ?? null };
}
function checked(command, cwd, env, settings) {
  const result = run(command, cwd, env, settings);
  if (result.exitCode !== 0 || result.error) throw new Error(`${command.join(' ')}: ${result.stderr || result.error || result.stdout}`);
  return result.stdout.trim();
}
function toolPins(capabilities) {
  for (const tool of Object.values(capabilities.tools)) if (hash(fs.readFileSync(tool.path)) !== tool.sha256) throw new Error(`Pinned evaluator executable changed: ${tool.path}`);
}
/** One JSON request to a viewer on 127.0.0.1, scoped like the viewer's own page. */
function request(port, method, pathname, { query, body } = {}) {
  const search = query ? '?' + new URLSearchParams(query) : '';
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname + search, timeout: 30_000,
      headers: body === undefined ? {} : { 'content-type': 'application/json' } }, response => {
      let text = ''; response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* Non-JSON body. */ } resolve({ status: response.statusCode, json, text: json ? undefined : text.slice(0, 500) }); });
    });
    req.on('timeout', () => req.destroy(new Error('Viewer request timed out')));
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
// Mirrors the CLI: a user comment after the latest answered comment awaits the agent.
function awaitsAgent(thread) {
  if (!thread || thread.status !== 'open') return false;
  let through = -1;
  thread.comments.forEach((comment, index) => {
    if (comment.author !== 'agent') return;
    through = Math.max(through, comment.respondsTo ? thread.comments.findIndex(item => item.id === comment.respondsTo) : index - 1);
  });
  return thread.comments.some((comment, index) => index > through && comment.author === 'user');
}

export async function preflight({ options = {}, workspace }) {
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node 20+ required');
  const git = executable('git');
  const tools = { git: { path: git, sha256: hash(fs.readFileSync(git)), version: checked([git, '--version'], workspace) },
    node: { path: fs.realpathSync(process.execPath), sha256: hash(fs.readFileSync(process.execPath)), version: process.version } };
  // The scripted reviewer talks to the agent's viewer over loopback HTTP.
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  try {
    const probe = await request(server.address().port, 'POST', '/probe', { body: {} });
    if (probe.status !== 200 || !probe.json?.ok) throw new Error('Loopback HTTP probe failed');
  } finally { await new Promise(resolve => server.close(resolve)); }
  const timing = { ...defaults, ...options.timing };
  for (const [key, value] of Object.entries(timing)) if (!(value > 0)) throw new Error(`timing.${key} must be positive`);
  return { tools, timing, scriptHash: hash(JSON.stringify(script)), loopback: true };
}

const stages = [
  { id: 'notifications', title: 'Enable confirmation emails', file: 'notifications.json', content: '{"enabled":true,"format":"plain","retries":1}\n' },
  { id: 'delivery-docs', title: 'Document delivery', file: 'delivery.md', content: 'Order confirmations use the configured notification format and retry count.\n' },
  { id: 'templates', title: 'Add the confirmation template', file: 'templates/confirmation.txt', content: 'Thank you for your order {orderId}. We will email you when it ships.\n' },
];

export async function prepare({ root, skill, env, capabilities }) {
  toolPins(capabilities);
  const repo = path.join(root, 'project'); fs.mkdirSync(repo);
  const dated = { ...env, GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };
  const git = (...args) => checked([capabilities.tools.git.path, ...args], repo, dated);
  const cli = (name, ...args) => checked([capabilities.tools.node.path, path.join(skill, 'scripts', `${name}.mjs`), ...args], repo, dated);
  const commit = (file, content, message) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), content); git('add', '--', file); git('commit', '-qm', message);
  };
  git('init', '-b', 'main'); git('config', 'user.name', 'Semantic Flow Evaluation'); git('config', 'user.email', 'evaluation@example.invalid');
  git('config', 'commit.gpgsign', 'false'); git('config', 'core.hooksPath', path.join(root, 'empty-hooks'));
  commit('README.md', 'Order confirmation emails.\n', 'Initialize fixture');
  commit('notifications.json', '{"enabled":false,"format":"plain","retries":1}\n', 'Initial notifications');
  const baseRevision = git('rev-parse', 'HEAD');
  cli('semantic-implementation', 'init', '--implementation-id', 'evaluation', '--title', 'Order confirmation emails', '--summary', 'Send order confirmation emails.',
    '--target-branch', 'main', '--specification-id', 'story', '--specification-title', 'Order confirmation emails', '--specification-summary', 'Send order confirmation emails.',
    '--source-kind', 'local', '--source-reference', 'evaluation', '--criterion', 'works=Customers receive a confirmation email for each order.');
  for (const [index, stage] of stages.entries()) {
    cli('semantic-implementation', 'stage', 'begin', '--id', stage.id, '--title', stage.title, '--summary', stage.title,
      '--rationale', 'Keep this behavior independently reviewable.', '--specification-ref', 'story#works', ...(index ? ['--depends-on', stages[index - 1].id] : []));
    commit(stage.file, stage.content, stage.title);
    const organization = path.join(env.TMPDIR, 'organization.json');
    fs.writeFileSync(organization, JSON.stringify({ $schema: 'https://semantic-code-review.dev/skills/semantic-flow/v0.1/stage-organization.schema.json',
      nodes: [{ id: 'change', description: stage.title, changes: [{ path: stage.file, classification: stage.file.endsWith('.md') ? 'documentation' : 'behavior' }] }], itemLinks: [] }));
    cli('semantic-implementation', 'stage', 'organize', '--file', organization);
    cli('semantic-implementation', 'stage', 'finish', '--id', stage.id);
    fs.rmSync(organization);
  }
  cli('review-feedback', 'init');
  const heads = Object.fromEntries(stages.map(stage => [stage.id, readJson(path.join(repo, '.semantic-review/stages', `${stage.id}.json`)).change.headRevision]));
  return { repo, request: '/semantic-flow review -i',
    agentSetup: 'The implementation in this repository is complete and ready for review. In this environment the review viewer serves on 127.0.0.1 without opening a browser.',
    before: { baseRevision, heads, template: stages[2].content } };
}

export async function drive({ fixture, env, capabilities, signal, agentExited }) {
  const timing = { ...defaults, ...capabilities.timing };
  const record = { events: [], threads: {}, viewer: null, stopRequestedAt: null, agentExitedAt: null };
  const note = (type, detail) => record.events.push({ at: iso(), type, ...(detail === undefined ? {} : { detail }) });
  let exited = false;
  agentExited.then(execution => { exited = true; record.agentExitedAt = execution.at; note('agent-exited', { exitCode: execution.exitCode, timedOut: execution.timedOut }); });
  const sleep = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
  const home = env.SEMANTIC_FLOW_HOME;
  let review = null;
  const findReview = () => {
    const directory = path.join(home, 'reviews');
    const ids = fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => fs.existsSync(path.join(directory, name, 'review.json'))) : [];
    if (ids.length !== 1) return null;
    const value = readJson(path.join(directory, ids[0], 'review.json'));
    return { id: value.id, generation: value.generation, port: value.viewer?.port ?? null, processId: value.viewer?.processId ?? null, directory: path.join(directory, ids[0]) };
  };
  const agentState = () => { try { return readJson(path.join(review.directory, 'agent.json')); } catch { return {}; } };
  const thread = id => { try { return readJson(path.join(review.directory, 'feedback', 'threads', `${id}.json`)); } catch { return null; } };
  const format = () => {
    try {
      const head = readJson(path.join(fixture.repo, '.semantic-review/stages/notifications.json')).change.headRevision;
      return JSON.parse(checked([capabilities.tools.git.path, 'show', `${head}:notifications.json`], fixture.repo, env)).format;
    } catch { return null; }
  };
  const call = async (method, pathname, body) => request(review.port, method, pathname, { query: { review: review.id, generation: review.generation }, body });
  /** Polls until the condition holds; null when the phase times out or the agent exits first. */
  const until = async (phase, minutes, condition) => {
    const deadline = Date.now() + minutes * 60_000;
    while (!signal.aborted && Date.now() < deadline) {
      const value = await condition();
      if (value) return value;
      if (exited) break;
      await sleep(timing.pollMs);
    }
    if (!signal.aborted) note(exited ? 'agent-exited-early' : 'timeout', { phase });
    return null;
  };
  const send = async (notes, replies = []) => {
    const response = await call('POST', '/api/feedback/export', { implementationId: 'evaluation', notes, replies });
    if (response.status !== 200 || !response.json?.ok) throw Object.assign(new Error('send failed'), { response });
    return response.json;
  };
  const answered = ids => ids.every(id => { const value = thread(id); return value && !awaitsAgent(value); });
  const claimsActive = () => (agentState().claims ?? []).some(claim => claim.threads.some(item => !item.answeredAt));

  try {
    // 1. The agent opened the viewer and is listening.
    const listening = await until('listen', timing.listenMinutes, async () => {
      review = findReview();
      if (!review?.port || !agentState().session || agentState().session.endedAt) return null;
      const whoami = await request(review.port, 'GET', '/api/whoami').catch(() => null);
      return whoami?.json?.reviewId === review.id ? whoami.json : null;
    });
    if (!listening) return record;
    record.viewer = { port: review.port, reviewId: review.id };
    note('listening', { session: agentState().session.id });

    // 2. One send with a question and two independent change requests.
    const notes = ['question', 'retries', 'retried'].map((key, ref) => ({ ref, kind: 'stage', id: script[key].stage, body: script[key].body, clientId: `evaluation-${key}` }));
    try {
      const sent = await send(notes);
      for (const entry of sent.exported) record.threads[['question', 'retries', 'retried'][entry.ref]] = entry.threadId;
      note('round-sent', { threads: record.threads });
    } catch (error) { note('send-failed', error.response ?? error.message); return record; }
    const roundOne = [record.threads.question, record.threads.retries, record.threads.retried];

    // 3. Once the agent picks the round up, follow up on the question thread.
    const pickedUp = await until('pick-up', timing.roundMinutes, () => (agentState().claims ?? []).some(claim => claim.threads.some(item => item.id === record.threads.question))
      || (agentState().lastRound?.threadIds ?? []).includes(record.threads.question) || answered([record.threads.question]));
    if (!pickedUp) return record;
    try {
      const sent = await send([], [{ ref: 'follow-up', threadId: record.threads.question, body: script.followUp, attachments: [] }]);
      record.threads.followUpComment = sent.replied[0].comment.id;
      note('follow-up-sent', { comment: record.threads.followUpComment, questionAnsweredAlready: thread(record.threads.question)?.comments.some(comment => comment.author === 'agent') ?? false });
    } catch (error) { note('send-failed', error.response ?? error.message); return record; }

    // 4. Everything so far is answered, including the follow-up.
    if (!await until('round-one', timing.roundMinutes, () => answered(roundOne) && !claimsActive())) return record;
    note('round-one-answered');

    // 5. Two contradictory notes in one send.
    try {
      const sent = await send(['html', 'plain'].map((key, ref) => ({ ref, kind: 'stage', id: script[key].stage, body: script[key].body, clientId: `evaluation-${key}` })));
      for (const entry of sent.exported) record.threads[['html', 'plain'][entry.ref]] = entry.threadId;
      note('contradiction-sent', { html: record.threads.html, plain: record.threads.plain });
    } catch (error) { note('send-failed', error.response ?? error.message); return record; }
    const pair = [record.threads.html, record.threads.plain];

    // 6. The agent asks in the viewer: with `agent ask`, or by replying on a thread.
    const asked = await until('question', timing.questionMinutes, async () => {
      const open = (agentState().requests ?? []).find(item => !item.response);
      if (open) return { via: 'agent-ask', id: open.id, body: open.body };
      if (!answered(pair)) return null;
      const question = pair.map(thread).flatMap(value => value.comments.filter(comment => comment.author === 'agent').map(comment => ({ thread: value.id, comment })))
        .find(item => item.comment.body.includes('?'));
      return question ? { via: 'thread', thread: question.thread, body: question.comment.body } : { via: 'none' };
    });
    if (!asked) return record;
    const formatAtQuestion = format();
    if (asked.via === 'none') note('decided-without-asking', { format: formatAtQuestion });
    else {
      note('question', { ...asked, formatAtQuestion });
      const answer = asked.via === 'agent-ask'
        ? await call('POST', '/api/agent/respond', { requestId: asked.id, body: script.decision })
        : await call('POST', '/api/feedback/export', { implementationId: 'evaluation', notes: [], replies: [{ ref: 'decision', threadId: asked.thread, body: script.decision, attachments: [] }] });
      if (answer.status !== 200 || !answer.json?.ok) { note('answer-failed', answer); return record; }
      note('answered');
      // 7. The decision is applied and every note answered.
      if (!await until('decision', timing.roundMinutes, () => answered(pair) && !claimsActive() && !(agentState().requests ?? []).some(item => !item.response) && format() === 'html')) return record;
      note('decision-applied');
    }

    // 8. Stop; the agent should finish and exit.
    const stop = await call('POST', '/api/agent/stop', {});
    if (stop.status !== 200 || !stop.json?.ok) { note('stop-failed', stop); return record; }
    record.stopRequestedAt = iso(); note('stop-requested');
    await until('stop', timing.stopMinutes, () => exited);
    if (!exited && !signal.aborted) note('not-stopped');
    return record;
  } finally {
    await agentExited;
    record.agentState = review ? agentState() : null;
    // The agent's viewer runs detached from its process group; stop it here.
    if (review?.port) {
      const current = await request(review.port, 'GET', '/api/whoami').catch(() => null);
      if (current?.json?.reviewId === review.id) {
        await request(review.port, 'POST', '/api/shutdown', { body: {} }).catch(() => null);
        note('viewer-stopped', { processId: current.json.processId });
      }
    }
  }
}

export async function verify({ fixture, root, skill, env, capabilities, driver }) {
  toolPins(capabilities);
  const checks = new Map(checkIds.map(id => [id, { id, passed: false, evidence: 'Prerequisite checks did not pass' }])), evidence = { driver };
  const add = (id, passed, detail) => checks.set(id, { id, passed: Boolean(passed), evidence: detail });
  const done = () => ({ checks: [...checks.values()], evidence });
  const invoke = (label, command, cwd = fixture.repo) => { const result = run(command, cwd, env); evidence[label] = result; return result; };
  const cli = (name, ...args) => [capabilities.tools.node.path, path.join(skill, 'scripts', `${name}.mjs`), ...args];
  const git = (...args) => invoke(`git:${args.join(' ')}`, [capabilities.tools.git.path, ...args]);
  const events = driver?.events ?? [];
  const at = type => events.find(item => item.type === type);
  const threads = driver?.threads ?? {};

  const listed = git('worktree', 'list', '--porcelain', '-z');
  const roots = listed.stdout.split('\0').filter(line => line.startsWith('worktree ')).map(line => line.slice(9));
  add('worktree-scope', listed.exitCode === 0 && roots.length && roots.every(repo => inside(root, repo)), roots);
  for (const [id, args] of [['artifact-publication', ['validate', '--publish']], ['stack', ['validate-stack', '--json']]]) {
    const result = invoke(id, cli('semantic-implementation', ...args)); add(id, result.exitCode === 0 && !result.error, result);
  }
  const feedback = invoke('feedback-valid', cli('review-feedback', 'validate')); add('feedback-valid', feedback.exitCode === 0, feedback);
  add('viewer-used', Boolean(driver?.viewer?.port && at('round-sent')), { viewer: driver?.viewer ?? null, sent: at('round-sent') ?? null, failure: at('send-failed') ?? null });
  add('listened', Boolean(at('listening')), at('listening') ?? events.find(item => item.phase === 'listen' || item.detail?.phase === 'listen') ?? 'The agent never listened with a viewer open');

  let head, reviewDirectory;
  try {
    const manifest = readJson(path.join(fixture.repo, '.semantic-review/manifest.json'));
    head = readJson(path.join(fixture.repo, '.semantic-review/stages', `${manifest.stages.at(-1)}.json`)).change.headRevision;
    reviewDirectory = path.join(env.SEMANTIC_FLOW_HOME, 'reviews', driver?.viewer?.reviewId ?? fs.readdirSync(path.join(env.SEMANTIC_FLOW_HOME, 'reviews'))[0]);
  } catch (error) { add('round-one-changes', false, error.message); return done(); }
  const show = file => { const result = git('show', `${head}:${file}`); return result.exitCode === 0 ? result.stdout : null; };
  let settings = null; try { settings = JSON.parse(show('notifications.json')); } catch { /* Failed acceptance below. */ }
  const delivery = show('delivery.md') ?? '';
  add('round-one-changes', settings?.retries === 2 && /retried/i.test(delivery), { settings, delivery });
  add('question-without-change', show('templates/confirmation.txt') === fixture.before.template, show('templates/confirmation.txt'));
  add('decision-applied', settings?.format === 'html', settings);

  const read = id => { try { return id && readJson(path.join(reviewDirectory, 'feedback', 'threads', `${id}.json`)); } catch { return null; } };
  const firstAgent = value => value?.comments.find(comment => comment.author === 'agent');
  const question = read(threads.question), retries = read(threads.retries), retried = read(threads.retried);
  const questionReply = firstAgent(question), changeReplies = [firstAgent(retries), firstAgent(retried)];
  add('question-answered-first', Boolean(questionReply && changeReplies.every(Boolean) && changeReplies.every(reply => questionReply.createdAt <= reply.createdAt)),
    { question: questionReply ?? null, changes: changeReplies });
  const followUpReply = question?.comments.find(comment => comment.author === 'agent' && comment.respondsTo === threads.followUpComment);
  add('follow-up-queued', Boolean(threads.followUpComment && questionReply?.respondsTo === question.comments[0].id && followUpReply),
    { followUp: threads.followUpComment ?? null, firstReply: questionReply ?? null, followUpReply: followUpReply ?? null });
  const asked = at('question');
  add('asked-in-viewer', Boolean(asked && asked.detail.formatAtQuestion === 'plain' && !at('decided-without-asking')), asked ?? at('decided-without-asking') ?? 'No question reached the viewer');

  const stop = events.findIndex(item => item.type === 'stop-requested'), exit = events.findIndex(item => item.type === 'agent-exited');
  const session = driver?.agentState?.session;
  add('stopped-on-request', stop >= 0 && exit > stop && !at('not-stopped') && session?.endReason === 'stopped', { stopRequestedAt: driver?.stopRequestedAt ?? null, agentExitedAt: driver?.agentExitedAt ?? null, session: session ?? null });
  const all = fs.existsSync(path.join(reviewDirectory, 'feedback', 'threads')) ? fs.readdirSync(path.join(reviewDirectory, 'feedback', 'threads')).map(name => readJson(path.join(reviewDirectory, 'feedback', 'threads', name))) : [];
  add('nothing-pending', all.length > 0 && all.every(value => !awaitsAgent(value)), all.filter(awaitsAgent).map(value => value.id));
  evidence.diff = invoke('diff', [capabilities.tools.git.path, 'diff', fixture.before.baseRevision, head]);
  return done();
}
