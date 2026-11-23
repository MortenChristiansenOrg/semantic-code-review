// Removal of the directories tests create. Plain JavaScript without TypeScript
// imports, so the Playwright specs can use it too.
import fs from "node:fs";

/** Errors Windows reports while a directory or a file in it is still open, for
 * example for a moment after the process that used it exited. */
const LOCKED = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EMFILE", "ENFILE"]);

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Removes a directory and its contents. While it stays locked, tries again
 * until `timeoutMs` passed, then throws the last error, so a process that keeps
 * it open still fails the test. Synchronous, so it also works in exit handlers. */
export function removeDirectory(directory, { timeoutMs = 10_000, delayMs = 100, remove = fs.rmSync } = {}) {
  for (const deadline = performance.now() + timeoutMs; ; pause(delayMs)) {
    try {
      remove(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!LOCKED.has(error?.code) || performance.now() + delayMs > deadline) throw error;
    }
  }
}
