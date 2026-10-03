/**
 * A Tenant's artifact configuration, stored as Tenant setting `artifacts.config`: the largest
 * file one upload may store and the most bytes every artifact version together may hold.
 * Unset limits take the defaults (100 MiB and 10 GiB).
 */
import {
  ARTIFACT_FILE_BYTES_DEFAULT,
  ARTIFACT_TOTAL_BYTES_DEFAULT,
  TenantArtifactsConfigSchema,
  type TenantArtifactsConfig,
} from "@nylorun/core/contracts";

export const ARTIFACTS_CONFIG_SETTING = "artifacts.config";

export interface ArtifactLimits {
  readonly fileBytes: number;
  readonly totalBytes: number;
}

interface SettingsReader {
  getSetting(key: string): Promise<string | undefined>;
}
interface SettingsWriter extends SettingsReader {
  putSetting(key: string, value: string): Promise<void>;
}

/** The limits in force: the Tenant's, with the defaults for what it leaves unset. */
export function effectiveArtifactLimits(config: TenantArtifactsConfig): ArtifactLimits {
  return {
    fileBytes: config.limits?.fileBytes ?? ARTIFACT_FILE_BYTES_DEFAULT,
    totalBytes: config.limits?.totalBytes ?? ARTIFACT_TOTAL_BYTES_DEFAULT,
  };
}

export async function readArtifactsConfig(t: SettingsReader): Promise<TenantArtifactsConfig> {
  const raw = await t.getSetting(ARTIFACTS_CONFIG_SETTING);
  if (raw === undefined) return {};
  const parsed = TenantArtifactsConfigSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : {};
}

export async function readArtifactLimits(t: SettingsReader): Promise<ArtifactLimits> {
  return effectiveArtifactLimits(await readArtifactsConfig(t));
}

export async function writeArtifactsConfig(
  t: SettingsWriter,
  config: TenantArtifactsConfig,
): Promise<void> {
  await t.putSetting(ARTIFACTS_CONFIG_SETTING, JSON.stringify(TenantArtifactsConfigSchema.parse(config)));
}
