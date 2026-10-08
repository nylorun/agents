/**
 * The local machine's Nylorun files, for Node clients (`@nylorun/core/project`): the Nylorun
 * home and a local Tenant's Host root, the Project root, and the Project link
 * (`.nylorun/link.json`) and credentials (`.nylorun/credentials.json`) that `nylorun start`
 * writes. It imports `node:fs`, so no browser entry point imports it.
 *
 * Every reader of the link uses it (`@nylorun/agents`, `@nylorun/admin`, `nylorun` and `nylo`),
 * with one behaviour:
 *
 * - The Project is the nearest directory, from the working directory upwards, that holds
 *   `.nylorun/`; without one, `findProjectRoot` falls back to the nearest `package.json`. The
 *   walk never reaches the home directory, whose `.nylorun/` is the Nylorun home and never a
 *   Project, nor anything above it; outside the home directory it ends at the filesystem root.
 * - Reads are synchronous (`createAdmin` resolves synchronously).
 * - A missing file reads as `undefined`. A file that is not JSON or fails its schema
 *   (`ProjectLinkFileSchema`, `ProjectCredentialsFileSchema`) throws `ProjectFileError`
 *   (`reason: "invalid"`); a newer format than this release reads throws it with
 *   `reason: "newer"`. Links of formats 0 to 2 read as such: `nylorun start` replaces them, and
 *   the clients refuse them.
 * - Credentials come only from the Project's own `credentials.json`. Falling back to the Host
 *   root (`host.json` and its key files) is the Management API's local-Host step
 *   (`@nylorun/admin`), never the Runtime API's: an application gets its key from its Project
 *   or its environment.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import {
  ProjectCredentialsFileSchema,
  ProjectLinkFileSchema,
  type ProjectCredentialsFile,
} from "./contracts.js";

/** The newest Project link format this release reads. */
export const PROJECT_LINK_FORMAT = 3;
/** The newest Project credentials format this release reads. */
export const PROJECT_CREDENTIALS_FORMAT = 1;

/**
 * The Nylorun home: `home` when given, else `NYLORUN_HOME`, else `~/.nylorun`. `nylorun`
 * keeps the local Tenants under it (`tenants/<name>/`); `NYLORUN_HOME` there is one Tenant's
 * Host root.
 */
export function nylorunHome(
  home?: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (home !== undefined && home.trim() !== "") return resolve(home);
  const fromEnv = env.NYLORUN_HOME?.trim();
  if (fromEnv) return resolve(fromEnv);
  return resolve(join(homedir(), ".nylorun"));
}

