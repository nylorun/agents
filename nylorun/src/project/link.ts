import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProjectLinkFileSchema } from "@nylorun/core/contracts";
import { CliError } from "../errors.js";

/**
 * The Project link (`.nylorun/link.json`) and credentials (`.nylorun/credentials.json`).
 * `nylorun start` writes both, format 3: the local Tenant's name, its URL and Host id, and
 * the Tenant id as information (nothing in a request selects a Tenant). `start` replaces a link
 * of an older format.
 */
export interface ProjectLink {
  format: 0 | 1 | 2 | 3;
  /** The local Tenant's name (format 3). */
  tenant?: string;
  hostUrl: string;
  hostId: string;
  tenantId?: string;
}

export function linkPath(projectRoot: string): string {
  return join(projectRoot, ".nylorun", "link.json");
}

export function credentialsPath(projectRoot: string): string {
  return join(projectRoot, ".nylorun", "credentials.json");
}

/** The Project's link, or undefined when it has none. An unreadable link is an error. */
export async function readProjectLink(projectRoot: string): Promise<ProjectLink | undefined> {
  let text: string;
  try {
    text = await readFile(linkPath(projectRoot), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  const parsed = ProjectLinkFileSchema.safeParse(value);
  if (!parsed.success)
    throw new CliError(
      `Invalid or newer Project link at ${linkPath(projectRoot)}. Upgrade nylorun, or remove the file and run "npx nylorun start" again.`,
      1,
    );
  const link = parsed.data;
  return {
    format: link.format,
    ...(link.format === 3 && link.tenant ? { tenant: link.tenant } : {}),
    hostUrl: link.hostUrl.replace(/\/$/, ""),
    hostId: link.hostId,
    ...(link.tenantId ? { tenantId: link.tenantId } : {}),
  };
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
  await writePrivate(linkPath(projectRoot), {
    format: 3,
    tenant: link.tenant,
    hostUrl: link.hostUrl.replace(/\/$/, ""),
    hostId: link.hostId,
    tenantId: link.tenantId,
  });
}

/** An application key and its principal: `credentials.json`'s content (format 1). */
export interface KeyCredentials {
  applicationKey: string;
  principalId: string;
}

/** The Project's application key and principal, or undefined when absent or unreadable. */
export async function readProjectCredentials(
  projectRoot: string,
): Promise<KeyCredentials | undefined> {
  return await readCredentialsFile(credentialsPath(projectRoot));
}

/**
 * A credentials file (`{ format: 1, applicationKey, principalId }`): the Project's, or one the
 * nylorun commands keep in the Host root. Undefined when absent or unreadable.
 */
export async function readCredentialsFile(path: string): Promise<KeyCredentials | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as {
      applicationKey?: unknown;
      principalId?: unknown;
    };
    return typeof value.applicationKey === "string" && typeof value.principalId === "string"
      ? { applicationKey: value.applicationKey, principalId: value.principalId }
      : undefined;
  } catch {
    return undefined;
  }
}

/** `.nylorun/credentials.json` (format 1, mode 0600). */
export async function writeProjectCredentials(
  projectRoot: string,
  credentials: KeyCredentials,
): Promise<void> {
  await ensureProjectDir(projectRoot);
  await writeCredentialsFile(credentialsPath(projectRoot), credentials);
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
  });
}
