/**
 * Stack configuration for the Runtime process, parsed from an environment
 * snapshot and argv. Pure: `host/main.ts` passes the process environment and
 * arguments; nothing here reads ambient state.
 *
 * `--service core,loop` names the Runtime services the process runs (blueprint
 * §19, D12): one image runs every service, and a container may pack several.
 * Without the flag a process runs core and loop. `--role api|worker|all` is
 * the deprecated name of the same choice (core, loop, or both). `gates` (the
 * Model Gate) never shares a process with core or loop: it holds the
 * credentials they must not. Only a process that runs core or loop parses the
 * API listener (`NYLORUN_LISTEN_*`); only one that runs gates parses its
 * listener (`NYLORUN_GATES_LISTEN_*`), and only one that runs loop parses
 * where to reach the gate (`NYLORUN_GATES_URL`). Both read
 * `NYLORUN_GATES_TOKEN`.
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

/** A Runtime service this release has. */
export type RuntimeService = "core" | "loop" | "gates";

export type RuntimeServices = ReadonlySet<RuntimeService>;

export const RUNTIME_SERVICES: readonly RuntimeService[] = ["core", "loop", "gates"];

/**
 * Services that may share a process (D12): they hold the same secrets and parse the same
 * trust class of input. Egress and keys join gates in later releases.
 */
const SERVICE_GROUPS: readonly (readonly RuntimeService[])[] = [
  ["core", "loop"],
  ["gates"],
];

/** Where the gates service listens by default. */
export const DEFAULT_GATES_LISTEN_PORT = 4100;

/** What a process runs without `--service`: core and loop, as `--role all` did. */
export const DEFAULT_SERVICES: RuntimeServices = new Set<RuntimeService>([
  "core",
  "loop",
]);

/** Services of the blueprint this release doesn't have yet. */
const LATER_SERVICES: readonly string[] = [
  "egress",
  "keys",
  "harness",
  "sandboxd",
];

/** The deprecated `--role` values, and the services each stands for. */
export type RuntimeRole = "api" | "worker" | "all";

const ROLE_SERVICES: Readonly<Record<RuntimeRole, readonly RuntimeService[]>> = {
  api: ["core"],
  worker: ["loop"],
  all: ["core", "loop"],
};

/** `services` as the `--service` value that selects them, e.g. `core,loop`. */
export function describeServices(services: RuntimeServices): string {
  return RUNTIME_SERVICES.filter((service) => services.has(service)).join(",");
}

export interface ServiceSelection {
  services: RuntimeServices;
  /** Set when the process was started with the deprecated `--role`. */
  deprecatedRole?: RuntimeRole;
}

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

/** The gates service's listener and the token callers must present (`NYLORUN_GATES_*`). */
export interface GatesConfig {
  listen: ContainerListen;
  /** `NYLORUN_GATES_TOKEN`: the bearer the loop presents; at least 32 bytes as hex. */
  token: string;
}

/** Where the loop reaches the gates service (`NYLORUN_GATES_URL`, `NYLORUN_GATES_TOKEN`). */
export interface ModelGateEndpoint {
  url: string;
  token: string;
}

