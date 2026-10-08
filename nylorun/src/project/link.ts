import { randomBytes } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ProjectFileError,
  projectCredentialsPath,
  projectLinkPath,
  readCredentialsFile as readCredentials,
  readProjectLink as readLink,
  type ProjectLink,
} from "@nylorun/core/project";
import { CliError } from "../errors.js";

/**
 * The Project link (`.nylorun/link.json`) and credentials (`.nylorun/credentials.json`).
 * `nylorun start` writes both, format 3: the local Tenant's name, its URL and Host id, and
 * the Tenant id as information (nothing in a request selects a Tenant). `start` replaces a link
 * of an older format. Reading is `@nylorun/core/project`'s, which every client shares.
 */
export type { ProjectLink };
export { projectLinkPath as linkPath, projectCredentialsPath as credentialsPath };

/** The Project's link, or undefined when it has none. An unreadable link is an error. */
export async function readProjectLink(projectRoot: string): Promise<ProjectLink | undefined> {
  try {
    return readLink(projectRoot);
  } catch (error) {
    if (error instanceof ProjectFileError)
      throw new CliError(
        `Invalid or newer Project link at ${error.path}. Upgrade nylorun, or remove the file and run "npx nylorun start" again.`,
        1,
      );
    throw error;
  }
}

async function writePrivate(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** `.nylorun/` mode 0700 with its own `.gitignore` of `*`; the Project's is never edited. */
async function ensureProjectDir(projectRoot: string): Promise<void> {
  const dir = join(projectRoot, ".nylorun");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await writeFile(join(dir, ".gitignore"), "*\n", { mode: 0o600 });
}

export async function writeProjectLink(
  projectRoot: string,
  link: { tenant: string; hostUrl: string; hostId: string; tenantId: string },
): Promise<void> {
  await ensureProjectDir(projectRoot);
  await writePrivate(projectLinkPath(projectRoot), {
    format: 3,
    tenant: link.tenant,
    hostUrl: link.hostUrl.replace(/\/$/, ""),
    hostId: link.hostId,
    tenantId: link.tenantId,
  });
}

/**
 * An application key and its principal, and the management key and its principal when the file
 * has one: `credentials.json`'s content (format 1).
 */
export interface KeyCredentials {
  applicationKey: string;
  principalId: string;
  management?: { key: string; principalId: string };
}

/** The Project's keys, or undefined when absent or unreadable. */
export async function readProjectCredentials(
  projectRoot: string,
): Promise<KeyCredentials | undefined> {
  return await readCredentialsFile(projectCredentialsPath(projectRoot));
}

/**
 * A credentials file (format 0 or 1): the Project's, or one the nylorun commands keep in the
 * Host root. Undefined when absent or unreadable, so `start` replaces it.
 */
export async function readCredentialsFile(path: string): Promise<KeyCredentials | undefined> {
  let value;
  try {
    value = readCredentials(path);
  } catch {
    return undefined;
  }
  if (!value) return undefined;
  return {
    applicationKey: value.applicationKey,
    principalId: value.principalId,
    ...(value.managementKey && value.managementPrincipalId
      ? { management: { key: value.managementKey, principalId: value.managementPrincipalId } }
      : {}),
  };
}

/** `.nylorun/credentials.json` (format 1, mode 0600). */
export async function writeProjectCredentials(
  projectRoot: string,
  credentials: KeyCredentials,
): Promise<void> {
  await ensureProjectDir(projectRoot);
  await writeCredentialsFile(projectCredentialsPath(projectRoot), credentials);
}

/** A credentials file (format 1), written atomically with mode 0600. */
export async function writeCredentialsFile(
  path: string,
  credentials: KeyCredentials,
): Promise<void> {
  await writePrivate(path, {
    format: 1,
    applicationKey: credentials.applicationKey,
    principalId: credentials.principalId,
    ...(credentials.management
      ? {
          managementKey: credentials.management.key,
          managementPrincipalId: credentials.management.principalId,
        }
      : {}),
  });
}
