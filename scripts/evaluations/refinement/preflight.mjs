import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checked, environment, writeJson } from './common.mjs';

export function sandboxProbeCommand(agent, root, repo) {
  const args = agent.command.map(arg => arg.replaceAll('{case}', root).replaceAll('{repo}', repo));
  if (args[1] !== 'exec' || !args.includes('--ignore-user-config')) throw new Error('Codex preflight requires exec --ignore-user-config');
  let mode, network = false;
  const roots = [repo];
  for (let i = 2; i < args.length; i++) {
    if (['--sandbox', '-s'].includes(args[i])) mode = args[++i];
    else if (args[i] === '--add-dir') roots.push(path.resolve(repo, args[++i]));
    else if (['--profile', '-p', '--dangerously-bypass-approvals-and-sandbox', '--approve-for-me'].includes(args[i])) throw new Error('Codex preflight does not support alternate permission profiles');
    else if (['-c', '--config'].includes(args[i])) {
      const setting = args[++i];
      if (/^sandbox_workspace_write\.network_access\s*=\s*(true|false)$/.test(setting)) network = /true$/.test(setting);
      else if (/^(permissions|default_permissions|sandbox)/.test(setting)) throw new Error(`Unsupported preflight permission override: ${setting}`);
    }
  }
  if (mode !== 'workspace-write') throw new Error('Codex preflight currently supports workspace-write; provide a verified custom adapter for other profiles');
  const entries = { '/': 'read', ...Object.fromEntries(roots.map(root => [root, 'write'])) };
  const filesystem = Object.entries(entries).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(',');
  return [args[0], 'sandbox', '--permission-profile', 'refinement-probe', '-c', `permissions.refinement-probe.filesystem={${filesystem}}`, '-c', `permissions.refinement-probe.network.enabled=${network}`, '-C', repo, '--'];
}

// Exercise stdin/EOF through the same Node runtime used by the bundled CLI.
// A runtime that echoes input but never closes the pipe must fail before paid calls.
const program = `import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
function run(command,args,options={}) {
 const r=spawnSync(command,args,{encoding:'utf8',timeout:3000,...options});
 if(r.error||r.status!==0) throw new Error(command+' capability failed: '+(r.error?.message||r.stderr));
 return r.stdout;
}
for(const input of ['stdin probe',Buffer.from('stdin probe')]) {
 const output=run(process.execPath,['-e','process.stdin.pipe(process.stdout)'],{input});
 if(output!=='stdin probe') throw new Error('Subprocess input did not round-trip');
}
fs.writeFileSync('write-probe','probe');fs.unlinkSync('write-probe');
if(process.argv[2]==='implementer') {
 run('git',['commit','--allow-empty','-qm','Capability probe']);
 const worktree=path.join(process.cwd(),'..','linked');
 run('git',['worktree','add','-q','-b','probe-linked',worktree]);
 run('git',['-C',worktree,'commit','--allow-empty','-qm','Worktree capability probe']);
 run('git',['worktree','remove',worktree]);
}
console.log(JSON.stringify({node:process.version,stdin:true,filesystem:true,git:process.argv[2]==='implementer'}));
`;

export function preflightAgent(agent, role, root, record) {
  if (!agent.preflight || agent.preflight === 'none') {
    const result = { status: 'not-configured', reason: 'No harness capability probe configured; version lookup alone does not verify execution.' };
    writeJson(record, result); return result;
  }
  const repo = path.join(root, 'project'), env = environment(root);
  fs.mkdirSync(repo, { recursive: true });
  checked(['git', 'init', '-q', '-b', 'main'], repo, env);
  checked(['git', 'config', 'user.name', 'Evaluation preflight'], repo, env);
  checked(['git', 'config', 'user.email', 'preflight@example.invalid'], repo, env);
  const script = path.join(root, 'probe.mjs'); fs.writeFileSync(script, program);
  const command = [...sandboxProbeCommand(agent, root, repo), process.execPath, script, role];
  const run = spawnSync(command[0], command.slice(1), { cwd: repo, env, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true });
  const result = { status: run.status === 0 && !run.error ? 'passed' : 'failed', command, exitCode: run.status, error: run.error?.message ?? null, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
  writeJson(record, result);
  if (result.status !== 'passed') throw new Error(`Harness capability probe failed for ${role}:${agent.id}; no model was launched. See ${record}. Check subprocess stdin/EOF and Git sandbox permissions; do not silently relax the configured profile.`);
  return result;
}
