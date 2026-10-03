import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { CliError } from "../errors.js";

/**
 * The machine's local Tenants (tenancy.md §6): one installation per Tenant, each with its own
 * Host root `~/.nylorun/tenants/<name>/`, Compose project `nylorun-<name>`, ports and volumes.
 */

/** The Tenant a command acts on outside a project when nothing names one. */
export const DEFAULT_TENANT = "default";

/** A Tenant name: also part of its Compose project, so Compose's rules apply. */
export const TENANT_NAME = /^[a-z0-9][a-z0-9_-]*$/;

/** `~/.nylorun`: the Tenants and the machine's settings. Tests pass another directory. */
export function defaultNylorunRoot(): string {
  return resolve(join(homedir(), ".nylorun"));
}

export function tenantsDir(base: string): string {
  return join(base, "tenants");
}

export function tenantRoot(base: string, name: string): string {
  return join(tenantsDir(base), name);
}

export function assertTenantName(name: string, source: string): string {
  // A Tenant id, such as a NYLORUN_TENANT kept from an older release.
  if (/^tn_/i.test(name))
    throw new CliError(
      `${source} must be a Tenant's name, not a Tenant id: ${name}. "nylorun ls" lists the Tenants on this machine.`,
      2,
    );
  if (!TENANT_NAME.test(name))
    throw new CliError(
      `${source} must be lowercase letters, digits, "-" or "_", starting with a letter or digit: ${name}`,
      2,
    );
  return name;
}

/** A directory name as a Tenant name: lowercased, other characters as `-`, trimmed. */
export function sanitizeTenantName(raw: string): string {
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .replace(/^tn_/, "tn-");
  return name === "" ? "tenant" : name;
}

/** `tenant.json` in a Host root: the Tenant's name and the project it was created for. */
export interface TenantRecord {
  format: 1;
  name: string;
  /** The project directory `nylorun start` created the Tenant in; absent outside a project. */
  project?: string;
}

export function tenantRecordPath(root: string): string {
  return join(root, "tenant.json");
}

export async function readTenantRecord(root: string): Promise<TenantRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(tenantRecordPath(root), "utf8")) as {
      name?: unknown;
      project?: unknown;
    };
    if (typeof value?.name !== "string" || !TENANT_NAME.test(value.name)) return undefined;
    return {
      format: 1,
      name: value.name,
      ...(typeof value.project === "string" ? { project: value.project } : {}),
    };
  } catch {
    return undefined;
  }
}

export async function writeTenantRecord(root: string, record: Omit<TenantRecord, "format">): Promise<void> {
  const path = tenantRecordPath(root);
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const body = { format: 1, name: record.name, ...(record.project ? { project: record.project } : {}) };
  await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export interface TenantEntry {
  name: string;
  root: string;
  record: TenantRecord;
}

/**
 * The Tenants under `<base>/tenants`, by name: directories with a `tenant.json` (releases
 * before 0.4 kept other directories there).
 */
export async function listTenants(base: string): Promise<TenantEntry[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(tenantsDir(base), { withFileTypes: true });
  } catch {
    return [];
  }
  const tenants: TenantEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !TENANT_NAME.test(entry.name)) continue;
    const root = tenantRoot(base, entry.name);
    const record = await readTenantRecord(root);
    if (record) tenants.push({ name: entry.name, root, record });
  }
  return tenants.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The Tenant name for a project without a link: the directory's name, or the first `-2`,
 * `-3`, … suffix that no Tenant of another project directory holds. A Tenant this project
 * directory created keeps its name.
 */
export async function chooseTenantName(base: string, projectDir: string): Promise<string> {
  const name = sanitizeTenantName(basename(projectDir));
  const tenants = await listTenants(base);
  const candidate = new RegExp(`^${name}(?:-[0-9]+)?$`);
  const own = tenants.find((tenant) => candidate.test(tenant.name) && tenant.record.project === projectDir);
  if (own) return own.name;
  for (let suffix = 1; ; suffix += 1) {
    const next = suffix === 1 ? name : `${name}-${suffix}`;
    if (!existsSync(tenantRoot(base, next))) return next;
  }
}

/**
 * Move the Host roots of nylorun 0.4 (`~/.nylorun/stacks/<name>/`) to `tenants/<name>/`, when
 * that is free: `stack.json` becomes `tenant.json`, and `NYLORUN_STACK_NAME` becomes
 * `NYLORUN_TENANT_NAME` in `docker/.env` (and `docker/compose.yaml`, until the next start
 * rewrites it). `stacks/` goes when empty. They move rather than start fresh because Compose
 * project names do not change: a fresh Host root under the same name would reuse the old
 * volumes with new keys.
 */
export async function moveStackRoots(base: string, err: (line: string) => void): Promise<void> {
  const stacks = join(base, "stacks");
  let names: string[];
  try {
    names = (await readdir(stacks, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && TENANT_NAME.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return;
  }
  const moved: string[] = [];
  for (const name of names.sort()) {
    const root = tenantRoot(base, name);
    if (existsSync(root)) continue;
    await mkdir(tenantsDir(base), { recursive: true, mode: 0o700 });
    await rename(join(stacks, name), root);
    await rename(join(root, "stack.json"), tenantRecordPath(root)).catch(() => {});
    for (const file of [join(root, "docker", ".env"), join(root, "docker", "compose.yaml")]) {
      const text = await readFile(file, "utf8").catch(() => undefined);
      if (text?.includes("NYLORUN_STACK_NAME"))
        await writeFile(file, text.replaceAll("NYLORUN_STACK_NAME", "NYLORUN_TENANT_NAME"));
    }
    moved.push(name);
  }
  // A marker file of 0.4.
  await rm(join(stacks, ".legacy-noted"), { force: true });
  await rmdir(stacks).catch(() => {});
  if (moved.length) {
    const tilde = (path: string) =>
      path.startsWith(homedir() + sep) ? `~${path.slice(homedir().length)}` : path;
    err(`Moved Tenants ${moved.join(", ")} from ${tilde(stacks)} to ${tilde(tenantsDir(base))}.`);
  }
}
