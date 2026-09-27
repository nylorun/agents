import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isTenantId } from "@nylorun/agents";
import { CliError } from "../errors.js";

/** Project-local link to a Runtime Host Tenant (D§3.7, format 0|1). */
export interface ProjectLink {
  format: 0 | 1;
  hostUrl: string;
  hostId: string;
  tenantId: string;
}

export function nylorunDir(projectRoot: string): string {
  return join(projectRoot, ".nylorun");
}

export function linkPath(projectRoot: string): string {
  return join(nylorunDir(projectRoot), "link.json");
}

export function credentialsPath(projectRoot: string): string {
  return join(nylorunDir(projectRoot), "credentials.json");
}

/**
 * Create `.nylorun/` mode 0700 with a private `.gitignore` containing `*`.
 * The Project's own `.gitignore` is never edited.
 */
export async function ensureProjectNylorunDir(
  projectRoot: string,
): Promise<string> {
  const dir = nylorunDir(projectRoot);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, ".gitignore"), "*\n", { mode: 0o600 }).catch(
    async () => {
      await writeFile(join(dir, ".gitignore"), "*\n", { mode: 0o600 });
    },
  );
  return dir;
}

export async function readLink(
  projectRoot: string,
): Promise<ProjectLink | undefined> {
  try {
    const value = JSON.parse(await readFile(linkPath(projectRoot), "utf8")) as {
      format?: unknown;
      hostUrl?: unknown;
      hostId?: unknown;
      tenantId?: unknown;
    };
    if (
      typeof value?.hostUrl !== "string" ||
      typeof value?.hostId !== "string" ||
      typeof value?.tenantId !== "string" ||
      !isTenantId(value.tenantId)
    ) {
      throw new CliError(
        `Invalid Project link at ${linkPath(projectRoot)}. Remove .nylorun/link.json and run nylo tenant create.`,
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
        `Project link at ${linkPath(projectRoot)} has an unsupported format. Upgrade the CLI.`,
        1,
      );
    }
    return {
      format,
      hostUrl: value.hostUrl.replace(/\/$/, ""),
      hostId: value.hostId,
      tenantId: value.tenantId,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeLink(
  projectRoot: string,
  link: Omit<ProjectLink, "format"> & { format?: 0 | 1 },
): Promise<void> {
  await ensureProjectNylorunDir(projectRoot);
  const path = linkPath(projectRoot);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const body = `${JSON.stringify(
    {
      format: link.format ?? 1,
      hostUrl: link.hostUrl.replace(/\/$/, ""),
      hostId: link.hostId,
      tenantId: link.tenantId,
    },
    null,
    2,
  )}\n`;
  try {
    await writeFile(temporary, body, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function removeLink(projectRoot: string): Promise<void> {
  await rm(linkPath(projectRoot), { force: true });
}
