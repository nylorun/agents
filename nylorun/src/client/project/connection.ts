import { chmod } from "node:fs/promises";
import { createManagementClient, type ManagementClient } from "@nylorun/admin";
import {
  ProjectFileError,
  projectCredentialsPath,
  projectLinkPath,
  readProjectCredentials,
  readProjectLink,
  type ProjectCredentials,
  type ProjectLink as LinkFile,
} from "@nylorun/core/project";
import { CliError } from "../../errors.js";

/**
 * The Project link (format 3), which `nylorun start` writes and `nylo` only reads with
 * `@nylorun/core/project`'s reader. `tenantId` is information: the installation serves one
 * Tenant, so nothing selects it.
 */
export type ProjectLink = LinkFile & { format: 3 };

/** The Project's link; one of an older nylorun (formats 0 to 2) is refused. */
export async function readLink(projectRoot: string): Promise<ProjectLink | undefined> {
  const path = projectLinkPath(projectRoot);
  let link: LinkFile | undefined;
  try {
    link = readProjectLink(projectRoot);
  } catch (error) {
    if (!(error instanceof ProjectFileError)) throw error;
    throw new CliError(
      error.reason === "newer"
        ? `Project link at ${path} has an unsupported format. Upgrade nylorun.`
        : `Invalid Project link at ${path}. Remove .nylorun/link.json and run "npx nylorun start".`,
      1,
    );
  }
  if (link === undefined) return undefined;
  if (link.format !== 3)
    throw new CliError(
      `The Project link at ${path} is from an older nylorun. Run "npx nylorun start" in this project to link it again.`,
      1,
    );
  return { ...link, format: 3 };
}

/**
 * The Project's credentials (mode 0600), which `nylorun start` writes beside the link: the
 * application key and its principal, and the management key and its principal when it issued
 * one. A format 0 file's legacy `executors` map is ignored.
 */
export async function readCredentials(
  projectRoot: string,
): Promise<ProjectCredentials | undefined> {
  const path = projectCredentialsPath(projectRoot);
  let credentials: ProjectCredentials | undefined;
  try {
    credentials = readProjectCredentials(projectRoot);
  } catch (error) {
    if (!(error instanceof ProjectFileError)) throw error;
    throw new CliError(
      error.reason === "newer"
        ? `Project credentials at ${path} have an unsupported format. Upgrade nylorun.`
        : `Invalid Project credentials at ${path}. Remove .nylorun/credentials.json and run "npx nylorun start".`,
      1,
    );
  }
  if (credentials) await chmod(path, 0o600);
  return credentials;
}

/** The installation `nylo` acts on: a Runtime URL, an application key and a management key. */
export interface LinkedConnection {
  url: string;
  /** The application key (Runtime API); absent when only a management key is set. */
  key?: string;
  /** The management key (Management API), when there is one. */
  managementKey?: string;
  /** The Project link it came from, when it came from one. */
  link?: ProjectLink;
}

/**
 * The Project's link and credentials, else `NYLORUN_RUNTIME_URL` with `NYLORUN_SERVER_KEY`, or
 * `NYLORUN_MANAGEMENT_KEY`, or both; `NYLORUN_MANAGEMENT_KEY` also stands in for a Project
 * credentials file without one. The installation serves one Tenant, so nothing names it.
 */
export async function linkedConnection(
  projectRoot: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<LinkedConnection> {
  const link = await readLink(projectRoot);
  const credentials = await readCredentials(projectRoot);
  const managementKey = env.NYLORUN_MANAGEMENT_KEY?.trim();
  if (link && credentials) {
    const management = credentials.managementKey ?? managementKey;
    return {
      url: link.hostUrl,
      key: credentials.applicationKey,
      ...(management ? { managementKey: management } : {}),
      link,
    };
  }
  const url = env.NYLORUN_RUNTIME_URL?.trim();
  const key = env.NYLORUN_SERVER_KEY?.trim();
  if (url && (key || managementKey))
    return {
      url: url.replace(/\/$/, ""),
      ...(key ? { key } : {}),
      ...(managementKey ? { managementKey } : {}),
    };
  throw new CliError(
    `No Project link in ${projectRoot}. Run "npx nylorun start" in this project to start its Tenant and link it, or set NYLORUN_RUNTIME_URL and NYLORUN_SERVER_KEY (or NYLORUN_MANAGEMENT_KEY).`,
    1,
  );
}

/** The Management API client of `connection`; refused without a management key. */
export function managementClient(connection: LinkedConnection): ManagementClient {
  if (!connection.managementKey)
    throw new CliError(
      `No management key for the Tenant at ${connection.url}: run npx nylorun start, or set NYLORUN_MANAGEMENT_KEY.`,
      1,
    );
  return createManagementClient({ url: connection.url, key: connection.managementKey });
}
