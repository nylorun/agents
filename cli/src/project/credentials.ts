import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { CliError } from "../errors.js";
import {
  credentialsPath,
  ensureProjectNylorunDir,
} from "./link.js";

/**
 * Project-local credentials (mode 0600). Format 1 drops `executors`.
 * Format 0 may still contain an executors map; readers ignore it (D§3.7).
 */
export interface ProjectCredentials {
  format: 0 | 1;
  applicationKey: string;
  principalId: string;
  /** Present only on format 0 files; ignored by version 1. */
  executors?: Record<string, string>;
}

export async function readCredentials(
  projectRoot: string,
): Promise<ProjectCredentials | undefined> {
  const path = credentialsPath(projectRoot);
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as {
      format?: unknown;
      applicationKey?: unknown;
      principalId?: unknown;
      executors?: unknown;
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
    const executors =
      format === 0 &&
      value.executors &&
      typeof value.executors === "object" &&
      !Array.isArray(value.executors)
        ? (value.executors as Record<string, string>)
        : undefined;
    return {
      format,
      applicationKey: value.applicationKey,
      principalId: value.principalId,
      ...(executors ? { executors } : {}),
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
): Promise<void> {
  await ensureProjectNylorunDir(projectRoot);
  const path = credentialsPath(projectRoot);
  const temporary = `${path}.${randomUUID()}.tmp`;
  // Version 1 writes format 1 without executors (D§3.7).
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

export async function removeCredentials(projectRoot: string): Promise<void> {
  await rm(credentialsPath(projectRoot), { force: true });
}