/** A local Tenant's Host root: `~/.nylorun/tenants/<name>/`. */
export function tenantHostRoot(name: string): string {
  return resolve(join(homedir(), ".nylorun", "tenants", name));
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The walk from `cwd` upwards: the nearest `.nylorun/` and the nearest `package.json`. */
function walk(cwd: string): { linked?: string; packageRoot?: string } {
  const stop = real(homedir());
  let directory = real(resolve(cwd));
  const root = parse(directory).root;
  let packageRoot: string | undefined;
  for (;;) {
    // The home directory is never a Project, but a directory below it is.
    if (directory === stop) break;
    if (existsSync(join(directory, ".nylorun"))) return { linked: directory };
    if (!packageRoot && existsSync(join(directory, "package.json"))) packageRoot = directory;
    if (directory === root) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return packageRoot ? { packageRoot } : {};
}

/**
 * The Project root: the nearest directory with `.nylorun/` (so a linked Project keeps working
 * from a subdirectory), else the nearest with `package.json`; undefined outside a Project.
 */
export function findProjectRoot(cwd: string = process.cwd()): string | undefined {
  const { linked, packageRoot } = walk(cwd);
  return linked ?? packageRoot;
}

/** The nearest directory with `.nylorun/`, where a Project link would be; undefined without one. */
export function findLinkedProjectRoot(cwd: string = process.cwd()): string | undefined {
  return walk(cwd).linked;
}

export function projectLinkPath(projectRoot: string): string {
  return join(projectRoot, ".nylorun", "link.json");
}

export function projectCredentialsPath(projectRoot: string): string {
  return join(projectRoot, ".nylorun", "credentials.json");
}

/** A Project file that cannot be used: not JSON, not its schema, or a newer format. */
export class ProjectFileError extends Error {
  constructor(
    readonly file: "link" | "credentials",
    readonly reason: "invalid" | "newer",
    readonly path: string,
  ) {
    super(
      reason === "newer"
        ? `The Project ${file === "link" ? "link" : "credentials"} at ${path} ${file === "link" ? "has" : "have"} a newer format than this release reads. Upgrade this client.`
        : `Invalid Project ${file === "link" ? "link" : "credentials"} at ${path}. Remove .nylorun/${file === "link" ? "link" : "credentials"}.json and run "npx nylorun start".`,
    );
    this.name = "ProjectFileError";
  }
}

/** The Project link as its readers use it: `tenant` only in format 3, `hostUrl` without a trailing `/`. */
export interface ProjectLink {
  format: 0 | 1 | 2 | 3;
  /** The local Tenant's name (format 3); absent for an installation that is not local. */
  tenant?: string;
  hostUrl: string;
  hostId: string;
  /** Information only: nothing in a request selects a Tenant. */
  tenantId?: string;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function newerFormat(value: unknown, newest: number): boolean {
  const format = (value as { format?: unknown } | null)?.format;
  return typeof format === "number" && Number.isInteger(format) && format > newest;
}

/** The link at `path`; undefined when there is none. */
export function readProjectLinkFile(path: string): ProjectLink | undefined {
  const text = readText(path);
  if (text === undefined) return undefined;
  const value = json(text);
  if (newerFormat(value, PROJECT_LINK_FORMAT)) throw new ProjectFileError("link", "newer", path);
  const parsed = ProjectLinkFileSchema.safeParse(value);
  if (!parsed.success) throw new ProjectFileError("link", "invalid", path);
  const link = parsed.data;
  return {
    format: link.format,
    ...(link.format === 3 && link.tenant ? { tenant: link.tenant } : {}),
    hostUrl: link.hostUrl.replace(/\/$/, ""),
    hostId: link.hostId,
    ...(link.tenantId ? { tenantId: link.tenantId } : {}),
  };
}

/** The Project's link (`.nylorun/link.json`); undefined when it has none. */
export function readProjectLink(projectRoot: string): ProjectLink | undefined {
  return readProjectLinkFile(projectLinkPath(projectRoot));
}

/** The Project's keys as `credentials.json` holds them, without fields this release ignores. */
export type ProjectCredentials = Pick<
  ProjectCredentialsFile,
  "format" | "applicationKey" | "principalId" | "managementKey" | "managementPrincipalId"
>;

/**
 * A credentials file (format 0 or 1): the Project's, or one of the key files `nylorun` keeps in
 * a Host root (`project-credentials.json`, `cli-credentials.json`). Undefined when there is
 * none. A format 0 file's legacy `executors` map is ignored.
 */
export function readCredentialsFile(path: string): ProjectCredentials | undefined {
  const text = readText(path);
  if (text === undefined) return undefined;
  const value = json(text);
  if (newerFormat(value, PROJECT_CREDENTIALS_FORMAT))
    throw new ProjectFileError("credentials", "newer", path);
  const parsed = ProjectCredentialsFileSchema.safeParse(value);
  if (!parsed.success) throw new ProjectFileError("credentials", "invalid", path);
  const credentials = parsed.data;
  return {
    format: credentials.format,
    applicationKey: credentials.applicationKey,
    principalId: credentials.principalId,
    ...(credentials.managementKey ? { managementKey: credentials.managementKey } : {}),
    ...(credentials.managementPrincipalId
      ? { managementPrincipalId: credentials.managementPrincipalId }
      : {}),
  };
}

/** The Project's credentials (`.nylorun/credentials.json`); undefined when it has none. */
export function readProjectCredentials(projectRoot: string): ProjectCredentials | undefined {
  return readCredentialsFile(projectCredentialsPath(projectRoot));
}

/** The linked Project found from `cwd`: its root and link, and its credentials when it has them. */
export interface LinkedProject {
  root: string;
  linkPath: string;
  link: ProjectLink;
  credentials?: ProjectCredentials;
}

/**
 * The one resolver: the Project from `cwd` upwards (`findLinkedProjectRoot`) and its link and
 * credentials. Undefined when no Project there has a link; a broken file throws
 * `ProjectFileError`. The caller decides what an older link format or missing credentials
 * mean.
 */
export function findLinkedProject(cwd: string = process.cwd()): LinkedProject | undefined {
  const root = findLinkedProjectRoot(cwd);
  if (root === undefined) return undefined;
  const link = readProjectLink(root);
  if (link === undefined) return undefined;
  const credentials = link.format === PROJECT_LINK_FORMAT ? readProjectCredentials(root) : undefined;
  return {
    root,
    linkPath: projectLinkPath(root),
    link,
    ...(credentials ? { credentials } : {}),
  };
}
