import { AsyncLocalStorage } from "node:async_hooks";

// Only immutable Git facts and compiled schemas belong here. Never cache mutable
// refs, worktree status, documents, or an overall validation result.
const contexts = new AsyncLocalStorage<Map<string, unknown>>();

export function withValidationContext<T>(action: () => T): T {
  return contexts.run(new Map(), action);
}

export function immutableFact<T>(key: string, compute: () => T): T {
  const cache = contexts.getStore();
  if (!cache) return compute();
  if (!cache.has(key)) cache.set(key, compute());
  return cache.get(key) as T;
}
