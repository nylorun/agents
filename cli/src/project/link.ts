import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "../errors.js";

/**
 * Project-local link to an installation (format 2). `nylorun start` writes it; `nylo` only
 * reads it. `tenantId` is information: the installation serves one Tenant, so nothing selects it.
 */
export interface ProjectLink {
  format: 2;
  /** The local stack the link names (`~/.nylorun/stacks/<stack>/`). */
  stack?: string;
  hostUrl: string;
  hostId: string;
  tenantId?: string;
}

export function nylorunDir(projectRoot: string): string {
  return join(projectRoot, ".nylorun");
}

export function linkPath(projectRoot: string): string {
  return join(nylorunDir(projectRoot), "link.json");
}

/** `.nylorun/credentials.json`. */
export function credentialsPath(projectRoot: string): string {
  return join(nylorunDir(projectRoot), "credentials.json");
}

export async function readLink(
  projectRoot: string,
): Promise<ProjectLink | undefined> {
  const path = linkPath(projectRoot);
  let value: {
    format?: unknown;
    stack?: unknown;
    hostUrl?: unknown;
    hostId?: unknown;
    tenantId?: unknown;
  };
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CliError(
      `Invalid Project link at ${path}. Remove .nylorun/link.json and run "npx nylorun start".`,
      1,
    );
  }
  // Formats 0 and 1 named a Tenant on a multi-Tenant Host of an older Runtime.
  if (value?.format === undefined || value.format === 0 || value.format === 1)
    throw new CliError(
      `The Project link at ${path} is for a stack of an older Runtime, before one Tenant per installation. Run "npx nylorun start" in this project to start its own stack and link it again.`,
      1,
    );
  if (value.format !== 2)
    throw new CliError(
      `Project link at ${path} has an unsupported format. Upgrade the CLI.`,
      1,
    );
  if (
    typeof value.hostUrl !== "string" ||
    typeof value.hostId !== "string" ||
    (value.stack !== undefined && typeof value.stack !== "string") ||
    (value.tenantId !== undefined && typeof value.tenantId !== "string")
  )
    throw new CliError(
      `Invalid Project link at ${path}. Remove .nylorun/link.json and run "npx nylorun start".`,
      1,
    );
  return {
    format: 2,
    ...(value.stack ? { stack: value.stack } : {}),
    hostUrl: value.hostUrl.replace(/\/$/, ""),
    hostId: value.hostId,
    ...(value.tenantId ? { tenantId: value.tenantId } : {}),
  };
}
