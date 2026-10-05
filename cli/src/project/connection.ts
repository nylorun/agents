import { createManagementClient, type ManagementClient } from "@nylorun/admin";
import { CliError } from "../errors.js";
import { readCredentials } from "./credentials.js";
import { readLink, type ProjectLink } from "./link.js";

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
