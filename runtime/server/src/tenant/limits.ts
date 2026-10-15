/**
 * What artifacts and skills may hold: the Tenant's limits (`artifacts.config`, and
 * `skills.config` here), and an Environment's, which its manifest sets (`limits`). A limit the
 * manifest leaves out is the Tenant's as it is when the limit is checked, and none is ever above
 * the Tenant's: a manifest asking for more is refused when the Environment is made, and a
 * Tenant that lowers a limit later lowers it for every Environment.
 */
import {
  SKILL_TOTAL_BYTES_DEFAULT,
  TenantSkillsConfigSchema,
  type EnvironmentLimits,
  type TenantSkillsConfig,
} from "@nylorun/core/contracts";
import { readArtifactLimits, type ArtifactLimits } from "../artifacts/config.js";

export const SKILLS_CONFIG_SETTING = "skills.config";

export interface SkillLimits {
  readonly totalBytes: number;
}

/** The limits an Environment's artifacts and skills are held to. */
export interface StorageLimits {
  readonly artifacts: ArtifactLimits;
  readonly skills: SkillLimits;
}

interface SettingsReader {
  getSetting(key: string): Promise<string | undefined>;
}
interface SettingsWriter extends SettingsReader {
  putSetting(key: string, value: string): Promise<void>;
}

/** The skill limits in force: the Tenant's, with the default for what it leaves unset. */
export function effectiveSkillLimits(config: TenantSkillsConfig): SkillLimits {
  return { totalBytes: config.limits?.totalBytes ?? SKILL_TOTAL_BYTES_DEFAULT };
}

export async function readSkillsConfig(t: SettingsReader): Promise<TenantSkillsConfig> {
  const raw = await t.getSetting(SKILLS_CONFIG_SETTING);
  if (raw === undefined) return {};
  const parsed = TenantSkillsConfigSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : {};
}

export async function readSkillLimits(t: SettingsReader): Promise<SkillLimits> {
  return effectiveSkillLimits(await readSkillsConfig(t));
}

export async function writeSkillsConfig(t: SettingsWriter, config: TenantSkillsConfig): Promise<void> {
  await t.putSetting(SKILLS_CONFIG_SETTING, JSON.stringify(TenantSkillsConfigSchema.parse(config)));
}

/** The Tenant's artifact and skill limits. */
export async function readTenantLimits(t: SettingsReader): Promise<StorageLimits> {
  return { artifacts: await readArtifactLimits(t), skills: await readSkillLimits(t) };
}

/** The limits in force for an Environment whose manifest sets `set`: each within the Tenant's. */
export function limitsInForce(tenant: StorageLimits, set: EnvironmentLimits | undefined): StorageLimits {
  const within = (asked: number | undefined, ceiling: number) => Math.min(asked ?? ceiling, ceiling);
  return {
    artifacts: {
      fileBytes: within(set?.artifacts?.fileBytes, tenant.artifacts.fileBytes),
      totalBytes: within(set?.artifacts?.totalBytes, tenant.artifacts.totalBytes),
    },
    skills: { totalBytes: within(set?.skills?.totalBytes, tenant.skills.totalBytes) },
  };
}

/** Why a manifest's `limits` cannot be made: each limit above the Tenant's. */
export function limitIssues(set: EnvironmentLimits | undefined, tenant: StorageLimits): string[] {
  const issues: string[] = [];
  const check = (path: string, asked: number | undefined, ceiling: number) => {
    if (asked !== undefined && asked > ceiling)
      issues.push(`limits.${path} asks for ${asked} bytes; this Tenant allows at most ${ceiling}.`);
  };
  check("artifacts.fileBytes", set?.artifacts?.fileBytes, tenant.artifacts.fileBytes);
  check("artifacts.totalBytes", set?.artifacts?.totalBytes, tenant.artifacts.totalBytes);
  check("skills.totalBytes", set?.skills?.totalBytes, tenant.skills.totalBytes);
  return issues;
}
