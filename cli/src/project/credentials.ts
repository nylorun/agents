import { chmod, readFile } from "node:fs/promises";
import { CliError } from "../errors.js";
import { credentialsPath } from "./link.js";

/**
 * Project-local credentials (mode 0600): the application key and its principal, and the
 * management key and its principal when `nylorun start` issued one. A format 0 file may still
 * carry a legacy `executors` map from before protocol 3; it is ignored.
 */
export interface ProjectCredentials {
  format: 0 | 1;
  applicationKey: string;
  principalId: string;
  managementKey?: string;
  managementPrincipalId?: string;
}

/** The Project's credentials, which `nylorun start` writes beside the link. */
export async function readCredentials(
  projectRoot: string,
): Promise<ProjectCredentials | undefined> {
  const path = credentialsPath(projectRoot);
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as {
      format?: unknown;
      applicationKey?: unknown;
      principalId?: unknown;
      managementKey?: unknown;
      managementPrincipalId?: unknown;
    };
    if (
      typeof value?.applicationKey !== "string" ||
      !/^[0-9a-f]{64}$/.test(value.applicationKey) ||
      typeof value?.principalId !== "string" ||
      value.principalId.length === 0
    ) {
      throw new CliError(
        `Invalid Project credentials at ${path}. Remove .nylorun/credentials.json and run "npx nylorun start".`,
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
      ...(typeof value.managementKey === "string" &&
      /^[0-9a-f]{64}$/.test(value.managementKey) &&
      typeof value.managementPrincipalId === "string"
        ? { managementKey: value.managementKey, managementPrincipalId: value.managementPrincipalId }
        : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
