/**
 * Resolves the sandbox a session asks for when it is opened against its Tenant's configuration.
 * Pure: the caller supplies the configuration, the backend and who is asking. Every problem is
 * reported, not only the first, so one response lists all of them.
 */
import type { SandboxInlineRequest } from "@nylorun/core/contracts";
import type { SandboxManifest } from "@nylorun/core/define";
import { memoryMiB, type EffectiveSandboxConfig } from "./tenant-config.js";

export type SandboxSource = "default" | "inline";

export type SandboxResolution =
  | { readonly kind: "none" }
  | { readonly kind: "sandbox"; readonly spec: SandboxManifest; readonly source: SandboxSource }
  | { readonly kind: "error"; readonly status: 400 | 403; readonly errors: readonly string[] };

export interface ResolveSandboxInput {
  /** `PutSessionRequest.sandbox` other than `{ session }`, which the caller handles. */
  readonly request: false | SandboxInlineRequest | undefined;
  readonly config: EffectiveSandboxConfig;
  /** The backend this Tenant runs sandboxes on; undefined when none is available. */
  readonly backend: string | undefined;
  /** The request acts for a subject (`Nylorun-Subject`) rather than as the application. */
  readonly actingForSubject: boolean;
}

export const SUBJECT_INLINE_MESSAGE =
  "Defining a sandbox needs an application key. Use the Tenant default, or open the session from the application backend.";

export function resolveSandbox(input: ResolveSandboxInput): SandboxResolution {
  const { request, config } = input;
  if (request === false) return { kind: "none" };
  if (request === undefined) {
    const fallback = config.default;
    if (fallback === "none") return { kind: "none" };
    return build(fallback === "virtual" ? {} : fallback, "default", input);
  }
  if (input.actingForSubject)
    return { kind: "error", status: 403, errors: [SUBJECT_INLINE_MESSAGE] };
  return build(request, "inline", input);
}

function build(
  request: SandboxInlineRequest,
  source: SandboxSource,
  input: ResolveSandboxInput
): SandboxResolution {
  const { limits } = input.config;
  const errors: string[] = [];
  if (request.image !== undefined && input.backend !== "openshell")
    errors.push(
      "sandbox.image needs an OpenShell backend, and this Tenant runs only the virtual sandbox."
    );
  const allow = (request.network?.allow ?? []).map((host) => host.toLowerCase());
  for (const host of allow) {
    if (!withinCeiling(host, limits.network))
      errors.push(`sandbox.network.allow includes ${host}, which this Tenant does not allow.`);
    else if (host.startsWith("*.") && input.backend !== "openshell")
      errors.push(
        `sandbox.network.allow includes ${host}; the virtual sandbox allows exact host names only, such as ${host.slice(2)}.`
      );
  }
  const cpus = request.resources?.cpus ?? limits.defaultResources.cpus;
  const memory =
    request.resources?.memory === undefined
      ? limits.defaultResources.memoryMiB
      : memoryMiB(request.resources.memory);
  if (cpus > limits.resources.cpus)
    errors.push(
      `sandbox.resources.cpus asks for ${cpus}; this Tenant allows at most ${limits.resources.cpus}.`
    );
  if (memory > limits.resources.memoryMiB)
    errors.push(
      `sandbox.resources.memory asks for ${memory}MiB; this Tenant allows at most ${limits.resources.memoryMiB}MiB.`
    );
  if (errors.length > 0) return { kind: "error", status: 400, errors };
  const unique = [...new Set(allow)].sort();
  const spec: SandboxManifest = {
    ...(request.image === undefined ? {} : { image: request.image }),
    network: { preset: "none", ...(unique.length > 0 ? { allow: unique } : {}) },
    resources: { cpus, memory: `${memory}MiB` },
    idle: limits.idle,
  };
  return { kind: "sandbox", spec, source };
}

/** Whether `host` (a name or `*.suffix` pattern) is inside one of the ceiling's patterns. */
export function withinCeiling(host: string, ceiling: readonly string[]): boolean {
  const name = host.toLowerCase();
  for (const entry of ceiling.map((item) => item.toLowerCase())) {
    if (entry === name) return true;
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1);
      const target = name.startsWith("*.") ? name.slice(1) : name;
      if (target.endsWith(suffix)) return true;
    }
  }
  return false;
}

/** Problems with a Tenant configuration, checked when an operator saves it. */
export function sandboxConfigErrors(config: EffectiveSandboxConfig, backend: string | undefined): string[] {
  const errors: string[] = [];
  const { limits } = config;
  if (limits.defaultResources.cpus > limits.resources.cpus)
    errors.push("limits.defaultResources.cpus is above limits.resources.cpus.");
  if (limits.defaultResources.memoryMiB > limits.resources.memoryMiB)
    errors.push("limits.defaultResources.memory is above limits.resources.memory.");
  if (config.default !== "none" && config.default !== "virtual") {
    const resolved = resolveSandbox({
      request: undefined,
      config,
      backend,
      actingForSubject: false,
    });
    if (resolved.kind === "error")
      errors.push(...resolved.errors.map((message) => `default: ${message}`));
  }
  return errors;
}
