/**
 * A Tenant's sandbox configuration, stored as Tenant setting `sandbox.config`: the sandbox a
 * session gets when it names none, and the limits every session's sandbox must fit. Unset
 * fields take the defaults below.
 */
import {
  TenantSandboxConfigSchema,
  type SandboxInlineRequest,
  type SandboxPlacementHost,
  type TenantSandboxConfig,
} from "@nylorun/core/contracts";
import { parseSandboxSize } from "@nylorun/core/define";
import {
  DEFAULT_SANDBOX_CPUS,
  DEFAULT_SANDBOX_MEMORY_MIB,
  DEV_PRESET_HOSTS,
} from "./policy.js";

export const SANDBOX_CONFIG_SETTING = "sandbox.config";

/** The most a session may ask for when the Tenant sets no maximum. */
export const DEFAULT_MAX_CPUS = 4;
export const DEFAULT_MAX_MEMORY_MIB = 8192;
export const DEFAULT_SANDBOX_IDLE = "15m";
/** The most sandbox resources a Tenant holds when it sets no limit. */
export const DEFAULT_MAX_SANDBOXES = 100;

export interface SandboxResourcesLimit {
  readonly cpus: number;
  readonly memoryMiB: number;
}

/** A configuration with every default applied. */
export interface EffectiveSandboxConfig {
  readonly default: "none" | "virtual" | SandboxInlineRequest;
  readonly limits: {
    readonly network: readonly string[];
    readonly resources: SandboxResourcesLimit;
    readonly defaultResources: SandboxResourcesLimit;
    readonly idle: string;
    /** The most sandbox resources (`PUT /v1/sandboxes/{id}`) the Tenant may hold. */
    readonly sandboxes: number;
    /** Pods: the longest `lifecycle.ttl`. */
    readonly ttl?: string;
  };
  /** Pods (F7.2, D36). */
  readonly lifecycle: { readonly onExpiry: "retain" | "delete"; readonly stopGrace: string };
  /** Where each harness may run (D38). */
  readonly placement: Readonly<Record<string, { readonly hosts: readonly SandboxPlacementHost[] }>>;
}

interface SettingsReader {
  getSetting(key: string): Promise<string | undefined>;
}
interface SettingsWriter extends SettingsReader {
  putSetting(key: string, value: string): Promise<void>;
}

export function memoryMiB(value: string): number {
  const bytes = parseSandboxSize(value);
  return bytes === undefined ? 0 : Math.max(128, Math.ceil(bytes / 1024 ** 2));
}

function resources(
  value: { readonly cpus?: number; readonly memory?: string } | undefined,
  fallback: SandboxResourcesLimit
): SandboxResourcesLimit {
  return {
    cpus: value?.cpus ?? fallback.cpus,
    memoryMiB: value?.memory === undefined ? fallback.memoryMiB : memoryMiB(value.memory),
  };
}

export function effectiveSandboxConfig(config: TenantSandboxConfig): EffectiveSandboxConfig {
  const limits = config.limits ?? {};
  return {
    default: config.default ?? "none",
    limits: {
      network: limits.network ?? DEV_PRESET_HOSTS,
      resources: resources(limits.resources, {
        cpus: DEFAULT_MAX_CPUS,
        memoryMiB: DEFAULT_MAX_MEMORY_MIB,
      }),
      defaultResources: resources(limits.defaultResources, {
        cpus: DEFAULT_SANDBOX_CPUS,
        memoryMiB: DEFAULT_SANDBOX_MEMORY_MIB,
      }),
      idle: limits.idle ?? DEFAULT_SANDBOX_IDLE,
      sandboxes: limits.sandboxes ?? DEFAULT_MAX_SANDBOXES,
      ...(limits.ttl === undefined ? {} : { ttl: limits.ttl }),
    },
    lifecycle: {
      onExpiry: config.lifecycle?.onExpiry ?? "retain",
      stopGrace: config.lifecycle?.stopGrace ?? "10s",
    },
    placement: config.placement ?? { "*": { hosts: ["harness-container", "sandbox"] } },
  };
}

/** The stored configuration, or `{}` when the Tenant has none. */
export async function readSandboxConfig(t: SettingsReader): Promise<TenantSandboxConfig> {
  const raw = await t.getSetting(SANDBOX_CONFIG_SETTING);
  if (raw === undefined) return {};
  return TenantSandboxConfigSchema.parse(JSON.parse(raw));
}

export async function writeSandboxConfig(
  t: SettingsWriter,
  config: TenantSandboxConfig
): Promise<void> {
  await t.putSetting(SANDBOX_CONFIG_SETTING, JSON.stringify(config));
}
