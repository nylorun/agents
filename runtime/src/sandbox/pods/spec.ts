/**
 * The `PUT /v1/pods/{name}` body of a pod sandbox: its resolved spec, the Tenant's lifecycle
 * settings (D36, read at every apply) and the incarnation's fences. The pod shape itself is
 * rendered only by the sandboxes service.
 */
import { parseSandboxDuration, parseSandboxSize, type SandboxManifest } from "@nylorun/core/define";
import type { TenantSandboxConfig } from "@nylorun/core/contracts";
import { memoryMiBOf } from "../policy.js";
import type { SandboxPodState } from "../../store/types.js";
import type { PodSpec } from "./client.js";
import { opIdOf, type PodLifecycleConfig } from "./lifecycle.js";

/** The pod's grace period to stop when the Tenant sets none (D34). */
export const DEFAULT_STOP_GRACE_SECONDS = 10;
/** The volume's size when the sandbox asks for none. */
export const DEFAULT_STORAGE_GIB = 5;
/** Where the engine in the pod keeps its records, plugin data and home (on the volume). */
export const POD_HARNESS_ROOT = "/harness";

/** What a pod sandbox's spec holds beyond a virtual one's. */
export type PodSandboxSpec = SandboxManifest & {
  readonly storage?: string;
  readonly lifecycle?: { readonly ttl?: string };
};

/** The Tenant's lifecycle settings with their defaults. */
export function podLifecycleConfig(config: TenantSandboxConfig): PodLifecycleConfig & {
  readonly stopGraceSeconds: number;
} {
  const stopGrace = config.lifecycle?.stopGrace;
  return {
    onExpiry: config.lifecycle?.onExpiry ?? "retain",
    idleMs: parseSandboxDuration(config.limits?.idle ?? "15m") ?? 15 * 60_000,
    stopGraceSeconds:
      stopGrace === undefined
        ? DEFAULT_STOP_GRACE_SECONDS
        : Math.max(1, Math.min(30, Math.round((parseSandboxDuration(stopGrace) ?? 10_000) / 1000))),
  };
}

/** The volume's size in GiB. */
export function storageGiBOf(spec: PodSandboxSpec): number {
  const bytes = spec.storage === undefined ? undefined : parseSandboxSize(spec.storage);
  return bytes === undefined ? DEFAULT_STORAGE_GIB : Math.max(1, Math.ceil(bytes / 1024 ** 3));
}

/** The Tenant's default image, when its default sandbox names one. */
export function tenantDefaultImage(config: TenantSandboxConfig): string | undefined {
  const fallback = config.default;
  return typeof fallback === "object" ? fallback.image : undefined;
}

export interface PodSpecInput {
  readonly sandboxId: string;
  readonly spec: PodSandboxSpec;
  readonly pod: SandboxPodState;
  readonly config: TenantSandboxConfig;
  readonly mode: "Running" | "Suspended";
  /** The Runtime image the engine is copied from. */
  readonly harnessImage: string;
  /** The join token, when this apply rotates it. */
  readonly joinToken?: string;
}

export function podSpecOf(input: PodSpecInput): PodSpec {
  const { spec, pod, config } = input;
  const lifecycle = podLifecycleConfig(config);
  const image = spec.image ?? tenantDefaultImage(config);
  return {
    opId: opIdOf(pod),
    mode: input.mode,
    ...(image ? { image } : {}),
    harnessImage: input.harnessImage,
    cpus: spec.resources?.cpus ?? 1,
    memoryMiB: memoryMiBOf(spec),
    storageGiB: storageGiBOf(spec),
    stopGraceSeconds: lifecycle.stopGraceSeconds,
    ...(pod.expiresAt ? { shutdownTime: new Date(pod.expiresAt).toISOString().replace(/\.\d{3}Z$/, "Z") } : {}),
    shutdownPolicy: lifecycle.onExpiry === "delete" ? "Delete" : "Retain",
    env: {
      NYLORUN_SANDBOX_ID: input.sandboxId,
      NYLORUN_HARNESS_ROOT: POD_HARNESS_ROOT,
    },
    ...(input.joinToken ? { joinToken: input.joinToken } : {}),
  };
}

/** When a sandbox with this TTL, created at `createdAt`, expires. */
export function expiresAtOf(createdAt: string, ttl: string | undefined): string | undefined {
  const ms = ttl === undefined ? undefined : parseSandboxDuration(ttl);
  return ms === undefined ? undefined : new Date(Date.parse(createdAt) + ms).toISOString();
}
