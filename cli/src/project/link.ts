import {
  ProjectFileError,
  projectLinkPath,
  readProjectLink,
  type ProjectLink as LinkFile,
} from "@nylorun/admin/project";
import { CliError } from "../errors.js";

/**
 * Project-local link to an installation (format 3). `nylorun start` writes it; `nylo` only
 * reads it, with `@nylorun/core/project`'s reader (through `@nylorun/admin/project`).
 * `tenantId` is information: the installation serves one Tenant, so nothing selects it.
 */
export type ProjectLink = LinkFile & { format: 3 };

export async function readLink(
  projectRoot: string,
): Promise<ProjectLink | undefined> {
  const path = projectLinkPath(projectRoot);
  let link: LinkFile | undefined;
  try {
    link = readProjectLink(projectRoot);
  } catch (error) {
    if (!(error instanceof ProjectFileError)) throw error;
    throw new CliError(
      error.reason === "newer"
        ? `Project link at ${path} has an unsupported format. Upgrade the CLI.`
        : `Invalid Project link at ${path}. Remove .nylorun/link.json and run "npx nylorun start".`,
      1,
    );
  }
  if (link === undefined) return undefined;
  // Formats 0 to 2 are from older releases.
  if (link.format !== 3)
    throw new CliError(
      `The Project link at ${path} is from an older nylorun. Run "npx nylorun start" in this project to link it again.`,
      1,
    );
  return { ...link, format: 3 };
}
