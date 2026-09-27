/**
 * Stack configuration for the Runtime process, parsed from an environment
 * snapshot and argv. Pure: `host/main.ts` passes the process environment and
 * arguments; nothing here reads ambient state.
 *
 * Two listen modes:
 * - **local** (no `NYLORUN_LISTEN_*` / `NYLORUN_ALLOWED_HOSTS`): the Host binds
 *   what `host.json` names, loopback only unless `allowNonLoopback`.
 * - **container**: the Host binds `NYLORUN_LISTEN_HOST:NYLORUN_LISTEN_PORT`
 *   (default `0.0.0.0:4000`) and accepts only the `Host` headers in
 *   `NYLORUN_ALLOWED_HOSTS`, plus the loopback forms of the listen port for
 *   probes from inside the container.
 *
 * The Postgres, Restate and S2 endpoints are parsed and validated here;
 * `infra/*` builds the clients from them.
 */

export type RuntimeRole = "api" | "worker" | "all";

export const RUNTIME_ROLES: readonly RuntimeRole[] = ["api", "worker", "all"];

export const DEFAULT_CONTAINER_LISTEN_HOST = "0.0.0.0";
export const DEFAULT_CONTAINER_LISTEN_PORT = 4000;

export interface ContainerListen {
  /** Bind address, e.g. `0.0.0.0`. */
  host: string;
  port: number;
  /**
   * Exact `Host` header values accepted (lowercase `name:port`). Replaces the
   * loopback-only rule.
   */
  allowedHosts: readonly string[];
}

export interface StackEndpoints {
  databaseUrl?: string;
  restateIngressUrl?: string;
  restateAdminUrl?: string;
  workerUrl?: string;
  s2Endpoint?: string;
  s2Token?: string;
  workspaceStoreUrl?: string;
  /**
   * Restate request-identity public keys (`publickeyv1_...`) the Worker
   * endpoint accepts, from `NYLORUN_RESTATE_IDENTITY_KEY` (comma-separated
   * during a rotation). Unset means the endpoint accepts unsigned requests.
   */
  restateIdentityKeys?: string[];
}

export interface StackConfig {
  role: RuntimeRole;
  /** Present in container mode; absent means bind what host.json names. */
  listen?: ContainerListen;
  endpoints: StackEndpoints;
  /**
   * The URL clients use to reach this Host (`NYLORUN_PUBLIC_URL`), reported by
   * `/v1/admin/status`. In container mode the bind address (`0.0.0.0:4000`)
   * means nothing outside the container.
   */
  publicUrl?: string;
}

export class StackConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StackConfigError";
  }
}

type EnvSnapshot = Readonly<Record<string, string | undefined>>;

function read(env: EnvSnapshot, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function parseRole(argv: readonly string[]): RuntimeRole {
  let role: RuntimeRole | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    let value: string | undefined;
    if (arg === "--role") {
      value = argv[index + 1];
      index += 1;
      if (value === undefined || value.startsWith("-"))
        throw new StackConfigError("--role requires a value: api, worker or all");
    } else if (arg.startsWith("--role=")) {
      value = arg.slice("--role=".length);
    } else {
      throw new StackConfigError(
        `Unknown argument ${arg}. Usage: main.js [--role api|worker|all]`,
      );
    }
    if (role !== undefined)
      throw new StackConfigError("--role may only be supplied once");
    if (!(RUNTIME_ROLES as readonly string[]).includes(value))
      throw new StackConfigError(
        `Invalid --role ${value}; expected api, worker or all`,
      );
    role = value as RuntimeRole;
  }
  return role ?? "all";
}

function parsePort(name: string, raw: string): number {
  if (!/^\d+$/.test(raw))
    throw new StackConfigError(`${name} must be a port number; got ${raw}`);
  const port = Number(raw);
  if (port < 1 || port > 65535)
    throw new StackConfigError(`${name} must be between 1 and 65535; got ${raw}`);
  return port;
}

/**
 * Normalize one `Host` header allowlist entry to lowercase `name:port`.
 * IPv6 literals must be bracketed (`[::1]:4000`).
 */
export function normalizeAllowedHost(name: string, entry: string): string {
  const value = entry.trim().toLowerCase();
  const match = /^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9.-]*[a-z0-9])?):(\d+)$/.exec(
    value,
  );
  if (!match)
    throw new StackConfigError(
      `${name} entry "${entry}" must be host:port (IPv6 in brackets)`,
    );
  parsePort(name, match[3]!);
  return value;
}

function loopbackForms(port: number): string[] {
  return [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];
}

function isLoopbackAddress(host: string): boolean {
  const value = host.toLowerCase();
  return value === "127.0.0.1" || value === "::1" || value === "localhost";
}

