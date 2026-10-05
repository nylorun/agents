import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { ProjectLinkFileSchema, RejectedResponseSchema } from "@nylorun/core/contracts";
import {
  PROTOCOL_FEATURES,
  PROTOCOL_VERSION,
  checkCompatibility,
  type ProtocolRange,
} from "@nylorun/core/compatibility";
import { AdminError } from "./errors.js";
import { ManagementClient } from "./management.js";

export type AdminSource = "options" | "environment" | "local-host";

export interface ResolvedAdmin {
  /** The Tenant's URL. */
  url: string;
  /** A management key. */
  key: string;
  source: AdminSource;
  /** The Host root read for local Host settings, when one was found. */
  home?: string;
}

export interface AdminConnectionOptions {
  url?: string;
  /** A management key. */
  key?: string;
  /** The Host root itself (overrides `NYLORUN_HOME` and the Tenant). */
  home?: string;
  /** The local Tenant whose Host root (`~/.nylorun/tenants/<tenant>/`) to read. */
  tenant?: string;
  /** Where to look for a Project link naming the Tenant; defaults to the working directory. */
  cwd?: string;
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value;
}

/** A local Tenant's Host root: `~/.nylorun/tenants/<name>/`. */
export function tenantHostRoot(name: string): string {
  return resolve(join(homedir(), ".nylorun", "tenants", name));
}

/**
 * The Project link (`.nylorun/link.json`, format 3) from `cwd` upwards: the Tenant it names
 * and the Project's `.nylorun/` directory, or the path of a link from an older nylorun. The
 * walk stops at the home directory, which holds the Tenants and is never a Project.
 */
function projectLink(cwd: string): { tenant?: string; directory?: string; olderLink?: string } {
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  const stop = real(homedir());
  let directory = real(resolve(cwd));
  const root = parse(directory).root;
  while (directory !== stop) {
    const path = join(directory, ".nylorun", "link.json");
    let raw: string | undefined;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      /* no link here */
    }
    if (raw !== undefined) {
      try {
        const link = ProjectLinkFileSchema.parse(JSON.parse(raw));
        if (link.format < 3) return { olderLink: path };
        return { ...(link.tenant ? { tenant: link.tenant } : {}), directory: dirname(path) };
      } catch {
        return {};
      }
    }
    if (directory === root) return {};
    directory = dirname(directory);
  }
  return {};
}

/**
 * The Host root of the local Host: `options.home`, `NYLORUN_HOME`, or the Host root of the
 * Tenant named by `options.tenant`, `NYLORUN_TENANT` or the Project link. `project` is the
 * linked Project's `.nylorun/` when the link names this Host root's Tenant.
 */
function resolveHome(options?: AdminConnectionOptions): {
  home?: string;
  project?: string;
  olderLink?: string;
} {
  const link = projectLink(options?.cwd ?? process.cwd());
  const linked = link.tenant ? tenantHostRoot(link.tenant) : undefined;
  const fromEnv = env("NYLORUN_HOME");
  const named = options?.tenant?.trim() || env("NYLORUN_TENANT")?.trim();
  const home =
    options?.home !== undefined && options.home.trim() !== ""
      ? resolve(options.home)
      : fromEnv
        ? resolve(fromEnv)
        : named
          ? tenantHostRoot(named)
          : linked;
  return {
    ...(home ? { home } : {}),
    ...(home && home === linked ? { project: link.directory } : {}),
    ...(link.olderLink ? { olderLink: link.olderLink } : {}),
  };
}

function connectionMissing(message: string): never {
  throw new AdminError("connection_missing", message);
}

function sourcesTriedMessage(home: string | undefined): string {
  return (
    "Tried options (url + key), environment (NYLORUN_RUNTIME_URL + NYLORUN_MANAGEMENT_KEY), " +
    (home
      ? `and the local Host (host.json under ${home}, with a managementKey in the linked ` +
        "Project's .nylorun/credentials.json, or the Host root's project-credentials.json or " +
        "cli-credentials.json: `npx nylorun start` writes them)."
      : "and the local Host (no Tenant named: pass `tenant`, set NYLORUN_TENANT or " +
        "NYLORUN_HOME, or run in a Project that `npx nylorun start` linked).")
  );
}

/** A credentials file must be the user's and not group- or world-readable (POSIX). */
function assertCredentialsSafe(path: string, home: string): void {
  if (process.platform === "win32") return;
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && stats.uid !== uid)
    connectionMissing(`${path} is not owned by the current user. ${sourcesTriedMessage(home)}`);
  if ((stats.mode & 0o077) !== 0)
    connectionMissing(
      `${path} is group- or world-readable; fix permissions (chmod 600). ${sourcesTriedMessage(home)}`,
    );
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The local Host's URL (`host.json`) and a management key: from the linked Project's
 * `.nylorun/credentials.json`, else the Host root's `project-credentials.json`, else its
 * `cli-credentials.json`.
 */
