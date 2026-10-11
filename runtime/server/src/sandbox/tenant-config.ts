/**
 * A Tenant's Environment settings, stored as Tenant setting `environments.config`: the limits
 * every Environment's recipe must fit, the pods' stop grace and the harness placement. Unset
 * fields take the defaults below.
 */
import {
  TenantEnvironmentsConfigSchema,
  type PlacementHost,
  type TenantEnvironmentsConfig,
} from "@nylorun/core/contracts";
import { parseSandboxSize } from "@nylorun/core/define";
import {
  DEFAULT_SANDBOX_CPUS,
  DEFAULT_SANDBOX_MEMORY_MIB,
  DEV_PRESET_HOSTS,
} from "./policy.js";

export const ENVIRONMENTS_CONFIG_SETTING = "environments.config";

/** The Tenant's settings, as stored (`environments.config`). */
export type TenantSandboxConfig = TenantEnvironmentsConfig;

/** The most an Environment may ask for when the Tenant sets no maximum. */
export const DEFAULT_MAX_CPUS = 4;
export const DEFAULT_MAX_MEMORY_MIB = 8192;
export const DEFAULT_SANDBOX_IDLE = "15m";
/** The most Environments a Tenant holds when it sets no limit. */
export const DEFAULT_MAX_ENVIRONMENTS = 100;

export interface SandboxResourcesLimit {
  readonly cpus: number;
  readonly memoryMiB: number;
}

/** A configuration with every default applied. */
export interface EffectiveSandboxConfig {
  readonly limits: {
    readonly network: readonly string[];
    readonly resources: SandboxResourcesLimit;
    readonly defaultResources: SandboxResourcesLimit;
    readonly idle: string;
    /** The most Environments the Tenant may hold. */
    readonly environments: number;
  };
  /** Pods (F7.2, D36). */
  readonly lifecycle: { readonly stopGrace: string };
  /** Where each harness may run (D38). */
  readonly placement: Readonly<Record<string, { readonly hosts: readonly PlacementHost[] }>>;
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
      environments: limits.environments ?? DEFAULT_MAX_ENVIRONMENTS,
    },
    lifecycle: { stopGrace: config.lifecycle?.stopGrace ?? "10s" },
    placement: config.placement ?? { "*": { hosts: ["harness-container", "sandbox"] } },
  };
}

/** The stored configuration, or `{}` when the Tenant has none. */
export async function readSandboxConfig(t: SettingsReader): Promise<TenantSandboxConfig> {
  const raw = await t.getSetting(ENVIRONMENTS_CONFIG_SETTING);
  if (raw === undefined) return {};
  return TenantEnvironmentsConfigSchema.parse(JSON.parse(raw));
}

export async function writeSandboxConfig(
  t: SettingsWriter,
  config: TenantSandboxConfig
): Promise<void> {
  await t.putSetting(ENVIRONMENTS_CONFIG_SETTING, JSON.stringify(config));
}
