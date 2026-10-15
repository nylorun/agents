/**
 * Resolves an Environment's recipe (`PUT /v1/environments/{id}`) against its Tenant's limits,
 * and the sandbox spec a recipe gives a session (`Session.sandbox`) and the pod. Pure: the
 * caller supplies the configuration. Every problem is reported, not only the first, so one
 * response lists all of them.
 */
import type {
  EnvironmentFile,
  EnvironmentKind,
  EnvironmentLifecycle,
  EnvironmentLimits,
  EnvironmentRecipe,
  EnvironmentSecretSlots,
  EnvironmentSetupCommand,
} from "@nylorun/core/contracts";
import { DEFAULT_HARNESS } from "@nylorun/core/contracts";
import { parseSandboxDuration, type SandboxManifest } from "@nylorun/core/define";
import type { PodSandboxSpec } from "./pods/spec.js";
import { memoryMiB, type EffectiveSandboxConfig } from "./tenant-config.js";

/** What a `PUT` asks of the recipe: the request's fields, over the existing recipe's. */
export interface RecipeRequest {
  readonly image?: string;
  readonly resources?: { readonly cpus?: number; readonly memory?: string };
  readonly storage?: string;
  readonly network?: { readonly allowedHosts?: readonly string[] };
  readonly harness?: string;
  readonly lifecycle?: EnvironmentLifecycle;
  readonly setup?: readonly EnvironmentSetupCommand[];
  readonly files?: readonly EnvironmentFile[];
  /** The secret slots (D64): passed through for every kind. */
  readonly secrets?: EnvironmentSecretSlots;
  /**
   * Artifact and skill limits: passed through for every kind, as set. The caller checks them
   * against the Tenant's (`tenant/limits.ts`), which this module does not read.
   */
  readonly limits?: EnvironmentLimits;
}

export type RecipeResolution =
  | { readonly kind: "recipe"; readonly recipe: EnvironmentRecipe }
  | { readonly kind: "error"; readonly errors: readonly string[] };

/** The recipe `request` asks for an Environment of `kind`, or every reason it cannot have it. */
export function resolveRecipe(
  kind: EnvironmentKind,
  request: RecipeRequest,
  config: EffectiveSandboxConfig,
): RecipeResolution {
  const { limits } = config;
  const errors: string[] = [];
  const pod = kind === "pod";
  // Any harness id (R4.1): placement decides where it may run, when a session opens.
  const harness = request.harness ?? DEFAULT_HARNESS;
  if (pod && harness !== DEFAULT_HARNESS && request.image === undefined)
    errors.push(`harness ${harness} needs image: a pod Environment runs its image as the harness.`);
  const lifecycle = request.lifecycle ?? {};
  const idle = lifecycle.idle === undefined ? undefined : parseSandboxDuration(lifecycle.idle);
  if (idle !== undefined && idle > (parseSandboxDuration(limits.idle) ?? Infinity))
    errors.push(`lifecycle.idle is ${lifecycle.idle}; this Tenant allows at most ${limits.idle}.`);
  if (kind === "none") {
    for (const field of ["image", "resources", "storage", "network", "setup", "files"] as const)
      if (request[field] !== undefined)
        errors.push(`${field} is for an Environment with a sandbox: kind none has none.`);
    if (errors.length > 0) return { kind: "error", errors };
    return {
      kind: "recipe",
      recipe: { harness, lifecycle: { ...lifecycle }, ...limitsOf(request), ...slotsOf(request) },
    };
  }
  if (request.image !== undefined && !pod)
    errors.push("image is for kind pod: a virtual Environment runs no images.");
  if (request.storage !== undefined && !pod)
    errors.push("storage is for kind pod: a virtual Environment has no volume.");
  for (const field of ["setup", "files"] as const)
    if (request[field] !== undefined && request[field]!.length > 0 && !pod)
      errors.push(`${field} is for kind pod: it runs when a pod's disk is made or reset.`);
  const allow = (request.network?.allowedHosts ?? []).map((host) => host.toLowerCase());
  for (const host of allow) {
    if (!withinCeiling(host, limits.network))
      errors.push(`network.allowedHosts includes ${host}, which this Tenant does not allow.`);
    else if (host.startsWith("*.") && !pod)
      errors.push(
        `network.allowedHosts includes ${host}; a virtual Environment allows exact host names only, such as ${host.slice(2)}.`,
      );
  }
  const cpus = request.resources?.cpus ?? limits.defaultResources.cpus;
  const memory =
    request.resources?.memory === undefined
      ? limits.defaultResources.memoryMiB
      : memoryMiB(request.resources.memory);
  if (cpus > limits.resources.cpus)
    errors.push(`resources.cpus asks for ${cpus}; this Tenant allows at most ${limits.resources.cpus}.`);
  if (memory > limits.resources.memoryMiB)
    errors.push(
      `resources.memory asks for ${memory}MiB; this Tenant allows at most ${limits.resources.memoryMiB}MiB.`,
    );
  if (errors.length > 0) return { kind: "error", errors };
  return {
    kind: "recipe",
    recipe: {
      ...(request.image === undefined ? {} : { image: request.image }),
      resources: { cpus, memory: `${memory}MiB` },
      ...(request.storage === undefined ? {} : { storage: request.storage }),
      network: { allowedHosts: [...new Set(allow)].sort() },
      harness,
      lifecycle: { ...lifecycle },
      ...(pod && request.setup?.length ? { setup: request.setup.map((command) => ({ ...command })) } : {}),
      ...(pod && request.files?.length ? { files: request.files.map((file) => ({ ...file })) } : {}),
      ...limitsOf(request),
      ...slotsOf(request),
    },
  };
}

