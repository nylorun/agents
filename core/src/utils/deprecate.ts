/**
 * Warn once per code that an authoring form is deprecated.
 *
 * Uses `process.emitWarning` when a Node-like `process` exists, so `--no-deprecation`
 * and `process.noDeprecation` silence it; otherwise falls back to `console.warn`.
 * Core imports no `node:` module, so this reads `process` from `globalThis`.
 */
const warned = new Set<string>();

type WarningProcess = {
  readonly noDeprecation?: boolean;
  emitWarning?(message: string, options: { type: string; code: string }): void;
};

export function deprecate(code: string, message: string): void {
  if (warned.has(code)) return;
  warned.add(code);
  const proc = (globalThis as { process?: WarningProcess }).process;
  if (proc?.noDeprecation) return;
  if (typeof proc?.emitWarning === "function") {
    proc.emitWarning(message, { type: "DeprecationWarning", code });
    return;
  }
  console.warn(`DeprecationWarning [${code}]: ${message}`);
}

/** Test hook: forget which codes have warned. */
export function resetDeprecationWarnings(): void {
  warned.clear();
}