function parseUrl(
  env: EnvSnapshot,
  name: string,
  protocols: readonly string[],
): string | undefined {
  const raw = read(env, name);
  if (raw === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new StackConfigError(`${name} is not a valid URL`);
  }
  if (!protocols.includes(url.protocol))
    throw new StackConfigError(
      `${name} must use ${protocols.map((p) => p.replace(/:$/, "")).join(" or ")}; got ${url.protocol.replace(/:$/, "")}`,
    );
  return raw;
}

function parseListen(env: EnvSnapshot): ContainerListen | undefined {
  const rawHost = read(env, "NYLORUN_LISTEN_HOST");
  const rawPort = read(env, "NYLORUN_LISTEN_PORT");
  const rawAllowed = read(env, "NYLORUN_ALLOWED_HOSTS");
  if (rawHost === undefined && rawPort === undefined && rawAllowed === undefined)
    return undefined;

  const host = rawHost ?? DEFAULT_CONTAINER_LISTEN_HOST;
  if (/\s|\//.test(host))
    throw new StackConfigError(`NYLORUN_LISTEN_HOST is not an address: ${host}`);
  const port =
    rawPort === undefined
      ? DEFAULT_CONTAINER_LISTEN_PORT
      : parsePort("NYLORUN_LISTEN_PORT", rawPort);

  const explicit =
    rawAllowed === undefined
      ? []
      : rawAllowed
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry !== "")
          .map((entry) => normalizeAllowedHost("NYLORUN_ALLOWED_HOSTS", entry));
  if (explicit.length === 0 && !isLoopbackAddress(host))
    throw new StackConfigError(
      `NYLORUN_ALLOWED_HOSTS is required when NYLORUN_LISTEN_HOST is ${host}: list the Host headers clients send, e.g. runtime:${port},localhost:<published port>`,
    );

  // Loopback forms of the listen port serve probes from inside the container
  // (health checks). A browser on the Docker host never sends them: it sends
  // the published port.
  const allowedHosts = [...new Set([...explicit, ...loopbackForms(port)])];
  return { host, port, allowedHosts };
}

const IDENTITY_KEY = /^publickeyv1_[1-9A-HJ-NP-Za-km-z]{32,64}$/;

function parseIdentityKeys(env: EnvSnapshot): string[] | undefined {
  const raw = read(env, "NYLORUN_RESTATE_IDENTITY_KEY");
  if (raw === undefined) return undefined;
  const keys = raw
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key !== "");
  for (const key of keys)
    if (!IDENTITY_KEY.test(key))
      throw new StackConfigError(
        "NYLORUN_RESTATE_IDENTITY_KEY must be publickeyv1_<base58 Ed25519 public key>, comma-separated",
      );
  return keys.length > 0 ? keys : undefined;
}

/** Parse the stack configuration; throws `StackConfigError` naming the variable. */
export function parseStackConfig(
  env: EnvSnapshot,
  argv: readonly string[],
): StackConfig {
  const role = parseRole(argv);
  const listen = parseListen(env);
  const http = ["http:", "https:"] as const;
  const endpoints: StackEndpoints = {};
  const databaseUrl = parseUrl(env, "NYLORUN_DATABASE_URL", [
    "postgres:",
    "postgresql:",
  ]);
  if (databaseUrl) endpoints.databaseUrl = databaseUrl;
  const restateIngressUrl = parseUrl(env, "NYLORUN_RESTATE_INGRESS_URL", http);
  if (restateIngressUrl) endpoints.restateIngressUrl = restateIngressUrl;
  const restateAdminUrl = parseUrl(env, "NYLORUN_RESTATE_ADMIN_URL", http);
  if (restateAdminUrl) endpoints.restateAdminUrl = restateAdminUrl;
  const workerUrl = parseUrl(env, "NYLORUN_WORKER_URL", http);
  if (workerUrl) endpoints.workerUrl = workerUrl;
  const s2Endpoint = parseUrl(env, "NYLORUN_S2_ENDPOINT", http);
  if (s2Endpoint) endpoints.s2Endpoint = s2Endpoint;
  const s2Token = read(env, "NYLORUN_S2_TOKEN");
  if (s2Token) endpoints.s2Token = s2Token;
  const workspaceStoreUrl = parseUrl(env, "NYLORUN_WORKSPACE_STORE_URL", [
    "file:",
    "s3:",
    "http:",
    "https:",
  ]);
  if (workspaceStoreUrl) endpoints.workspaceStoreUrl = workspaceStoreUrl;
  const restateIdentityKeys = parseIdentityKeys(env);
  if (restateIdentityKeys) endpoints.restateIdentityKeys = restateIdentityKeys;
  const publicUrl = parseUrl(env, "NYLORUN_PUBLIC_URL", http)?.replace(/\/+$/, "");
  return {
    role,
    ...(listen ? { listen } : {}),
    endpoints,
    ...(publicUrl ? { publicUrl } : {}),
  };
}

/** Endpoint summary for logs: which endpoints are set, never their values. */
export function describeEndpoints(endpoints: StackEndpoints): string[] {
  return Object.entries(endpoints)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key)
    .sort();
}
