import fs from 'node:fs';
import path from 'node:path';
import { broad, scenarios } from './scenarios.mjs';
import { hash, readJson } from './common.mjs';

const idPattern = /^[a-z0-9][a-z0-9-]*$/;
function positive(value, field) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
}
function agent(value, label) {
  if (!value || !idPattern.test(value.id ?? '') || !value.model || !value.effort) throw new Error(`${label} needs id, exact model, and effort`);
  if (!Array.isArray(value.command) || !value.command.length || value.command.some(v => typeof v !== 'string' || !v)) throw new Error(`${label}.command must be an executable/argument array`);
  if (!Array.isArray(value.versionCommand) || !value.versionCommand.length) throw new Error(`${label}.versionCommand is required`);
  if (!['codex-jsonl', 'text'].includes(value.transcript)) throw new Error(`${label}.transcript must be codex-jsonl or text`);
  if (!['sandbox', 'prompt'].includes(value.isolation)) throw new Error(`${label}.isolation must be sandbox or prompt`);
  if (value.preflight !== undefined && !['codex-sandbox', 'none'].includes(value.preflight)) throw new Error(`${label}.preflight must be codex-sandbox or none`);
  for (const arg of value.command) for (const match of arg.matchAll(/\{([^{}]+)\}/g)) {
    if (!['model', 'effort', 'case', 'repo', 'output', 'schema'].includes(match[1])) throw new Error(`Unknown command placeholder {${match[1]}}`);
  }
}
export function plan(config, directory = process.cwd()) {
  if (config.version !== 1) throw new Error('Evaluation config version must be 1');
  if (!['baseline', 'compare'].includes(config.mode)) throw new Error('mode must be baseline or compare');
  positive(config.budget?.maxModelRuns, 'budget.maxModelRuns'); positive(config.budget?.wallMinutes, 'budget.wallMinutes');
  positive(config.budget?.runMinutes, 'budget.runMinutes'); positive(config.grading?.batchSize, 'grading.batchSize');
  positive(config.grading?.reserveMinutes, 'grading.reserveMinutes');
  if (config.grading.reserveMinutes >= config.budget.wallMinutes) throw new Error('Grading reserve must be smaller than the wall budget');
  if (!Array.isArray(config.implementers) || !config.implementers.length) throw new Error('At least one implementer is required');
  config.implementers.forEach((a, i) => agent(a, `implementers[${i}]`)); agent(config.grader, 'grader');
  if (new Set(config.implementers.map(a => a.id)).size !== config.implementers.length) throw new Error('Duplicate implementer id');
  if (!Array.isArray(config.variants) || config.variants.length !== (config.mode === 'baseline' ? 1 : 2)) throw new Error('Baseline needs one variant; comparison needs two');
  if (!Array.isArray(config.scenarios) || !config.scenarios.length) throw new Error('Select scenarios');
  if (new Set(config.scenarios.map(s => s.id)).size !== config.scenarios.length) throw new Error('Duplicate scenario id');
  if (new Set(config.variants.map(v => v.id)).size !== config.variants.length) throw new Error('Duplicate variant id');
  const variants = config.variants.map(v => {
    if (!idPattern.test(v.id ?? '') || typeof v.skill !== 'string') throw new Error('Variant needs a safe id and built skill path');
    return { ...v, skill: path.resolve(directory, v.skill) };
  });
  const selections = config.scenarios.map(s => {
    positive(s.repetitions, `${s.id}.repetitions`);
    if (!idPattern.test(s.id ?? '')) throw new Error('Invalid scenario id');
    if (config.mode === 'compare' && s.repetitions < 3) throw new Error('Comparisons require at least three repetitions per scenario');
    if (s.adapter) {
      const adapter = path.resolve(directory, s.adapter);
      if (!fs.existsSync(adapter)) throw new Error(`Missing custom scenario adapter: ${adapter}`);
      return { ...s, adapter, adapterHash: hash(fs.readFileSync(adapter)) };
    }
    if (!scenarios[s.id]) throw new Error(`Unknown built-in scenario: ${s.id}`);
    return s;
  });
  if (config.mode === 'compare' && broad.some(id => !selections.some(s => s.id === id))) throw new Error('Comparisons must budget the full broad set; screen separately in baseline mode');
  const jobs = [];
  for (const model of config.implementers) for (const selection of selections) for (let repetition = 1; repetition <= selection.repetitions; repetition++) {
    // Alternate A/B order to reduce systematic warm-cache/time drift; preserve explicit pair identity.
    const order = repetition % 2 ? variants : [...variants].reverse();
    for (const variant of order) jobs.push({ id: `${variant.id}-${model.id}-${selection.id}-${repetition}`, kind: 'evaluation', variant: variant.id, model: model.id, scenario: selection.id, repetition });
  }
  const groups = [];
  // Keep paired variants together in the same grader context.
  for (let index = 0; index < jobs.length; index += config.grading.batchSize * variants.length) groups.push(jobs.slice(index, index + config.grading.batchSize * variants.length).map(j => j.id));
  const gradeJobs = [...(config.grading.instructions === false ? [] : [{ id: 'grade-instructions', kind: 'instructions' }]), ...groups.map((members, index) => ({ id: `grade-runs-${index + 1}`, kind: 'runs', members }))];
  if (jobs.length + gradeJobs.length > config.budget.maxModelRuns) throw new Error(`Plan needs ${jobs.length} evaluations + ${gradeJobs.length} graders = ${jobs.length + gradeJobs.length} model runs; budget is ${config.budget.maxModelRuns}. Reduce scope before launching.`);
  return { ...config, variants, scenarios: selections, jobs, gradeJobs, totalModelRuns: jobs.length + gradeJobs.length,
    coverage: { broad: broad.filter(id => selections.some(s => s.id === id)), omitted: broad.filter(id => !selections.some(s => s.id === id)) } };
}
export function loadPlan(file) { return plan(readJson(file), path.dirname(path.resolve(file))); }
