import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { git, gitRaw } from "../src/shared/git.ts";
import { processFailureDetail } from "../src/shared/subprocess.ts";

const noisy = ["-e", "process.stdout.write('x'.repeat(4096))"];

test("a spawn that overflows its output buffer reports ENOBUFS", () => {
  const result = spawnSync(process.execPath, noisy, { maxBuffer: 16 });
  assert.equal(result.error?.code, "ENOBUFS");
  assert.match(processFailureDetail(result), /maximum buffer size \(ENOBUFS\)/);
});

test("a thrown overflow from execFileSync reports ENOBUFS", () => {
  assert.throws(() => execFileSync(process.execPath, noisy, { maxBuffer: 16, stdio: ["ignore", "pipe", "pipe"] }), (error) => {
    assert.match(processFailureDetail(error), /maximum buffer size \(ENOBUFS\)/);
    return true;
  });
});

test("a spawn error is reported", () => {
  const missing = spawnSync("semantic-flow-missing-executable", []);
  assert.match(processFailureDetail(missing), /ENOENT/);
});

test("a terminating signal is reported", { skip: process.platform === "win32" }, () => {
  const killed = spawnSync(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"]);
  assert.equal(killed.status, null);
  assert.equal(processFailureDetail(killed), "terminated by signal SIGKILL");
});

test("a thrown non-zero exit reports stderr without the generic command message", () => {
  assert.throws(() => execFileSync(process.execPath, ["-e", "console.error('bad input'); process.exit(3)"], { stdio: ["ignore", "pipe", "pipe"] }), (error) => {
    assert.equal(processFailureDetail(error), "bad input");
    return true;
  });
});

test("git helpers keep reporting Git's own stderr", () => {
  assert.throws(() => git(["rev-parse", "--verify", "refs/heads/semantic-flow-missing"], { cwd: process.cwd() }), /failed: fatal: Needed a single revision/);
  assert.throws(() => gitRaw(["rev-parse", "--verify", "refs/heads/semantic-flow-missing"], { cwd: process.cwd() }), /failed: fatal: Needed a single revision/);
});
