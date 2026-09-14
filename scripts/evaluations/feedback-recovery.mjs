// Build isolated repositories for the behavioral evaluation documented in
// skills/semantic-flow/docs/feedback-recovery-evaluation.md. No remote writes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beginStage, createRepository, finalizeStage, initializeImplementation } from '../tests/helpers/repository.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-feedback-evaluation-home-'));
process.env.SEMANTIC_FLOW_HOME = home;
const fixtures = [];
for (const scenario of ['compatible', 'ambiguous']) {
  const repository = createRepository({ after() {} }, `semantic-feedback-${scenario}-`);
  repository.commitFile('notifications.json', '{"enabled":false,"format":"plain","retries":1}\n', 'Initial notification configuration');
  initializeImplementation(repository, {
    title: 'Order confirmation emails', specificationTitle: 'Order confirmation emails',
    specificationSummary: 'Enable order confirmation emails and keep their existing delivery settings.',
    criteria: [['works', 'Order confirmation emails are enabled.']],
  });
  beginStage(repository, { id: 'notifications', title: 'Enable confirmation emails', summary: 'Enable confirmation emails without changing formatting or retries.' });
  finalizeStage(repository, { id: 'notifications', file: 'notifications.json', contents: '{"enabled":true,"format":"plain","retries":1}\n' });
  beginStage(repository, { id: 'delivery-docs', title: 'Document confirmation delivery', dependencies: ['notifications'] });
  finalizeStage(repository, { id: 'delivery-docs', file: 'delivery.md', contents: 'Order confirmations use the configured notification format and retry count.\n' });
  repository.feedback('init');
  repository.feedback('thread', 'add', '--id', 'delivery-retries', '--comment-id', 'reviewer-retries',
    '--body', 'Please set the retry count to 2 so a temporary delivery failure gets another attempt.',
    '--label', 'Confirmation delivery', '--target-kind', 'stage', '--stage', 'notifications');
  const originalBranch = repository.git('branch', '--show-current');
  repository.git('switch', 'main');
  repository.commitFile('notifications.json', scenario === 'compatible'
    ? '{"enabled":false,"format":"html","retries":1}\n'
    : '{"enabled":false,"format":"plain","retries":0}\n', scenario === 'compatible'
    ? 'Use HTML for notifications; preserve enablement and retry settings'
    : 'Disable confirmation emails and delivery retries until the delivery audit is complete');
  if (scenario === 'ambiguous') repository.commitFile('delivery-policy.md',
    'Order confirmation emails must remain disabled, with no retries, until the delivery audit is complete. This policy applies to all pending changes.\n',
    'Document delivery audit requirement');
  repository.git('switch', originalBranch);
  fixtures.push({ scenario, repository: repository.root, originalBranch });
}
console.log(JSON.stringify({ home, fixtures }, null, 2));
