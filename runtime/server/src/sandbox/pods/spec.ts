/**
 * The `PUT /v1/pods/{name}` body of a pod Environment: its applied recipe, the Tenant's lifecycle
 * settings (D36, read at every apply) and the incarnation's fences. The pod shape itself is
 * rendered only by the sandboxes service.
 */
import { parseSandboxDuration, parseSandboxSize, type SandboxManifest } from "@nylorun/core/define";
import { DEFAULT_HARNESS, type EnvironmentRecipe } from "@nylorun/core/contracts";
import type { TenantSandboxConfig } from "../tenant-config.js";
import { idleMsOf, memoryMiBOf } from "../policy.js";
import type { SandboxPodState } from "../../store/types.js";
import type { PodSpec } from "./client.js";
import { opIdOf, type PodLifecycleConfig } from "./lifecycle.js";

/** The pod's grace period to stop when the Tenant sets none (D34). */
export const DEFAULT_STOP_GRACE_SECONDS = 10;
/** The volume's size when the sandbox asks for none. */
export const DEFAULT_STORAGE_GIB = 5;
/** Where the engine in the pod keeps its records, plugin data and home (on the volume). */
export const POD_HARNESS_ROOT = "/harness";

/** What a pod's spec holds beyond a virtual sandbox's. */
export type PodSandboxSpec = SandboxManifest & { readonly storage?: string };

/**
 * The lifecycle settings with their defaults: the Tenant's (D36), and the Environment's
 * `lifecycle.idle` within the Tenant's `limits.idle` when `recipe` is given.
 */
export function podLifecycleConfig(
  config: TenantSandboxConfig,
  recipe?: Pick<EnvironmentRecipe, "lifecycle">,
): PodLifecycleConfig & {
  readonly stopGraceSeconds: number;
} {
  const stopGrace = config.lifecycle?.stopGrace;
  const tenantIdle = idleMsOf({ ...(config.limits?.idle === undefined ? {} : { idle: config.limits.idle }) });
  const own = recipe?.lifecycle.idle === undefined ? undefined : parseSandboxDuration(recipe.lifecycle.idle);
  const graceMs = stopGrace === undefined ? undefined : parseSandboxDuration(stopGrace);
  return {
    idleMs: own === undefined ? tenantIdle : Math.min(own, tenantIdle),
    // Kubernetes counts the grace in whole seconds, at least one.
    stopGraceSeconds: graceMs === undefined ? DEFAULT_STOP_GRACE_SECONDS : Math.max(1, Math.round(graceMs / 1000)),
  };
}

/** The volume's size in GiB. */
export function storageGiBOf(spec: PodSandboxSpec): number {
  const bytes = spec.storage === undefined ? undefined : parseSandboxSize(spec.storage);
  return bytes === undefined ? DEFAULT_STORAGE_GIB : Math.max(1, Math.ceil(bytes / 1024 ** 3));
}

export interface PodSpecInput {
  readonly environmentId: string;
  readonly spec: PodSandboxSpec;
  readonly pod: SandboxPodState;
  readonly config: TenantSandboxConfig;
  readonly mode: "Running" | "Suspended";
  /** The Runtime image the engine is copied from. */
  readonly harnessImage: string;
  /**
   * The harness the pod runs (R4.4): ours, copied in from `harnessImage`, or a custom one, which
   * is the workload image itself and runs as its entrypoint.
   */
  readonly harness?: string;
  /** The join token, when this apply rotates it. */
  readonly joinToken?: string;
}

export function podSpecOf(input: PodSpecInput): PodSpec {
  const { spec, pod, config } = input;
  const lifecycle = podLifecycleConfig(config);
  // Pinned by digest once a pod ran it (Q14).
  const image = pod.imageDigest ?? spec.image;
  const ours = (input.harness ?? DEFAULT_HARNESS) === DEFAULT_HARNESS;
  return {
    opId: opIdOf(pod),
    mode: input.mode,
    ...(image ? { image } : {}),
    // A custom harness is its image: the pod runs the image's entrypoint, nothing copied in.
    ...(ours ? { harnessImage: input.harnessImage } : { entrypoint: "image" as const }),
    cpus: spec.resources?.cpus ?? 1,
    memoryMiB: memoryMiBOf(spec),
    storageGiB: storageGiBOf(spec),
    stopGraceSeconds: lifecycle.stopGraceSeconds,
    shutdownPolicy: "Retain",
    env: {
      NYLORUN_SANDBOX_ID: input.environmentId,
      NYLORUN_HARNESS_ROOT: POD_HARNESS_ROOT,
    },
    ...(input.joinToken ? { joinToken: input.joinToken } : {}),
  };
}
