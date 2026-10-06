import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(temporary, file);
}
export const hash = value => createHash('sha256').update(value).digest('hex');
function physicalPath(file) {
  let current = path.resolve(file);
  const missing = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(current), ...missing); }
    catch (error) {
      if (error.code !== 'ENOENT' || fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.unshift(path.basename(current)); current = parent;
    }
  }
}
export function inside(root, file) {
  try {
    const relative = path.relative(physicalPath(root), physicalPath(file));
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  } catch { return false; }
}
export function files(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) return [file];
    return entry.isDirectory() ? files(file) : [file];
  });
}
export function inventory(root) {
  return Object.fromEntries(files(root).map(file => [path.relative(root, file).split(path.sep).join('/'), hash(fs.lstatSync(file).isSymbolicLink() ? 'symlink:' + fs.readlinkSync(file) : fs.readFileSync(file))]));
}
export function instructionSizes(root) {
  return Object.fromEntries(files(root).filter(file => {
    const name = path.relative(root, file).split(path.sep).join('/');
    return name === 'SKILL.md' || /^(commands|docs|references)\/.*\.md$/.test(name);
  }).map(file => [path.relative(root, file).split(path.sep).join('/'), fs.statSync(file).size]));
}
export function execute(command, cwd, env, input, timeoutMs = 120_000) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd, env, input, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
  });
  const infrastructureFailure = ['ENOENT', 'EACCES', 'EPERM', 'ENOMEM', 'EAGAIN', 'EMFILE', 'ENFILE'].includes(result.error?.code) && (!cwd || fs.existsSync(cwd));
  return { command, exitCode: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error?.message ?? null, errorCode: result.error?.code ?? null, infrastructureFailure };
}
export function checked(command, cwd, env, input) {
  const result = execute(command, cwd, env, input);
  if (result.exitCode !== 0) throw Object.assign(new Error(`${command.join(' ')}\n${result.stderr}\n${result.stdout}\n${result.error ?? ''}`), { infrastructure: result.infrastructureFailure });
  return result.stdout.trim();
}
export function environment(root) {
  const directories = {
    TMPDIR: 'tmp', TMP: 'tmp', TEMP: 'tmp', SEMANTIC_FLOW_HOME: 'review-home',
    npm_config_cache: 'cache/npm', NPM_CONFIG_CACHE: 'cache/npm',
    XDG_CACHE_HOME: 'cache', XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data',
    PNPM_HOME: 'cache/pnpm', YARN_CACHE_FOLDER: 'cache/yarn',
  };
  const env = { ...process.env, NEXT_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1', GIT_TERMINAL_PROMPT: '0' };
  // Preserve HOME/CODEX_HOME for harness authentication. Isolation is not an OS sandbox.
  for (const [key, relative] of Object.entries(directories)) {
    env[key] = path.join(root, relative);
    fs.mkdirSync(env[key], { recursive: true });
  }
  env.GIT_CONFIG_GLOBAL = path.join(root, 'config', 'gitconfig');
  if (!fs.existsSync(env.GIT_CONFIG_GLOBAL)) fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  env.GIT_CONFIG_NOSYSTEM = '1';
  return env;
}
export function repository(root, skill, env) {
  const git = (...args) => checked(['git', ...args], root, env);
  const cli = (name, ...args) => checked([process.execPath, path.join(skill, 'scripts', `${name}.mjs`), ...args], root, env);
  const write = (file, content) => {
    const destination = path.resolve(root, file);
    if (!inside(root, destination)) throw new Error('Fixture file escapes repository');
    fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, content);
  };
  return { root, skill, env, git, cli, write, commit(file, content, message) {
    write(file, content); git('add', '--', file); git('commit', '-qm', message); return git('rev-parse', 'HEAD');
  } };
}
export function snapshot(repo, reviewHome) {
  const git = (...args) => checked(['git', ...args], repo);
  const paths = git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean);
  const content = Object.fromEntries([...new Set(paths)].sort().map(name => {
    const file = path.join(repo, name);
    return [name, !fs.existsSync(file) ? null : hash(fs.lstatSync(file).isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file))];
  }));
  return { refs: git('show-ref').replaceAll('\r\n', '\n'), head: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'),
    content, artifact: inventory(path.join(repo, '.semantic-review')), review: inventory(reviewHome) };
}
