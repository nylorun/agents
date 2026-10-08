import { chmod } from "node:fs/promises";
import {
  ProjectFileError,
  projectCredentialsPath,
  readProjectCredentials,
  type ProjectCredentials,
} from "@nylorun/admin/project";
import { CliError } from "../errors.js";

/**
 * Project-local credentials (mode 0600): the application key and its principal, and the
 * management key and its principal when `nylorun start` issued one. A format 0 file may still
 * carry a legacy `executors` map from before protocol 3; it is ignored.
 */
export type { ProjectCredentials };

/** The Project's credentials, which `nylorun start` writes beside the link; kept 0600. */
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
        ? `Project credentials at ${path} have an unsupported format. Upgrade the CLI.`
        : `Invalid Project credentials at ${path}. Remove .nylorun/credentials.json and run "npx nylorun start".`,
      1,
    );
  }
  if (credentials) await chmod(path, 0o600);
  return credentials;
}
