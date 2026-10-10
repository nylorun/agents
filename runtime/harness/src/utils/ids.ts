import { AsyncLocalStorage } from "node:async_hooks";
const scope = new AsyncLocalStorage<{ seed: string; counts: Map<string, number> }>();
export function withDeterministicIds<T>(seed: string, fn: () => T): T {
  return scope.run({ seed, counts: new Map() }, fn);
}
export function createId(prefix: string): string {
  const value = scope.getStore();
  if (!value) return `${prefix}_${globalThis.crypto.randomUUID()}`;
  const count = (value.counts.get(prefix) ?? 0) + 1;
  value.counts.set(prefix, count);
  return `${prefix}_${value.seed}_${count}`;
}
/** Run `fn` with its own id counters, seeded under the current scope, so concurrent work stays deterministic. */
export function withNestedIds<T>(suffix: string, fn: () => T): T {
  const value = scope.getStore();
  return value ? scope.run({ seed: `${value.seed}_${suffix}`, counts: new Map() }, fn) : fn();
}
