import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import {
  AdminStatusSchema,
  ProjectLinkFileSchema,
  RejectedResponseSchema,
  type AdminStatus,
} from "@nylorun/core/contracts";
import {
  PROTOCOL_FEATURES,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  checkCompatibility,
  type ProtocolRange,
} from "@nylorun/core/compatibility";
import { deriveTenantKey } from "./derived-credentials.js";
import { AdminError } from "./errors.js";

export type AdminSource = "options" | "environment" | "local-host";

export interface ResolvedAdmin {
  /** The Host's Tenant API URL (what a Project link names). */
  url: string;
  /**
   * Where the Admin API answers when the Host serves it on its own operator listener
   * (`adminPort` in host.json). Defaults to `url`.
   */
  adminUrl?: string;
  key: string;
  source: AdminSource;
  /** The Host root read for local Host settings, when one was found. */
  home?: string;
}

export interface AdminConnectionOptions {
  url?: string;
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
 * The Tenant a Project link names (`.nylorun/link.json`, format 3), from `cwd` upwards, or the
 * path of a link from an older nylorun. The walk stops at the home directory, which holds the
 * Tenants and is never a Project.
 */
function linkedTenant(cwd: string): { tenant?: string; olderLink?: string } {
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
        return link.format < 3 ? { olderLink: path } : { tenant: link.tenant };
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
 * Tenant named by `options.tenant`, `NYLORUN_TENANT` or the Project link. No `home` when none
 * names one; `olderLink` when the Project link is from an older nylorun.
 */
function resolveHome(options?: AdminConnectionOptions): {
  home?: string;
  olderLink?: string;
} {
  if (options?.home !== undefined && options.home.trim() !== "")
    return { home: resolve(options.home) };
  const fromEnv = env("NYLORUN_HOME");
  if (fromEnv) return { home: resolve(fromEnv) };
  const named = options?.tenant?.trim() || env("NYLORUN_TENANT")?.trim();
  if (named) return { home: tenantHostRoot(named) };
  const linked = linkedTenant(options?.cwd ?? process.cwd());
  return linked.tenant
    ? { home: tenantHostRoot(linked.tenant) }
    : { olderLink: linked.olderLink };
}

function connectionMissing(message: string): never {
  throw new AdminError("connection_missing", message);
}

function sourcesTriedMessage(home: string | undefined): string {
  return (
    `Tried options (url + key), environment (NYLORUN_ADMIN_URL + NYLORUN_ADMIN_KEY), ` +
    (home
      ? `and local Host settings (host.json + host-credentials.json under ${home}).`
      : "and local Host settings (no Tenant named: pass `tenant`, set NYLORUN_TENANT or " +
        "NYLORUN_HOME, or run in a Project that `npx nylorun start` linked).")
  );
}

function assertCredentialsSafe(path: string): void {
  if (process.platform === "win32") return;
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return;
  }
  const uid =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && stats.uid !== uid) {
    connectionMissing(
      `host-credentials.json at ${path} is not owned by the current user. ${sourcesTriedMessage(resolve(join(path, "..")))}`,
    );
  }
  if ((stats.mode & 0o077) !== 0) {
    connectionMissing(
      `host-credentials.json at ${path} is group- or world-readable; fix permissions (chmod 600). ${sourcesTriedMessage(resolve(join(path, "..")))}`,
    );
  }
}

function readLocalHost(
  home: string,
): { url: string; adminUrl: string; key: string } | undefined {
  const configPath = join(home, "host.json");
  const credentialsPath = join(home, "host-credentials.json");
  let config: unknown;
  let credentials: unknown;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return undefined;
  }
  try {
    assertCredentialsSafe(credentialsPath);
    credentials = JSON.parse(readFileSync(credentialsPath, "utf8"));
  } catch (error) {
    if (error instanceof AdminError) throw error;
    return undefined;
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return undefined;
  }
  if (
    !credentials ||
    typeof credentials !== "object" ||
    Array.isArray(credentials)
  ) {
    return undefined;
  }
  const host = (config as { host?: unknown }).host;
  const port = (config as { port?: unknown }).port;
  const adminPort = (config as { adminPort?: unknown }).adminPort;
  const adminKey = (credentials as { adminKey?: unknown }).adminKey;
  if (typeof host !== "string" || typeof port !== "number") return undefined;
  if (typeof adminKey !== "string" || !/^[0-9a-f]{64}$/.test(adminKey)) {
    return undefined;
  }
  return {
    url: `http://${host}:${port}`,
    // An older Host serves the Admin API on its only port.
    adminUrl: `http://${host}:${typeof adminPort === "number" ? adminPort : port}`,
    key: adminKey,
  };
}

/**
 * Resolve Admin API connection once: options → environment → local Host.
 */
export function resolveAdminConnection(
  options?: AdminConnectionOptions,
): ResolvedAdmin {
  const { home, olderLink } = resolveHome(options);
  const optionUrl = options?.url?.trim() || undefined;
  const optionKey = options?.key?.trim() || undefined;
  if (optionUrl || optionKey) {
    if (!optionUrl || !optionKey) {
      connectionMissing(
        `Incomplete Admin API options: both url and key are required. ${sourcesTriedMessage(home)}`,
      );
    }
    return {
      url: optionUrl.replace(/\/$/, ""),
      key: optionKey,
      source: "options",
      ...(home ? { home } : {}),
    };
  }

  const envUrl = env("NYLORUN_ADMIN_URL");
  const envKey = env("NYLORUN_ADMIN_KEY");
  if (envUrl || envKey) {
    if (!envUrl || !envKey) {
      connectionMissing(
        `Incomplete Admin API environment: both NYLORUN_ADMIN_URL and NYLORUN_ADMIN_KEY are required. ${sourcesTriedMessage(home)}`,
      );
    }
    return {
      url: envUrl.replace(/\/$/, ""),
      key: envKey,
      source: "environment",
      ...(home ? { home } : {}),
    };
  }

  if (olderLink) {
    connectionMissing(
      `The Project link at ${olderLink} is from an older nylorun. Run "npx nylorun start" in this project to link it again.`,
    );
  }
  const local = home === undefined ? undefined : readLocalHost(home);
  if (local) {
    return {
      url: local.url.replace(/\/$/, ""),
      adminUrl: local.adminUrl.replace(/\/$/, ""),
      key: local.key,
      source: "local-host",
      home,
    };
  }

  connectionMissing(
    `Could not resolve Admin API connection. ${sourcesTriedMessage(home)}`,
  );
}

