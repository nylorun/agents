/**
 * The Tenant's Runtime limits (harness boundary S0), stored as Tenant setting `limits.config`
 * (`GET`/`PUT /v1/tenant/limits`): what one record entry, model call, model file, tool answer,
 * custom harness state and Harness API chunk may hold. Unset limits take their defaults
 * (`RUNTIME_LIMIT_DEFAULTS`); none may pass its ceiling (`runtimeLimitIssues`), which the route
 * checks before it writes.
 *
 * Read from Postgres where a limit is checked, never kept: the Record seam, the store's event
 * write, the gates and the segment's `turn.start` each read it in their own transaction.
 */
import {
  TenantLimitsConfigSchema,
  runtimeLimitsOf,
  type RuntimeLimits,
  type TenantLimitsConfig,
} from "@nylorun/core/contracts";

export const LIMITS_CONFIG_SETTING = "limits.config";

interface SettingsReader {
  getSetting(key: string): Promise<string | undefined>;
}
interface SettingsWriter extends SettingsReader {
  putSetting(key: string, value: string): Promise<void>;
}

/** The Tenant's stored limits; a stored value that does not parse counts as none set. */
export async function readLimitsConfig(t: SettingsReader): Promise<TenantLimitsConfig> {
  const raw = await t.getSetting(LIMITS_CONFIG_SETTING);
  if (raw === undefined) return {};
  const parsed = TenantLimitsConfigSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : {};
}

/** The Runtime limits in force: the Tenant's, with the default for each it leaves out. */
export async function readRuntimeLimits(t: SettingsReader): Promise<RuntimeLimits> {
  return runtimeLimitsOf((await readLimitsConfig(t)).limits);
}

export async function writeLimitsConfig(t: SettingsWriter, config: TenantLimitsConfig): Promise<void> {
  await t.putSetting(LIMITS_CONFIG_SETTING, JSON.stringify(TenantLimitsConfigSchema.parse(config)));
}
