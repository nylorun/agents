import { openshellBackend } from "../adapters/sandbox/openshell/backend.js";
import { virtualBackend } from "../adapters/sandbox/virtual.js";
import type {
  SandboxBackend,
  SandboxBackendName,
  SandboxIsolation,
  SandboxProbe,
} from "./types.js";

export type SandboxPreference = "auto" | SandboxBackendName;
const PREFERENCES: readonly SandboxPreference[] = ["auto", "virtual", "openshell"];

export interface SandboxSelection {
  readonly preference: SandboxPreference;
  readonly backend?: SandboxBackend;
  /** Why this backend was chosen, or why none could be. */
  readonly reason: string;
  readonly probes: readonly SandboxProbe[];
}

/** Serializable view of a selection for the CLI and `GET /v1/tenant/sandbox`. */
export interface SandboxSelectionReport {
  readonly preference: SandboxPreference;
  readonly backend: SandboxBackendName | null;
  readonly isolation: SandboxIsolation | null;
  readonly reason: string;
  readonly probes: readonly SandboxProbe[];
}

/**
 * The backends a Runtime probes, in order. `auto` picks the first available one: an OpenShell
 * gateway when the Host has one, else the virtual backend.
 */
export function defaultSandboxBackends(options: {
  readonly root: string;
  readonly openshell?: { readonly gateway: string };
}): SandboxBackend[] {
  return [
    ...(options.openshell ? [openshellBackend({ gateway: options.openshell.gateway })] : []),
    virtualBackend({ root: options.root }),
  ];
}

export function parseSandboxPreference(value: string | undefined): SandboxPreference | undefined {
  const normalized = (value ?? "auto").trim().toLowerCase() || "auto";
  return (PREFERENCES as readonly string[]).includes(normalized)
    ? (normalized as SandboxPreference)
    : undefined;
}

/**
 * Probe backends in order and pick one. An explicit preference never falls back, so a
 * production Runtime cannot silently run with weaker isolation than it was configured for.
 */
export async function selectSandboxBackend(
  backends: readonly SandboxBackend[],
  preference: SandboxPreference
): Promise<SandboxSelection> {
  const probes: SandboxProbe[] = [];
  for (const backend of backends) probes.push(await backend.probe());
  const probeOf = (name: string) => probes.find((probe) => probe.name === name);
  if (preference !== "auto") {
    const backend = backends.find((item) => item.name === preference);
    const probe = probeOf(preference);
    if (backend && probe?.available)
      return {
        preference,
        backend,
        reason: `${preference} selected by TenantConfig.sandbox.backend`,
        probes,
      };
    return {
      preference,
      reason: `sandbox.backend=${preference} but ${preference} is unavailable: ${probe?.reason ?? "unknown backend"}. Fix it, or set backend to auto to use the best available backend`,
      probes,
    };
  }
  const index = backends.findIndex((_, i) => probes[i]!.available);
  if (index < 0)
    return {
      preference,
      reason: `no sandbox backend is available (${probes.map((probe) => `${probe.name}: ${probe.reason}`).join("; ")})`,
      probes,
    };
  const skipped = probes.slice(0, index).map((probe) => `${probe.name} unavailable: ${probe.reason}`);
  return {
    preference,
    backend: backends[index]!,
    reason: skipped.length ? skipped.join("; ") : probes[index]!.reason ?? backends[index]!.name,
    probes,
  };
}

export function reportSelection(selection: SandboxSelection): SandboxSelectionReport {
  return {
    preference: selection.preference,
    backend: selection.backend?.name ?? null,
    isolation: selection.backend?.isolation ?? null,
    reason: selection.reason,
    probes: selection.probes,
  };
}

/**
 * Probe backends the way a Tenant Runtime would at open.
 * Callers must pass an explicit probe root; no ambient env or OS temp (A7).
 */
export async function probeSandboxBackends(
  options: {
    readonly preference?: string;
    readonly root?: string;
  } = {},
): Promise<SandboxSelectionReport> {
  if (!options.root) {
    throw new Error(
      "probeSandboxBackends requires an explicit root (Tenant or Host tmp path)",
    );
  }
  const preference = parseSandboxPreference(options.preference ?? "auto");
  const backends = defaultSandboxBackends({ root: options.root });
  if (!preference)
    return {
      preference: "auto",
      backend: null,
      isolation: null,
      reason: "sandbox.backend must be auto or virtual",
      probes: await Promise.all(backends.map((backend) => backend.probe())),
    };
  return reportSelection(await selectSandboxBackend(backends, preference));
}
