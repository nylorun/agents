import {
  parseSandboxDuration,
  parseSandboxSize,
  type SandboxManifest,
} from "@nylorun/core/define";
import type { ResolvedNetwork } from "./types.js";
import { hostTuning } from "../tuning.js";

/** Docker Official Image: Debian with bash, coreutils and Python 3; small first pull. */
export const DEFAULT_SANDBOX_IMAGE = "python:3.13-slim";
export const DEFAULT_SANDBOX_CPUS = 2;
export const DEFAULT_SANDBOX_MEMORY_MIB = 1024;
/** The default of the Tenant's Environment setting `limits.idle` (`environments.config`, D36). */
export const DEFAULT_SANDBOX_IDLE = "15m";

/** Package registries, toolchain downloads and code hosts. Concrete names so every backend can express them. */
export const DEV_PRESET_HOSTS: readonly string[] = Object.freeze([
  // npm and yarn; Node's own downloads, including node-gyp's headers for native modules
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "nodejs.org",
  // Python; uv's Python builds
  "pypi.org",
  "files.pythonhosted.org",
  "releases.astral.sh",
  // Rust and rustup
  "crates.io",
  "index.crates.io",
  "static.crates.io",
  "static.rust-lang.org",
  "sh.rustup.rs",
  // Go, and Go's toolchain downloads
  "proxy.golang.org",
  "sum.golang.org",
  "dl.google.com",
  // mise: its version lists, and the signatures it checks on GitHub releases
  "mise-versions.jdx.dev",
  "tuf-repo-cdn.sigstore.dev",
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
  // GitHub's release downloads redirect here
  "release-assets.githubusercontent.com",
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

/**
 * How long the sandbox may sit idle: its spec's `idle`, which `sandboxSpecOf` sets from the
 * Environment's `lifecycle.idle` within the Tenant's `limits.idle`; else that setting's default
 * (`DEFAULT_SANDBOX_IDLE`, D36).
 */
export function idleMsOf(manifest: SandboxManifest | undefined): number {
  return parseSandboxDuration(manifest?.idle ?? DEFAULT_SANDBOX_IDLE) ?? parseSandboxDuration(DEFAULT_SANDBOX_IDLE)!;
}

export function memoryMiBOf(manifest: SandboxManifest | undefined): number {
  const bytes = manifest?.resources?.memory
    ? parseSandboxSize(manifest.resources.memory)
    : undefined;
  return bytes ? Math.max(hostTuning().pods.memoryFloorMiB, Math.ceil(bytes / 1024 ** 2)) : DEFAULT_SANDBOX_MEMORY_MIB;
}

export function describeNetwork(network: ResolvedNetwork): string {
  const extra = network.preset === "dev"
    ? network.hosts.length - DEV_PRESET_HOSTS.length + network.suffixes.length
    : network.hosts.length + network.suffixes.length;
  return extra > 0 ? `${network.preset} +${extra} host(s)` : network.preset;
}