function readLocalHost(
  home: string,
  project: string | undefined,
): { url: string; key: string } | undefined {
  const config = readJson(join(home, "host.json"));
  if (typeof config?.host !== "string" || typeof config.port !== "number") return undefined;
  const files = [
    ...(project ? [join(project, "credentials.json")] : []),
    join(home, "project-credentials.json"),
    join(home, "cli-credentials.json"),
  ];
  for (const path of files) {
    const key = readJson(path)?.managementKey;
    if (typeof key !== "string" || !/^[0-9a-f]{64}$/.test(key)) continue;
    assertCredentialsSafe(path, home);
    return { url: `http://${config.host}:${config.port}`, key };
  }
  return undefined;
}

/** Resolve the Management API connection once: options → environment → local Host. */
export function resolveAdminConnection(options?: AdminConnectionOptions): ResolvedAdmin {
  const { home, project, olderLink } = resolveHome(options);
  const optionUrl = options?.url?.trim() || undefined;
  const optionKey = options?.key?.trim() || undefined;
  if (optionUrl || optionKey) {
    if (!optionUrl || !optionKey)
      connectionMissing(
        `Incomplete options: both url and key (a management key) are required. ${sourcesTriedMessage(home)}`,
      );
    return { url: optionUrl.replace(/\/$/, ""), key: optionKey, source: "options", ...(home ? { home } : {}) };
  }

  // NYLORUN_RUNTIME_URL alone is an app's (with NYLORUN_SERVER_KEY): only the key selects this.
  const envKey = env("NYLORUN_MANAGEMENT_KEY");
  if (envKey) {
    const envUrl = env("NYLORUN_RUNTIME_URL");
    if (!envUrl)
      connectionMissing(
        `Incomplete environment: NYLORUN_MANAGEMENT_KEY needs NYLORUN_RUNTIME_URL. ${sourcesTriedMessage(home)}`,
      );
    return { url: envUrl.replace(/\/$/, ""), key: envKey, source: "environment", ...(home ? { home } : {}) };
  }

  if (olderLink && !home)
    connectionMissing(
      `The Project link at ${olderLink} is from an older nylorun. Run "npx nylorun start" in this project to link it again.`,
    );
  const local = home === undefined ? undefined : readLocalHost(home, project);
  if (local) return { url: local.url, key: local.key, source: "local-host", home };

  connectionMissing(`Could not resolve the Management API connection. ${sourcesTriedMessage(home)}`);
}

function parseProtocolRange(value: unknown): ProtocolRange | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.min !== "number" ||
    typeof record.max !== "number" ||
    !Array.isArray(record.features) ||
    !record.features.every((f) => typeof f === "string")
  )
    return undefined;
  return { min: record.min, max: record.max, features: record.features as readonly string[] };
}

/** Throws unless the Host's `/health` advertises this client's protocol and features. */
async function checkHealth(url: string): Promise<void> {
  const response = await fetch(`${url}/health`, { redirect: "error" });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const rejected = RejectedResponseSchema.safeParse(body);
    throw rejected.success
      ? new AdminError(rejected.data.code, rejected.data.message, { status: response.status })
      : new AdminError("not_found", `Host /health failed (${response.status})`, {
          status: response.status,
          details: body,
        });
  }
  const protocol = parseProtocolRange((body as { protocol?: unknown } | undefined)?.protocol);
  if (!protocol)
    throw new AdminError("incompatible_host", "Host /health did not advertise a protocol range.");
  const result = checkCompatibility(
    { version: PROTOCOL_VERSION, required: [...PROTOCOL_FEATURES] },
    protocol,
  );
  if (!result.ok) {
    const detail =
      result.reason === "version"
        ? `client protocol ${result.client} is outside Host range ${result.host.min}–${result.host.max}`
        : `Host is missing required features: ${result.missing.join(", ")}`;
    throw new AdminError("incompatible_host", `Incompatible Host: ${detail}`, { details: result });
  }
}

/**
 * `fetch` that checks the Host's `/health` before the first request, and again after a `426`,
 * retrying the request once when the Host still serves this client.
 */
function compatibleFetch(url: string): typeof fetch {
  let checked: Promise<void> | undefined;
  const check = () =>
    (checked ??= checkHealth(url).catch((error: unknown) => {
      checked = undefined;
      throw error;
    }));
  return async (input, init) => {
    await check();
    const response = await fetch(input, init);
    if (response.status !== 426) return response;
    checked = undefined;
    await check();
    return fetch(input, init);
  };
}

/** What `createAdmin` returns: the Management API client, and where its connection came from. */
export class AdminClient extends ManagementClient {
  readonly source: AdminSource;

  constructor(resolved: ResolvedAdmin) {
    super({ url: resolved.url, key: resolved.key, fetch: compatibleFetch(resolved.url) });
    this.source = resolved.source;
  }
}
