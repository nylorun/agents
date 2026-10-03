import { CliError } from "../errors.js";
import { readCredentials } from "./credentials.js";
import { readLink, type ProjectLink } from "./link.js";

/** The installation `nylo` acts on: a Runtime URL and an application key. */
export interface LinkedConnection {
  url: string;
  key: string;
  /** The Project link it came from, when it came from one. */
  link?: ProjectLink;
}

/**
 * The Project's link and credentials, else `NYLORUN_RUNTIME_URL` and `NYLORUN_SERVER_KEY`. The
 * installation serves one Tenant, so nothing names it.
 */
export async function linkedConnection(
  projectRoot: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<LinkedConnection> {
  const link = await readLink(projectRoot);
  const credentials = await readCredentials(projectRoot);
  if (link && credentials)
    return { url: link.hostUrl, key: credentials.applicationKey, link };
  const url = env.NYLORUN_RUNTIME_URL?.trim();
  const key = env.NYLORUN_SERVER_KEY?.trim();
  if (url && key) return { url: url.replace(/\/$/, ""), key };
  throw new CliError(
    `No Project link in ${projectRoot}. Run "npx nylorun start" in this project to start its Tenant and link it, or set NYLORUN_RUNTIME_URL and NYLORUN_SERVER_KEY.`,
    1,
  );
}
