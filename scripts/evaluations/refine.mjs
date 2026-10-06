#!/usr/bin/env node
import path from 'node:path';
import { loadPlan } from './refinement/plan.mjs';
import { prepare, runEvaluations, verify, withLock } from './refinement/session.mjs';
import { grade, report, invalidate } from './refinement/grading.mjs';

const [command, ...args] = process.argv.slice(2);
try {
  if (!command || command === '--help' || command === 'help') {
    console.log(`Semantic Flow maintainer evaluation (no model calls during plan/prepare/verify/report)
  node scripts/evaluations/refine.mjs plan <config.json>
  node scripts/evaluations/refine.mjs prepare <config.json> <new-session-directory>
  node scripts/evaluations/refine.mjs run <session-directory>
  node scripts/evaluations/refine.mjs verify <session-directory>
  node scripts/evaluations/refine.mjs grade <session-directory>
  node scripts/evaluations/refine.mjs report <session-directory>
  node scripts/evaluations/refine.mjs invalidate <session-directory> <run-id> <evidence-based-reason>
Run and grade launch the configured models. Existing attempts are never automatically retried.
Read .agents/skills/refine-semantic-flow/references/harness.md for config and custom scenarios.`);
  } else if (command === 'plan' && args.length === 1) {
    const plan = loadPlan(path.resolve(args[0])); console.log(JSON.stringify({ evaluations: plan.jobs.length, graders: plan.gradeJobs.length, totalModelRuns: plan.totalModelRuns, coverage: plan.coverage, jobs: plan.jobs, gradeJobs: plan.gradeJobs }, null, 2));
  } else if (command === 'prepare' && args.length === 2) {
    const session = await prepare(path.resolve(args[0]), path.resolve(args[1])); console.log(JSON.stringify({ state: session.state, workspace: session.workspace, totalModelRuns: session.plan.totalModelRuns }, null, 2));
  } else if (command === 'invalidate' && args.length === 3) {
    const directory = path.resolve(args[0]);
    await withLock(directory, async () => { invalidate(directory, args[1], args[2]); report(directory); });
  } else if (['run', 'verify', 'grade', 'report'].includes(command) && args.length === 1) {
    const directory = path.resolve(args[0]);
    await withLock(directory, async () => {
      if (command === 'run') await runEvaluations(directory);
      if (command === 'verify') await verify(directory);
      if (command === 'grade') await grade(directory);
      if (command === 'report') { const rows = report(directory); console.log(`${rows.length} result rows; report: ${path.join(directory, 'report.md')}`); }
    });
  } else throw new Error('Invalid command or argument count; use --help');
} catch (error) { console.error(error.message); process.exitCode = 1; }
