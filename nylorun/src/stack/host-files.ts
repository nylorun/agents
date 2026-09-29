import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { newTenantId } from "@nylorun/core/compatibility";
import { CliError } from "../errors.js";
import type { StackPaths } from "./paths.js";

/**
 * host.json and host-credentials.json (format 1), which `@nylorun/admin`,
 * Studio and the Runtime container all read.
 *
 * For the stack, host.json names the client-facing address: `localhost` and
 * the published port. The container binds 0.0.0.0:4000 on its own.
 */

/** Host name clients use for the stack. Studio's cookie is set on this name too. */
export const STACK_CLIENT_HOST = "localhost";

const KNOWN_FORMAT = 1;
const ADMIN_KEY_PATTERN = /^[0-9a-f]{64}$/;

export interface HostConfigFile {
  format: 1;
  hostId: string;
  host: string;
  port: number;
  /** The operator listener's published port (the Admin API); absent on older stacks. */
  adminPort?: number;
  runtimeVersion?: string;
  [field: string]: unknown;
}

export function newHostId(): string {
  return `host_${newTenantId().slice(3)}`;
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

/** The Host root layout, mode 0700. */
export async function ensureHostLayout(paths: StackPaths): Promise<void> {
  for (const dir of [paths.root, paths.home, paths.tmp, paths.tenants, paths.stack])
    await mkdir(dir, { recursive: true, mode: 0o700 });
}

export async function readHostConfig(
  paths: StackPaths,
): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(paths.config, "utf8");
  } catch {
    return undefined;
  }
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write host.json with the published port. Keeps the hostId and unknown fields
 * of an existing file; refuses a newer format.
 */
export async function writeStackHostConfig(
  paths: StackPaths,
  input: { port: number; adminPort?: number; runtimeVersion: string },
): Promise<HostConfigFile> {
  const existing = (await readHostConfig(paths)) ?? {};
  const format = existing.format;
  if (
    format !== undefined &&
    (typeof format !== "number" || !Number.isInteger(format) || format > KNOWN_FORMAT)
  )
    throw new CliError(
      `host.json format ${String(format)} at ${paths.config} is newer than this CLI supports (${KNOWN_FORMAT}). Upgrade nylorun.`,
      1,
    );
  const hostId =
    typeof existing.hostId === "string" && /^host_[0-9a-hjkmnp-tv-z]{26}$/.test(existing.hostId)
      ? existing.hostId
      : newHostId();
  const config: HostConfigFile = {
    ...existing,
    format: 1,
    hostId,
    host: STACK_CLIENT_HOST,
    port: input.port,
    ...(input.adminPort === undefined ? {} : { adminPort: input.adminPort }),
    runtimeVersion: input.runtimeVersion,
  };
  await writeAtomic(paths.config, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

export async function readAdminKey(paths: StackPaths): Promise<string | undefined> {
  try {
    const value = JSON.parse(await readFile(paths.credentials, "utf8")) as {
      adminKey?: unknown;
    };
    return typeof value?.adminKey === "string" && ADMIN_KEY_PATTERN.test(value.adminKey)
      ? value.adminKey
      : undefined;
  } catch {
    return undefined;
  }
}

/** Create host-credentials.json (mode 0600) if missing; always leave it 0600. */
export async function ensureHostCredentials(
  paths: StackPaths,
): Promise<{ adminKey: string; created: boolean }> {
  const existing = await readAdminKey(paths);
  if (existing) {
    await chmod(paths.credentials, 0o600);
    return { adminKey: existing, created: false };
  }
  const adminKey = randomBytes(32).toString("hex");
  await writeAtomic(paths.credentials, `${JSON.stringify({ adminKey })}\n`);
  return { adminKey, created: true };
}
