import { AsyncLocalStorage } from "node:async_hooks";

// Only immutable Git facts belong in fact caches. Never cache mutable refs,
// worktree status, documents, or an overall validation result.
const contexts = new AsyncLocalStorage<object>();

export function withValidationContext<T>(action: () => T): T {
  return contexts.run({}, action);
}

/** A cache for one kind of immutable fact. Values are shared within one
 * validation context and computed afresh outside of one. */
export function factCache<T>(): (key: string, compute: () => T) => T {
  const byContext = new WeakMap<object, Map<string, { value: T }>>();
  return (key, compute) => {
    const context = contexts.getStore();
    if (!context) return compute();
    let cache = byContext.get(context);
    if (!cache) {
      cache = new Map();
      byContext.set(context, cache);
    }
    let entry = cache.get(key);
    if (!entry) {
      entry = { value: compute() };
      cache.set(key, entry);
    }
    return entry.value;
  };
}