/** The request's limits, when it sets any. */
function limitsOf(request: RecipeRequest): Pick<EnvironmentRecipe, "limits"> {
  return request.limits !== undefined && Object.keys(request.limits).length > 0
    ? { limits: structuredClone(request.limits) }
    : {};
}

/** The request's secret slots, when it declares any. */
function slotsOf(request: RecipeRequest): Pick<EnvironmentRecipe, "secrets"> {
  return request.secrets !== undefined && Object.keys(request.secrets).length > 0
    ? { secrets: structuredClone(request.secrets) }
    : {};
}

/**
 * The sandbox spec of a recipe: what a session pins when it opens and the virtual
 * workspace runs. Idle is the Environment's `lifecycle.idle`, else the Tenant's.
 */
export function sandboxSpecOf(recipe: EnvironmentRecipe, tenantIdle: string): SandboxManifest {
  const allow = recipe.network?.allowedHosts ?? [];
  return {
    ...(recipe.image === undefined ? {} : { image: recipe.image }),
    network: { preset: "none", ...(allow.length > 0 ? { allow: [...allow] } : {}) },
    ...(recipe.resources === undefined ? {} : { resources: { ...recipe.resources } }),
    idle: recipe.lifecycle.idle ?? tenantIdle,
  };
}

/** The pod's spec of a recipe: its sandbox spec and its volume's size. */
export function podSandboxSpecOf(recipe: EnvironmentRecipe, tenantIdle: string): PodSandboxSpec {
  return {
    ...sandboxSpecOf(recipe, tenantIdle),
    ...(recipe.storage === undefined ? {} : { storage: recipe.storage }),
  };
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
export function sandboxConfigErrors(config: EffectiveSandboxConfig): string[] {
  const errors: string[] = [];
  const { limits } = config;
  if (limits.defaultResources.cpus > limits.resources.cpus)
    errors.push("limits.defaultResources.cpus is above limits.resources.cpus.");
  if (limits.defaultResources.memoryMiB > limits.resources.memoryMiB)
    errors.push("limits.defaultResources.memory is above limits.resources.memory.");
  return errors;
}
