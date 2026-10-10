import {
  parseSandboxDuration,
  parseSandboxSize,
  type SandboxManifest,
} from "@nylorun/core/define";
import type { ResolvedNetwork } from "./types.js";

/** Docker Official Image: Debian with bash, coreutils and Python 3; small first pull. */
export const DEFAULT_SANDBOX_IMAGE = "python:3.13-slim";
export const DEFAULT_SANDBOX_CPUS = 2;
export const DEFAULT_SANDBOX_MEMORY_MIB = 1024;
export const DEFAULT_SANDBOX_IDLE_MS = 15 * 60_000;

/** Package registries and code hosts. Concrete names so every backend can express them. */
export const DEV_PRESET_HOSTS: readonly string[] = Object.freeze([
  // npm and yarn
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  // Python
  "pypi.org",
  "files.pythonhosted.org",
  // Rust
  "crates.io",
  "index.crates.io",
  "static.crates.io",
  // Go
  "proxy.golang.org",
  "sum.golang.org",
  // Debian and Ubuntu package mirrors
  "deb.debian.org",
  "security.debian.org",
  "archive.ubuntu.com",
  "security.ubuntu.com",
  "ports.ubuntu.com",
  // Code hosts
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
  "gitlab.com",
]);

export function resolveNetwork(manifest: SandboxManifest | undefined): ResolvedNetwork {
  const preset = manifest?.network?.preset ?? "dev";
  const hosts = new Set<string>(preset === "dev" ? DEV_PRESET_HOSTS : []);
  const suffixes = new Set<string>();
  for (const entry of manifest?.network?.allow ?? []) {
    const host = entry.toLowerCase();
    if (host.startsWith("*.")) suffixes.add(host.slice(1));
    else hosts.add(host);
  }
  return Object.freeze({
    preset,
    hosts: Object.freeze([...hosts].sort()),
    suffixes: Object.freeze([...suffixes].sort()),
  });
}

export function idleMsOf(manifest: SandboxManifest | undefined): number {
  return (manifest?.idle && parseSandboxDuration(manifest.idle)) || DEFAULT_SANDBOX_IDLE_MS;
}

export function memoryMiBOf(manifest: SandboxManifest | undefined): number {
  const bytes = manifest?.resources?.memory
    ? parseSandboxSize(manifest.resources.memory)
    : undefined;
  return bytes ? Math.max(128, Math.ceil(bytes / 1024 ** 2)) : DEFAULT_SANDBOX_MEMORY_MIB;
}

export function describeNetwork(network: ResolvedNetwork): string {
  const extra = network.preset === "dev"
    ? network.hosts.length - DEV_PRESET_HOSTS.length + network.suffixes.length
    : network.hosts.length + network.suffixes.length;
  return extra > 0 ? `${network.preset} +${extra} host(s)` : network.preset;
}