function parseProtocolRange(value: unknown): ProtocolRange | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.min !== "number" ||
    typeof record.max !== "number" ||
    !Array.isArray(record.features) ||
    !record.features.every((f) => typeof f === "string")
  ) {
    return undefined;
  }
  return {
    min: record.min,
    max: record.max,
    features: record.features as readonly string[],
  };
}

function throwFromResponse(status: number, body: unknown): never {
  const parsed = RejectedResponseSchema.safeParse(body);
  if (parsed.success) {
    throw new AdminError(parsed.data.code, parsed.data.message, {
      status,
      details: parsed.data.details,
    });
  }
  if (status === 404) {
    throw new AdminError("not_found", `Admin request not found (${status})`, {
      status,
      details: body,
    });
  }
  throw new AdminError("not_found", `Admin request failed (${status})`, {
    status,
    details: body,
  });
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export class AdminClient {
  /** The Host's Tenant API URL. */
  readonly url: string;
  /** Where Admin API requests go: the operator listener, or `url` on a single-port Host. */
  readonly adminUrl: string;
  readonly source: AdminSource;
  private readonly key: string;
  private compatible = false;

  constructor(resolved: ResolvedAdmin) {
    this.url = resolved.url;
    this.adminUrl = resolved.adminUrl ?? resolved.url;
    this.source = resolved.source;
    this.key = resolved.key;
  }

  private clearCompatibilityCache(): void {
    this.compatible = false;
  }

  private adminHeaders(init: RequestInit = {}): Headers {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.key}`);
    headers.set(PROTOCOL_HEADER, String(PROTOCOL_VERSION));
    headers.set("Accept", "application/json");
    if (init.body) headers.set("Content-Type", "application/json");
    return headers;
  }

  private async ensureCompatible(signal?: AbortSignal): Promise<void> {
    if (this.compatible) return;
    const response = await fetch(`${this.adminUrl}/health`, {
      method: "GET",
      redirect: "error",
      signal,
    });
    const body = await readBody(response);
    if (!response.ok) {
      throwFromResponse(response.status, body);
    }
    const protocol = parseProtocolRange(
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>).protocol
        : undefined,
    );
    if (!protocol) {
      throw new AdminError(
        "incompatible_host",
        "Host /health did not advertise a protocol range.",
      );
    }
    const result = checkCompatibility(
      { version: PROTOCOL_VERSION, required: [...PROTOCOL_FEATURES] },
      protocol,
    );
    if (!result.ok) {
      const detail =
        result.reason === "version"
          ? `client protocol ${result.client} is outside Host range ${result.host.min}–${result.host.max}`
          : `Host is missing required features: ${result.missing.join(", ")}`;
      throw new AdminError(
        "incompatible_host",
        `Incompatible Host: ${detail}`,
        { details: result },
      );
    }
    this.compatible = true;
  }

  private async request(
    path: string,
    init: RequestInit = {},
    options: { retried426?: boolean } = {},
  ): Promise<Response> {
    await this.ensureCompatible(
      init.signal === null ? undefined : init.signal,
    );
    const response = await fetch(this.adminUrl + path, {
      ...init,
      headers: this.adminHeaders(init),
      redirect: "error",
    });
    if (response.status === 426) {
      this.clearCompatibilityCache();
      if (!options.retried426) {
        await this.ensureCompatible(
          init.signal === null ? undefined : init.signal,
        );
        return this.request(path, init, { retried426: true });
      }
      const body = await readBody(response);
      const protocol = parseProtocolRange(
        body && typeof body === "object" && !Array.isArray(body)
          ? (body as Record<string, unknown>).protocol
          : undefined,
      );
      if (protocol) {
        const result = checkCompatibility(
          { version: PROTOCOL_VERSION, required: [...PROTOCOL_FEATURES] },
          protocol,
        );
        if (!result.ok) {
          throw new AdminError(
            "incompatible_host",
            "Incompatible Host after protocol upgrade challenge.",
            { status: 426, details: result },
          );
        }
      }
      throwFromResponse(426, body);
    }
    return response;
  }

  private async json<T>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    const response = await this.request(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 204) return undefined as T;
    const parsed = await readBody(response);
    if (!response.ok) throwFromResponse(response.status, parsed);
    return parsed as T;
  }

  async status(): Promise<AdminStatus> {
    const body = await this.json<unknown>("/v1/admin/status");
    return AdminStatusSchema.parse(body);
  }

  /**
   * The key of derived principal `principalId` on `tenantId`, from this client's admin key.
   * Valid when the Host registered that principal (`NYLORUN_DERIVED_PRINCIPALS`, default
   * `project`) on its Tenant.
   */
  deriveTenantKey(tenantId: string, principalId: string): string {
    return deriveTenantKey(this.key, tenantId, principalId);
  }
}