export interface StackConfig {
  /** The Runtime services this process runs. */
  services: RuntimeServices;
  /** Present when the process runs gates. */
  gates?: GatesConfig;
  /**
   * Present when the process runs loop and `NYLORUN_GATES_URL` is set: its model calls cross
   * the gates service. Absent, the loop calls the model in its own process.
   */
  modelGate?: ModelGateEndpoint;
  /** Set when the process was started with the deprecated `--role` (logged at startup). */
  deprecatedRole?: RuntimeRole;
  /** Present in container mode; absent means bind what host.json names. */
  listen?: ContainerListen;
  endpoints: StackEndpoints;
  /**
   * The URL clients use to reach this Host (`NYLORUN_PUBLIC_URL`), reported by
   * `/v1/admin/status`. In container mode the bind address (`0.0.0.0:4000`)
   * means nothing outside the container.
   */
  publicUrl?: string;
  /**
   * `NYLORUN_BROWSER_ACCESS` (`on` or `off`): whether browser requests may reach Tenant
   * routes. Absent means the Host's default (on in container mode).
   */
  browserAccess?: boolean;
  /**
   * The operator listener in container mode (`NYLORUN_ADMIN_LISTEN_PORT`, `…_HOST`,
   * `…_ALLOWED_HOSTS`). Absent: one listener serves the Admin API and the Tenant API.
   */
  operator?: ContainerListen;
  /**
   * How the Runtime may call Action endpoints: `NYLORUN_ENDPOINT_LOOPBACK=docker-host` (the local
   * stack: `localhost` means the machine that runs Docker), `NYLORUN_ENDPOINT_PRIVATE`
   * (`allow` or `refuse`) and `NYLORUN_ENDPOINT_HTTP` (`allow` or `refuse`).
   */
  delivery?: {
    loopback?: "docker-host";
    privateAddresses?: "allow" | "refuse";
    allowHttp?: boolean;
  };
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

const USAGE = "Usage: main.js [--service core,loop|gates]";

/** Parses `--service a,b` (or the deprecated `--role`); throws `StackConfigError`. */
export function parseServices(argv: readonly string[]): ServiceSelection {
  let service: string | undefined;
  let role: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const flag = arg.startsWith("--service")
      ? "--service"
      : arg.startsWith("--role")
        ? "--role"
        : undefined;
    let value: string | undefined;
    if (flag && arg === flag) {
      value = argv[index + 1];
      index += 1;
      if (value === undefined || value.startsWith("-"))
        throw new StackConfigError(
          flag === "--service"
            ? "--service requires a value, e.g. core,loop"
            : "--role requires a value: api, worker or all",
        );
    } else if (flag && arg.startsWith(`${flag}=`)) {
      value = arg.slice(flag.length + 1);
    } else {
      throw new StackConfigError(`Unknown argument ${arg}. ${USAGE}`);
    }
    if ((flag === "--service" ? service : role) !== undefined)
      throw new StackConfigError(`${flag} may only be supplied once`);
    if (flag === "--service") service = value;
    else role = value;
  }
  if (service !== undefined && role !== undefined)
    throw new StackConfigError(
      "--role is the deprecated name of --service; supply only --service",
    );
  if (role !== undefined) {
    if (!Object.hasOwn(ROLE_SERVICES, role))
      throw new StackConfigError(
        `Invalid --role ${role}; expected api, worker or all (deprecated: use --service core, loop or core,loop)`,
      );
    const deprecatedRole = role as RuntimeRole;
    return { services: new Set(ROLE_SERVICES[deprecatedRole]), deprecatedRole };
  }
  if (service === undefined) return { services: DEFAULT_SERVICES };
  const names = service.split(",").map((name) => name.trim());
  const services = new Set<RuntimeService>();
  for (const name of names) {
    if (name === "")
      throw new StackConfigError(`--service ${service} has an empty entry. ${USAGE}`);
    if (name === "all")
      throw new StackConfigError("--service all is not a service; use --service core,loop");
    if (LATER_SERVICES.includes(name))
      throw new StackConfigError(`The ${name} service is not in this release of the Runtime`);
    if (!(RUNTIME_SERVICES as readonly string[]).includes(name))
      throw new StackConfigError(
        `Unknown service ${name}; expected ${RUNTIME_SERVICES.join(" or ")}`,
      );
    if (services.has(name as RuntimeService))
      throw new StackConfigError(`--service names ${name} twice`);
    services.add(name as RuntimeService);
  }
  const groups = SERVICE_GROUPS.filter((group) => group.some((name) => services.has(name)));
  if (groups.length > 1)
    throw new StackConfigError(
      `--service ${service}: ${groups.map((group) => group.join(" and ")).join(" may not share a process with ")}; run them as separate processes`,
    );
  return { services };
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

function parseAdminListen(env: EnvSnapshot): ContainerListen | undefined {
  const rawPort = read(env, "NYLORUN_ADMIN_LISTEN_PORT");
  const rawHost = read(env, "NYLORUN_ADMIN_LISTEN_HOST");
  const rawAllowed = read(env, "NYLORUN_ADMIN_ALLOWED_HOSTS");
  if (rawPort === undefined) {
    if (rawHost !== undefined || rawAllowed !== undefined)
      throw new StackConfigError(
        "NYLORUN_ADMIN_LISTEN_PORT is required with NYLORUN_ADMIN_LISTEN_HOST or NYLORUN_ADMIN_ALLOWED_HOSTS",
      );
    return undefined;
  }
  const host = rawHost ?? DEFAULT_CONTAINER_LISTEN_HOST;
  if (/\s|\//.test(host))
    throw new StackConfigError(`NYLORUN_ADMIN_LISTEN_HOST is not an address: ${host}`);
  const port = parsePort("NYLORUN_ADMIN_LISTEN_PORT", rawPort);
  const explicit =
    rawAllowed === undefined
      ? []
      : rawAllowed
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry !== "")
          .map((entry) => normalizeAllowedHost("NYLORUN_ADMIN_ALLOWED_HOSTS", entry));
  if (explicit.length === 0 && !isLoopbackAddress(host))
    throw new StackConfigError(
      `NYLORUN_ADMIN_ALLOWED_HOSTS is required when NYLORUN_ADMIN_LISTEN_HOST is ${host}: list the Host headers operators send, e.g. runtime:${port},localhost:<published port>`,
    );
  return { host, port, allowedHosts: [...new Set([...explicit, ...loopbackForms(port)])] };
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
  const { services, deprecatedRole } = parseServices(argv);
  // The image sets NYLORUN_LISTEN_*: only the API's processes read them.
  const servesApi = services.has("core") || services.has("loop");
  const listen = servesApi ? parseListen(env) : undefined;
  const operator = servesApi ? parseAdminListen(env) : undefined;
  const gates = services.has("gates") ? parseGates(env) : undefined;
  const modelGate = services.has("loop") ? parseModelGate(env) : undefined;
  if (operator && listen && operator.port === listen.port)
    throw new StackConfigError(
      "NYLORUN_ADMIN_LISTEN_PORT must differ from NYLORUN_LISTEN_PORT",
    );
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
  const rawBrowser = read(env, "NYLORUN_BROWSER_ACCESS");
  if (rawBrowser !== undefined && rawBrowser !== "on" && rawBrowser !== "off")
    throw new StackConfigError(
      `NYLORUN_BROWSER_ACCESS must be on or off, not ${rawBrowser}`,
    );
  const delivery = parseDelivery(env);
  return {
    services,
    ...(deprecatedRole ? { deprecatedRole } : {}),
    ...(gates ? { gates } : {}),
    ...(modelGate ? { modelGate } : {}),
    ...(listen ? { listen } : {}),
    endpoints,
    ...(publicUrl ? { publicUrl } : {}),
    ...(rawBrowser === undefined ? {} : { browserAccess: rawBrowser === "on" }),
    ...(operator ? { operator } : {}),
    ...(delivery ? { delivery } : {}),
  };
}

const GATES_TOKEN = /^[0-9a-f]{64,}$/i;

/** `StackConfig.gates` from `NYLORUN_GATES_*`. */
function parseGates(env: EnvSnapshot): GatesConfig {
  const host = read(env, "NYLORUN_GATES_LISTEN_HOST") ?? DEFAULT_CONTAINER_LISTEN_HOST;
  if (/\s|\//.test(host))
    throw new StackConfigError(`NYLORUN_GATES_LISTEN_HOST is not an address: ${host}`);
  const rawPort = read(env, "NYLORUN_GATES_LISTEN_PORT");
  const port =
    rawPort === undefined
      ? DEFAULT_GATES_LISTEN_PORT
      : parsePort("NYLORUN_GATES_LISTEN_PORT", rawPort);
  const rawAllowed = read(env, "NYLORUN_GATES_ALLOWED_HOSTS");
  const explicit =
    rawAllowed === undefined
      ? []
      : rawAllowed
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry !== "")
          .map((entry) => normalizeAllowedHost("NYLORUN_GATES_ALLOWED_HOSTS", entry));
  if (explicit.length === 0 && !isLoopbackAddress(host))
    throw new StackConfigError(
      `NYLORUN_GATES_ALLOWED_HOSTS is required when NYLORUN_GATES_LISTEN_HOST is ${host}: list the Host headers the loop sends, e.g. gateway:${port}`,
    );
  const token = read(env, "NYLORUN_GATES_TOKEN");
  if (token === undefined)
    throw new StackConfigError(
      "NYLORUN_GATES_TOKEN is required for --service gates: the token the loop presents (`nylorun start` sets it)",
    );
  if (!GATES_TOKEN.test(token))
    throw new StackConfigError("NYLORUN_GATES_TOKEN must be at least 32 bytes as hex");
  return {
    listen: { host, port, allowedHosts: [...new Set([...explicit, ...loopbackForms(port)])] },
    token,
  };
}

/** `StackConfig.modelGate` from `NYLORUN_GATES_URL` and `NYLORUN_GATES_TOKEN`. */
function parseModelGate(env: EnvSnapshot): ModelGateEndpoint | undefined {
  const url = parseUrl(env, "NYLORUN_GATES_URL", ["http:", "https:"]);
  const token = read(env, "NYLORUN_GATES_TOKEN");
  if (url === undefined) {
    if (token !== undefined)
      throw new StackConfigError(
        "NYLORUN_GATES_TOKEN is set without NYLORUN_GATES_URL: set the URL of the gates service, e.g. http://gateway:4100",
      );
    return undefined;
  }
  if (token === undefined)
    throw new StackConfigError(
      "NYLORUN_GATES_TOKEN is required with NYLORUN_GATES_URL: the gates service refuses calls without it",
    );
  if (!GATES_TOKEN.test(token))
    throw new StackConfigError("NYLORUN_GATES_TOKEN must be at least 32 bytes as hex");
  return { url: url.replace(/\/+$/, ""), token };
}

/** `StackConfig.delivery` from `NYLORUN_ENDPOINT_*`, or `undefined` when none is set. */
function parseDelivery(env: Readonly<Record<string, string | undefined>>): StackConfig["delivery"] {
  const loopback = read(env, "NYLORUN_ENDPOINT_LOOPBACK");
  if (loopback !== undefined && loopback !== "docker-host")
    throw new StackConfigError(`NYLORUN_ENDPOINT_LOOPBACK must be docker-host, not ${loopback}`);
  const choice = (name: string) => {
    const value = read(env, name);
    if (value !== undefined && value !== "allow" && value !== "refuse")
      throw new StackConfigError(`${name} must be allow or refuse, not ${value}`);
    return value as "allow" | "refuse" | undefined;
  };
  const privateAddresses = choice("NYLORUN_ENDPOINT_PRIVATE");
  const http = choice("NYLORUN_ENDPOINT_HTTP");
  if (!loopback && !privateAddresses && !http) return undefined;
  return {
    ...(loopback ? { loopback } : {}),
    ...(privateAddresses ? { privateAddresses } : {}),
    ...(http ? { allowHttp: http === "allow" } : {}),
  };
}

/** Endpoint summary for logs: which endpoints are set, never their values. */
export function describeEndpoints(endpoints: StackEndpoints): string[] {
  return Object.entries(endpoints)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key)
    .sort();
}
