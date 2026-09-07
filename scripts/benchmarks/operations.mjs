// Run from any directory. --scripts <bundled scripts directory> --baseline
// measures an older checkout using the same generated fixtures and tracing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createRepository, initializeImplementation, beginStage, finalizeStage, scriptsDirectory } from '../tests/helpers/repository.mjs';
const args = process.argv.slice(2);
const selected = args.includes('--scripts') ? path.resolve(args[args.indexOf('--scripts') + 1]) : scriptsDirectory;
const baseline = args.includes('--baseline');
const cleanup = [];
const t = { after: (fn) => cleanup.push(fn) };
const traceFile = path.join(os.tmpdir(), `semantic-benchmark-${process.pid}.json`);
const results = [];
function fixture() {
  const repo = createRepository(t, 'semantic-benchmark-');
  for (const [method, file] of [['semantic', 'semantic-implementation'], ['feedback', 'review-feedback'], ['flow', 'semantic-flow']]) {
    repo[method] = (...args) => repo.run(process.execPath, [path.join(selected, `${file}.mjs`), ...args]);
  }
  return repo;
}
function measure(repo, name, commands) {
  fs.writeFileSync(traceFile, '');
  let outputBytes = 0;
  const start = performance.now();
  for (const [file, ...args] of commands) {
    const result = spawnSync(process.execPath, [path.join(selected, `${file}.mjs`), ...args], {
      cwd: repo.root, encoding: 'utf8', env: { ...process.env, GIT_TRACE2_EVENT: traceFile },
    });
    if (result.status !== 0) throw new Error(`${name}: ${result.stderr}`);
    outputBytes += Buffer.byteLength(result.stdout);
  }
  const elapsedMs = Math.round(performance.now() - start);
  const events = fs.readFileSync(traceFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter((event) => event.event === 'start');
  results.push({ operation: name, elapsedMs, cliCalls: commands.length, gitCalls: events.length, blobReads: events.filter((event) => event.argv.includes('show') && event.argv.some((arg) => /^[0-9a-f]{40}:/.test(arg))).length, outputBytes });
}
try {
  const stack = fixture(); initializeImplementation(stack);
  for (let i = 1; i <= 10; i++) { beginStage(stack, { id: `stage-${i}` }); finalizeStage(stack, { id: `stage-${i}` }); }
  measure(stack, 'completion / reconcile / simulate verification', baseline
    ? [['semantic-flow', 'validate', '--publish'], ['semantic-implementation', 'validate-stack']]
    : [['semantic-flow', 'validate', '--publish', '--stack']]);
  measure(stack, 'status', [['semantic-flow', 'status', '--json']]);
  measure(stack, 'prepare stack', baseline
    ? [['semantic-flow', 'validate', '--publish'], ['semantic-implementation', 'publish'], ['semantic-implementation', 'validate-stack']]
    : [['semantic-flow', 'prepare']]);
  const tip = stack.git('rev-parse', 'HEAD'); stack.git('switch', 'main'); stack.git('merge', '--ff-only', tip);
  // Historical archive instructions incorrectly prevalidated the advanced target;
  // measure the actual successful legacy archive command, not that failing sequence.
  measure(stack, 'archive landed stack', baseline ? [['semantic-implementation', 'archive']] : [['semantic-flow', 'archive']]);
  const feedback = fixture(); initializeImplementation(feedback); beginStage(feedback);
  finalizeStage(feedback, { contents: 'x'.repeat(90) + '\n' + 'unchanged context\n'.repeat(20000) }); feedback.feedback('init');
  for (const [start, count] of [[0, 100], [100, 200]]) {
    const threads = Array.from({ length: count }, (_, j) => { const i = start + j; return { id: `thread-${i}`, 'comment-id': `comment-${i}`, body: 'Check this line.', label: 'Line comment', 'target-kind': 'line', stage: 'implementation', path: 'implementation.txt', side: 'new', line: i + 1 }; });
    feedback.feedback('thread', 'add-batch', '--threads', JSON.stringify(threads));
    measure(feedback, `validate ${start + count} line threads`, [['review-feedback', 'validate']]);
    measure(feedback, `reply among ${start + count} line threads`, [['review-feedback', 'thread', 'reply', '--id', 'thread-0', '--comment-id', `agent-${count}`, '--author', 'agent', '--body', 'Checked.']]);
  }
  measure(feedback, 'feedback preflight, 300 threads', [['semantic-flow', 'feedback', '--json']]);
  const viewerModule = await import(pathToFileURL(path.join(selected, 'semantic-view.mjs')));
  const viewer = fixture();
  const large = Array.from({ length: 100000 }, (_, i) => `${String(i).padStart(6, '0')} ${'unchanged context '.repeat(8)}`).join('\n') + '\n';
  viewer.commitFile('large.txt', large, 'Large context');
  initializeImplementation(viewer); beginStage(viewer);
  viewer.write('large.txt', large.replace('050000 ', 'edited '));
  viewer.write('small.txt', 'small\n'); viewer.git('add', '.'); viewer.git('commit', '-m', 'Viewer fixture');
  // Helpers use the selected repo.semantic override, including the old CLI.
  const { organizeStage } = await import('../tests/helpers/repository.mjs');
  organizeStage(viewer); viewer.semantic('stage', 'finish');
  let capturedGitBytes = 0;
  const source = viewerModule.createViewerDataSource(viewer.root, { gitCapture(cwd, args) {
    const output = execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    capturedGitBytes += Buffer.byteLength(output); return output;
  } });
  source.implementationDataScript();
  const stage = viewer.readJson('.semantic-review/stages/implementation.json');
  const start = performance.now(); capturedGitBytes = 0;
  const tiny = await source.fileDiff('implementation', 'small.txt', stage.change.baseRevision, stage.change.headRevision);
  results.push({ operation: 'open small file beside 14 MB mostly unchanged file', elapsedMs: Math.round(performance.now() - start), capturedGitBytes, returnedRows: tiny.lines.length });
  if (!baseline) {
    let reads = 0;
    const snapshot = viewerModule.createSnapshotReader(feedback.root, { readFile(file) { reads++; return fs.readFileSync(file, 'utf8'); } });
    snapshot(); reads = 0; for (let i = 0; i < 20; i++) snapshot();
    results.push({ operation: '20 unchanged snapshot polls, 300 threads', contentReads: reads });
  }
  const skill = path.resolve(selected, '..');
  const bytes = (files) => files.reduce((total, file) => total + fs.statSync(path.join(skill, file)).size, 0);
  const common = ['docs/runtime.md', 'scripts/API.d.ts', 'docs/os/linux.md'];
  const instructionBytes = {
    status: bytes(['commands/status.md', ...(baseline ? common : [])]),
    feedback: bytes(['commands/feedback.md']),
    implementEntry: bytes(['commands/implement.md', 'docs/runtime.md', 'docs/artifact-quality.md', 'docs/os/linux.md', baseline ? 'scripts/API.d.ts' : 'scripts/api/stages.d.ts']),
  };
  console.log(JSON.stringify({ node: process.version, platform: process.platform, baseline, instructionBytes, results }, null, 2));
} finally {
  fs.rmSync(traceFile, { force: true });
  for (const fn of cleanup.reverse()) fn();
}
