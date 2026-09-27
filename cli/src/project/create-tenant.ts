import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createAdmin, type Admin } from "@nylorun/admin";
import { newPrincipalId } from "@nylorun/agents";
import { CliError } from "../errors.js";
import {
  writeCredentials,
  type ProjectCredentials,
} from "./credentials.js";
import { writeLink, type ProjectLink } from "./link.js";

export interface CreateTenantOptions {
  /** Prefer an already-resolved Admin (local Host or explicit). */
  admin: Admin;
  hostId: string;
  projectRoot: string;
  name?: string;
  /** Override Host URL written into the link (defaults to admin.url). */
  hostUrl?: string;
}

export interface CreateTenantResult {
  link: ProjectLink;
  credentials: ProjectCredentials;
  envelope: { id: string; name: string };
}

/** The Project's `package.json` name, else its directory name. */
export async function defaultTenantName(projectRoot: string): Promise<string> {
  try {
    const pkg = JSON.parse(
      await readFile(join(projectRoot, "package.json"), "utf8"),
    ) as { name?: string };
    if (typeof pkg.name === "string" && pkg.name.trim()) return pkg.name.trim();
  } catch {
    /* fall through */
  }
  const base = basename(projectRoot);
  return base && base.length > 0 ? base : "project";
}

/**
 * Create a Tenant via `@nylorun/admin` and write format-1 link + credentials.
 */
export async function createProjectTenant(
  options: CreateTenantOptions,
): Promise<CreateTenantResult> {
  const name = options.name ?? (await defaultTenantName(options.projectRoot));
  const admin = options.admin;

  let created: { tenant: { id: string; name: string }; applicationKey: string };
  try {
    created = await admin.createTenant({ name });
  } catch (error) {
    throw new CliError(
      error instanceof Error
        ? error.message
        : `Could not create Tenant: ${String(error)}`,
      1,
    );
  }

  const hostUrl = (options.hostUrl ?? admin.url).replace(/\/$/, "");
  // CLIENTS-CCR: admin.createTenant should also return principalId (D§4.2 /
  // credentials.json). Until then, mint a local id for the credentials file;
  // agents resolveConnection only needs applicationKey.
  const principalId =
    "principalId" in created &&
    typeof (created as { principalId?: unknown }).principalId === "string"
      ? (created as { principalId: string }).principalId
      : newPrincipalId();

  const credentials: ProjectCredentials = {
    format: 1,
    applicationKey: created.applicationKey,
    principalId,
  };
  const link: ProjectLink = {
    format: 1,
    hostUrl,
    hostId: options.hostId,
    tenantId: created.tenant.id,
  };
  await writeCredentials(options.projectRoot, credentials);
  await writeLink(options.projectRoot, link);
  return {
    link,
    credentials,
    envelope: { id: created.tenant.id, name: created.tenant.name },
  };
}

/** Resolve Admin from the local Host root (host.json and the admin key). */
export function localAdmin(home?: string): Admin {
  return createAdmin(home ? { home } : undefined);
}
