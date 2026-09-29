/** Portable sandbox constants and parsers shared by the SDK, wire schema and Runtime. */

/** Built-in tools every sandbox capability declares. The Runtime executes them. */
export const SANDBOX_TOOL_NAMES = Object.freeze([
  "bash",
  "read",
  "write",
  "edit",
  "grep",
  "glob",
] as const);
export type SandboxToolName = (typeof SANDBOX_TOOL_NAMES)[number];

export const SANDBOX_WORKSPACE = "/workspace";
export const SANDBOX_NETWORK_PRESETS = Object.freeze(["none", "dev", "open"] as const);

export function isSandboxToolName(name: string): name is SandboxToolName {
  return (SANDBOX_TOOL_NAMES as readonly string[]).includes(name);
}

const DURATION = /^(\d+)(ms|s|m|h|d)$/;
const DURATION_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** Parse "15m", "30s", "1h" into milliseconds. Returns undefined when invalid. */
export function parseSandboxDuration(value: string): number | undefined {
  const match = DURATION.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  return amount > 0 ? amount * DURATION_MS[match[2] as keyof typeof DURATION_MS] : undefined;
}

const SIZE = /^(\d+)(B|KiB|MiB|GiB|TiB)$/;
const SIZE_BYTES = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 } as const;

/** Parse "512MiB", "2GiB" into bytes. Returns undefined when invalid. */
export function parseSandboxSize(value: string): number | undefined {
  const match = SIZE.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  return amount > 0 ? amount * SIZE_BYTES[match[2] as keyof typeof SIZE_BYTES] : undefined;
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** A host name, optionally with a leading "*." wildcard. No scheme, port, path or IP literal. */
export function isSandboxHostPattern(value: string): boolean {
  const host = value.startsWith("*.") ? value.slice(2) : value;
  if (host.length === 0 || host.length > 253) return false;
  const labels = host.toLowerCase().split(".");
  if (labels.length < 2) return false;
  if (labels.every((label) => /^\d+$/.test(label))) return false;
  return labels.every((label) => LABEL.test(label));
}
