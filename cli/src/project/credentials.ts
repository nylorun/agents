import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { CliError } from "../errors.js";
import {
  credentialsPath,
  ensureProjectNylorunDir,
} from "./link.js";

/**
 * Project-local credentials (mode 0600): the application key and its principal. A format 0
 * file may still carry a legacy `executors` map from before protocol 3; it is ignored.
 */
export interface ProjectCredentials {
  format: 0 | 1;
  applicationKey: string;
  principalId: string;
}

/** The Project's credentials, or with `tenantId` the key kept for that Tenant. */
export async function readCredentials(
  projectRoot: string,
  tenantId?: string,
): Promise<ProjectCredentials | undefined> {
  const path = credentialsPath(projectRoot, tenantId);
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as {
      format?: unknown;
      applicationKey?: unknown;
      principalId?: unknown;
    };
    if (
      typeof value?.applicationKey !== "string" ||
      !/^[0-9a-f]{64}$/.test(value.applicationKey) ||
      typeof value?.principalId !== "string" ||
      value.principalId.length === 0
    ) {
      throw new CliError(
        `Invalid Project credentials at ${path}. Remove .nylorun/credentials.json and run nylo tenant create.`,
        1,
      );
    }
    const format =
      value.format === undefined || value.format === 0
        ? 0
        : value.format === 1
          ? 1
          : undefined;
    if (format === undefined) {
      throw new CliError(
        `Project credentials at ${path} have an unsupported format. Upgrade the CLI.`,
        1,
      );
    }
    await chmod(path, 0o600);
    return {
      format,
      applicationKey: value.applicationKey,
      principalId: value.principalId,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeCredentials(
  projectRoot: string,
  credentials: {
    applicationKey: string;
    principalId: string;
    format?: 0 | 1;
  },
  tenantId?: string,
): Promise<void> {
  await ensureProjectNylorunDir(projectRoot);
  const path = credentialsPath(projectRoot, tenantId);
  const temporary = `${path}.${randomUUID()}.tmp`;
  // Version 1 writes format 1 with only the application key and principal (D§3.7).
  const body = `${JSON.stringify(
    {
      format: credentials.format ?? 1,
      applicationKey: credentials.applicationKey,
      principalId: credentials.principalId,
    },
    null,
    2,
  )}\n`;
  try {
    await writeFile(temporary, body, { mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function removeCredentials(
  projectRoot: string,
  tenantId?: string,
): Promise<void> {
  await rm(credentialsPath(projectRoot, tenantId), { force: true });
}
