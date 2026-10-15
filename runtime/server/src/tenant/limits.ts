/**
 * What artifacts, skills and disk versions may hold: the Tenant's limits (`artifacts.config`,
 * `skills.config` here, and the Runtime limits `diskVersion*` of `limits.config`), and an
 * Environment's, which its manifest sets (`limits`). A limit the manifest leaves out is the
 * Tenant's as it is when the limit is checked, and none is ever above the Tenant's: a manifest
 * asking for more is refused when the Environment is made, and a Tenant that lowers a limit
 * later lowers it for every Environment.
 *
 * Also the shape a manifest and an Environment's labels must fit, which the Tenant's Runtime
 * limits set (`manifestShapeIssues`, `labelIssues`), checked when they are put rather than by
 * their schemas (B15).
 */
import {
  SKILL_TOTAL_BYTES_DEFAULT,
  TenantSkillsConfigSchema,
  type EnvironmentFile,
  type EnvironmentLimits,
  type EnvironmentSecretSlots,
  type EnvironmentSetupCommand,
  type RuntimeLimits,
  type TenantSkillsConfig,
} from "@nylorun/core/contracts";
import { parseSandboxDuration } from "@nylorun/core/define";
import { readArtifactLimits, type ArtifactLimits } from "../artifacts/config.js";
import { readRuntimeLimits } from "./runtime-limits.js";

export const SKILLS_CONFIG_SETTING = "skills.config";

export interface SkillLimits {
  readonly totalBytes: number;
}

/** What one version of an Environment's disk may hold. */
export interface DiskLimits {
  readonly versionBytes: number;
  readonly versionEntries: number;
}

/** The limits an Environment's artifacts, skills and disk versions are held to. */
export interface StorageLimits {
  readonly artifacts: ArtifactLimits;
  readonly skills: SkillLimits;
  readonly disk: DiskLimits;
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

/** The Tenant's artifact, skill and disk version limits. */
export async function readTenantLimits(t: SettingsReader): Promise<StorageLimits> {
  const runtime = await readRuntimeLimits(t);
  return {
    artifacts: await readArtifactLimits(t),
    skills: await readSkillLimits(t),
    disk: { versionBytes: runtime.diskVersionBytes, versionEntries: runtime.diskVersionEntries },
  };
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
    disk: {
      versionBytes: within(set?.disk?.versionBytes, tenant.disk.versionBytes),
      versionEntries: within(set?.disk?.versionEntries, tenant.disk.versionEntries),
    },
  };
}

/** Why a manifest's `limits` cannot be made: each limit above the Tenant's. */
export function limitIssues(set: EnvironmentLimits | undefined, tenant: StorageLimits): string[] {
  const issues: string[] = [];
  const check = (path: string, asked: number | undefined, ceiling: number, unit = "bytes") => {
    if (asked !== undefined && asked > ceiling)
      issues.push(`limits.${path} asks for ${asked} ${unit}; this Tenant allows at most ${ceiling}.`);
  };
  check("artifacts.fileBytes", set?.artifacts?.fileBytes, tenant.artifacts.fileBytes);
  check("artifacts.totalBytes", set?.artifacts?.totalBytes, tenant.artifacts.totalBytes);
  check("skills.totalBytes", set?.skills?.totalBytes, tenant.skills.totalBytes);
  check("disk.versionBytes", set?.disk?.versionBytes, tenant.disk.versionBytes);
  check("disk.versionEntries", set?.disk?.versionEntries, tenant.disk.versionEntries, "entries");
  return issues;
}

/** Why `labels` cannot be set: more than the Tenant's Runtime limit `environmentLabels`. */
export function labelIssues(labels: Readonly<Record<string, string>> | undefined, limits: RuntimeLimits): string[] {
  const count = labels === undefined ? 0 : Object.keys(labels).length;
  return count > limits.environmentLabels
    ? [`labels has ${count}; the Runtime limit environmentLabels allows at most ${limits.environmentLabels} (PUT /v1/tenant/limits).`]
    : [];
}

/** The parts of a manifest whose shape the Tenant's Runtime limits set. */
export interface ManifestShape {
  readonly setup?: readonly EnvironmentSetupCommand[] | undefined;
  readonly files?: readonly EnvironmentFile[] | undefined;
  readonly secrets?: EnvironmentSecretSlots | undefined;
}

/**
 * Why a manifest (inline, or saved) does not fit the Tenant's Runtime limits: its setup commands,
 * their timeouts, its input file entries and the files of each, and its secret slots.
 */
export function manifestShapeIssues(manifest: ManifestShape, limits: RuntimeLimits): string[] {
  const issues: string[] = [];
  const over = (what: string, count: number, name: keyof RuntimeLimits) => {
    if (count > limits[name])
      issues.push(`${what} has ${count}; the Runtime limit ${name} allows at most ${limits[name]} (PUT /v1/tenant/limits).`);
  };
  over("setup", manifest.setup?.length ?? 0, "environmentSetupCommands");
  over("files", manifest.files?.length ?? 0, "environmentFiles");
  over("secrets", Object.keys(manifest.secrets ?? {}).length, "environmentSecretSlots");
  manifest.setup?.forEach((command, index) => {
    const ms = command.timeout === undefined ? undefined : parseSandboxDuration(command.timeout);
    if (ms !== undefined && ms > limits.setupCommandMs)
      issues.push(
        `setup[${index}].timeout asks for ${ms} ms; the Runtime limit setupCommandMs allows at most ${limits.setupCommandMs} (PUT /v1/tenant/limits).`,
      );
  });
  manifest.files?.forEach((file, index) => {
    if ("files" in file) over(`files[${index}].files`, Object.keys(file.files).length, "environmentFilesPerEntry");
  });
  return issues;
}
