import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { cleanupFailure, fileUsers } from '../../src/shared/cleanup-diagnostics.ts';

function setup(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'cleanup-diagnostics-'));
  const file = path.join(root, "locked æ ' $ file.txt"); fs.writeFileSync(file, 'keep');
  t.after(() => { t.mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); });
  return { root, file };
}

test('diagnostics report a specific file and process without executing path text', (t) => {
  const { file } = setup(t);
  t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
    assert.equal(options.windowsHide, true); assert.ok(options.timeout <= 5000);
    assert.equal(options.shell, undefined);
    if (process.platform === 'win32') {
      assert.equal(command, 'powershell.exe');
      assert.deepEqual(JSON.parse(options.input), [file]);
      assert.ok(!args.join(' ').includes(file));
      return JSON.stringify({ pid: 123, name: 'Editor', path: file });
    }
    assert.equal(command, 'lsof'); assert.deepEqual(args, ['-Fpcn', '--', file]);
    return `p123\ncEditor\nn${file}\nn${file}\n`;
  });
  const result = cleanupFailure(Object.assign(new Error('File is open'), { code: 'EBUSY', path: file }), 'wrong fallback', 'Retry file removal.');
  assert.ok(result.includes(JSON.stringify(file)));
  assert.match(result, /Editor \(PID 123\)/);
  assert.match(result, /Retry file removal/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
});

test('unavailable process lookup retains the original error and actionable retry', (t) => {
  const { file } = setup(t);
  for (const code of ['ENOENT', 'EACCES', 'ETIMEDOUT']) {
    const mock = t.mock.method(childProcess, 'execFileSync', () => { throw Object.assign(new Error('Lookup unavailable'), { code }); });
    const result = cleanupFailure(Object.assign(new Error('Permission denied'), { code: 'EACCES', path: file }), file, 'Retry cleanup.');
    assert.match(result, /No holding process could be identified/);
    assert.match(result, /Permission denied/);
    assert.match(result, /check access permissions/);
    assert.match(result, /Retry cleanup/);
    mock.mock.restore();
  }
});

test('directory diagnostics do not follow symbolic links on Windows', { skip: process.platform !== 'win32' }, (t) => {
  const { root, file } = setup(t), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-cleanup-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'unrelated'), 'private');
  fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
  t.mock.method(childProcess, 'execFileSync', (_command, _args, options) => {
    assert.deepEqual(JSON.parse(options.input), [file]);
    return '[]';
  });
  assert.deepEqual(fileUsers(root), []);
});

test('native lookup identifies a process holding a real file', async (t) => {
  const { root, file } = setup(t);
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(root, `unlocked-${i}.txt`), 'unused');
  if (process.platform !== 'win32') {
    try { childProcess.execFileSync('lsof', ['-v'], { stdio: 'ignore', windowsHide: true }); }
    catch { t.skip('lsof unavailable'); return; }
  }
  const child = process.platform === 'win32'
    ? childProcess.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$f=[System.IO.File]::Open($env:SEMANTIC_TEST_LOCK_FILE, 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('ready'); [Console]::In.ReadLine() | Out-Null; $f.Dispose()"], { env: { ...process.env, SEMANTIC_TEST_LOCK_FILE: file }, windowsHide: true })
    : childProcess.spawn(process.execPath, ['-e', "require('fs').openSync(process.argv[1], 'r'); console.log('ready'); process.stdin.resume()", file], { windowsHide: true });
  const exited = once(child, 'exit');
  try {
    const ready = await Promise.race([once(child.stdout, 'data'), exited.then(() => { throw new Error('File holder exited before ready'); })]);
    assert.match(String(ready[0]), /ready/);
    for (const target of [file, root]) {
      const users = fileUsers(target);
      assert.ok(users.some(user => user.pid === child.pid && user.path === file), JSON.stringify(users));
    }
  } finally {
    if (child.exitCode === null) child.kill();
    await exited;
  }
});
