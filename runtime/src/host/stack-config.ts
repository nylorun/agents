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
 * `NYLORUN_GATES_TOKEN`. In a container, loop requires the gate: the loop
 * process must never hold a model credential. `egress` (egress-gate, F7.2) joins gates and keys
 * in the gateway and parses its listener (`NYLORUN_EGRESS_LISTEN_*`, default `0.0.0.0:4200`).
 * Only gates reads the operator's credential resolver (`NYLORUN_RESOLVER_URL`,
 * `NYLORUN_RESOLVER_TOKEN`, F9 C1): remote MCP calls are authorized in the gateway.
 *
 * `harness` (F6.2) runs alone: it holds the harness credential and nothing else. It connects to
 * core's Harness API listener (`NYLORUN_HARNESS_URL`, `NYLORUN_HARNESS_TOKEN`), calls models and
 * remote MCP servers through the gates service (`NYLORUN_GATES_URL`, with run tokens only), and
 * keeps its workspaces under `NYLORUN_HARNESS_ROOT`. It refuses to start with a database, the
 * gates' or keys' credential, or Restate settings. A process running core starts the Harness API
 * listener when `NYLORUN_HARNESS=remote` (`NYLORUN_HARNESS_LISTEN_*`, `NYLORUN_HARNESS_TOKEN`).
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
 * `infra/*` builds the clients from them. So is the Object store (`NYLORUN_OBJECT_STORE_*`),
 * which every service may read; `host/main.ts` builds the `BlobStore` from it. So is who the Host's Tenant is when its database
 * holds none yet (`NYLORUN_TENANT_ID`, `NYLORUN_TENANT_NAME`).
 */
import { isTenantId } from "@nylorun/core/compatibility";
import { blockedAddresses, type BlockedAddress } from "../sandbox/pods/network-gate.js";

/** A Runtime service this release has. */
export type RuntimeService = "core" | "loop" | "gates" | "keys" | "egress" | "harness";

export type RuntimeServices = ReadonlySet<RuntimeService>;

export const RUNTIME_SERVICES: readonly RuntimeService[] = ["core", "loop", "gates", "keys", "egress", "harness"];

/**
 * Services that may share a process (D12): they hold the same secrets and parse the same
 * trust class of input. keys joins gates (F4.2), and egress joins them (F7.2). The harness
 * (F6.2) runs agent code's neighbours and holds only its own credential: it shares with nothing.
 */
const SERVICE_GROUPS: readonly (readonly RuntimeService[])[] = [
  ["core", "loop"],
  ["gates", "keys", "egress"],
  ["harness"],
];

/** Where the gates service listens by default. */
export const DEFAULT_GATES_LISTEN_PORT = 4100;

/** Where egress-gate listens by default. */
export const DEFAULT_EGRESS_LISTEN_PORT = 4200;

/** Where core's Harness API listener listens by default. */
export const DEFAULT_HARNESS_LISTEN_PORT = 4200;

/** Where a harness process answers `/health` (loopback only). */
export const DEFAULT_HARNESS_HEALTH_PORT = 4300;

/** What a process runs without `--service`: core and loop, as `--role all` did. */
export const DEFAULT_SERVICES: RuntimeServices = new Set<RuntimeService>([
  "core",
  "loop",
]);

/** Services of the blueprint this release doesn't have yet. */
const LATER_SERVICES: readonly string[] = [
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
  /**
   * The operator's credential resolver (`NYLORUN_RESOLVER_URL`, `NYLORUN_RESOLVER_TOKEN`), asked
   * for a person's MCP credential when the session's vaults hold none (F9 C1). Absent: vaults only.
   */
  resolver?: { url: string; token: string };
}

/** egress-gate's listener (`NYLORUN_EGRESS_LISTEN_HOST`, `NYLORUN_EGRESS_LISTEN_PORT`). */
export interface EgressConfig {
  listen: { host: string; port: number };
}

/** Where the loop reaches the gates service (`NYLORUN_GATES_URL`, `NYLORUN_GATES_TOKEN`). */
export interface ModelGateEndpoint {
  url: string;
  token: string;
}

/**
 * Core's Harness API listener (`NYLORUN_HARNESS=remote`, or sandbox pods): where harnesses
 * connect, and the credential they present (`NYLORUN_HARNESS_TOKEN`), which nothing else
 * accepts. With sandbox pods and no harness container there is no token: only pods' host tokens
 * are accepted (F7.2).
 */
export interface HarnessListenConfig {
  listen: ContainerListen;
  token?: string;
}

/**
 * Sandbox pods (`NYLORUN_SANDBOXES_URL`, F7.2): the sandboxes service core drives them with, its
 * token, and the Runtime image pods copy the engine from.
 */
export interface SandboxesConfig {
  url: string;
  token: string;
  /** `NYLORUN_SANDBOX_HARNESS_IMAGE` (the stack sets it to the Runtime image). */
  harnessImage: string;
}

/**
 * The engine in a pod sandbox (`--service harness` with `NYLORUN_SANDBOX_KIND=pod`, F7.2): no
 * harness token; it joins with the join token mounted in the pod.
 */
export interface PodHostConfig {
  /** `NYLORUN_SANDBOX_ID`. */
  sandboxId: string;
  /** `NYLORUN_POD_UID` (the downward API's `metadata.uid`). */
  podUid: string;
  /** `NYLORUN_SANDBOX_JOIN_FILE`. */
  joinFile: string;
  /** The Harness API listener's HTTP base, for `host/join` and `host/renew`. */
  httpUrl: string;
  /** `NYLORUN_EGRESS_PROXY`: egress-gate's address, or undefined while it is not published. */
  egressProxy?: string;
  /** Addresses the pod's NetworkPolicy must block, probed before the engine starts. */
  blocked: BlockedAddress[];
}

/** A harness process (`--service harness`). */
export interface HarnessServiceConfig {
  /** `NYLORUN_HARNESS_URL`: core's Harness API, e.g. `ws://runtime:4200/nylorun/harness/v1`. */
  url: string;
  /** `NYLORUN_HARNESS_TOKEN`; absent for a pod's engine, which joins (`pod`). */
  token?: string;
  /** Present for the engine in a pod sandbox. */
  pod?: PodHostConfig;
  /** `NYLORUN_GATES_URL`: the gates service its model and MCP calls cross, with run tokens. */
  gatesUrl: string;
  /** `NYLORUN_HARNESS_ROOT`: its sandboxes. Default `/harness`. */
  root: string;
  /** `/health` on `127.0.0.1:<NYLORUN_HARNESS_HEALTH_PORT>` (default 4300). */
  healthPort: number;
}

export interface StackConfig {
  /** The Runtime services this process runs. */
  services: RuntimeServices;
  /** Present when the process runs gates. */
  gates?: GatesConfig;
  /** Present when the process runs egress. */
  egress?: EgressConfig;
  /** Present when the process runs the harness service (`--service harness`). */
  harness?: HarnessServiceConfig;
  /**
   * `NYLORUN_HARNESS` (`in-process` or `remote`; absent means `in-process`), for a process running
   * core or loop: whether the Tenant runs its own harness, or harnesses connect to
   * `harnessListener`.
   */
  harnessMode?: "in-process" | "remote";
  /** Present when `harnessMode` is `remote`, or with `sandboxes`: core's Harness API listener. */
  harnessListener?: HarnessListenConfig;
  /** Present when the process runs core or loop and `NYLORUN_SANDBOXES_URL` is set (F7.2). */
  sandboxes?: SandboxesConfig;
  /**
   * Present when the process runs core or loop and `NYLORUN_GATES_URL` is set: its model calls,
   * remote MCP calls and Action deliveries cross the gates service. Required for loop in
   * container mode; outside a container (a development Host, tests) the loop may make them in
   * its own process.
   */
  modelGate?: ModelGateEndpoint;
  /**
   * Present when the process runs core or loop and `NYLORUN_KEYS_URL`, or else
   * `NYLORUN_GATES_URL`, is set (F4.2): its vault writes and token signing cross the gateway's
   * keys service, with `NYLORUN_GATES_TOKEN`, and it never reads the vault key. A loop in a
   * container always has it, since it requires `NYLORUN_GATES_URL`.
   */
  keys?: ModelGateEndpoint;
  /**
   * How the stack packs services into containers (`NYLORUN_PACKING`), for the startup log:
   * `combined` (the local stack: runtime and gateway) or `split` (one container per service).
   */
  packing?: "combined" | "split";
  /** Set when the process was started with the deprecated `--role` (logged at startup). */
  deprecatedRole?: RuntimeRole;
  /** Present in container mode; absent means bind what host.json names. */
  listen?: ContainerListen;
  endpoints: StackEndpoints;
  /**
   * The URL clients use to reach this Host (`NYLORUN_PUBLIC_URL`). In container mode the bind
   * address (`0.0.0.0:4000`) means nothing outside the container.
   */
  publicUrl?: string;
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
  /** Present when the process runs core or loop: who its Tenant is on first start. */
  tenant?: TenantSettings;
  /**
   * The Object store (blueprint D35) behind the `BlobStore` seam's `s3` adapter, from
   * `NYLORUN_OBJECT_STORE_*`; the local stack's RustFS. Absent: the Tenant keeps blobs on disk
   * (the `fs` adapter, `TenantPaths.blobs`).
   */
  objectStore?: ObjectStoreConfig;
}

/** Where the Object store is and the credential for it (`NYLORUN_OBJECT_STORE_*`). */
export interface ObjectStoreConfig {
  /** `NYLORUN_OBJECT_STORE_ENDPOINT`: the S3 endpoint, e.g. `http://rustfs:9000`. */
  endpoint: string;
  /** `NYLORUN_OBJECT_STORE_BUCKET`. Default `nylorun`. */
  bucket: string;
  /** `NYLORUN_OBJECT_STORE_REGION`. Default `us-east-1`. */
  region: string;
  /** `NYLORUN_OBJECT_STORE_ACCESS_KEY`. */
  accessKeyId: string;
  /** `NYLORUN_OBJECT_STORE_SECRET_KEY`. */
  secretAccessKey: string;
}

/**
 * The Tenant a Host creates when its database holds none (tenancy.md §4). Later starts open the
 * Tenant the database holds; only principals missing from it are added.
 */
export interface TenantSettings {
  /** `NYLORUN_TENANT_ID`: the new Tenant's id. Default: a new id. */
  id?: string;
  /** `NYLORUN_TENANT_NAME`. Default `default`. */
  name: string;
  /**
   * `NYLORUN_IDENTITY_FILE`: the identity file listing the trusted issuers (Host feature
   * `trusted-issuers`), read once at boot (`host/main.ts`). Absent: no issuer is trusted.
   */
  identityFile?: string;
  /**
   * `NYLORUN_MANAGEMENT_KEY_FILE`: a file holding a management key (64 hex characters), which
   * the Host registers as the principal `bootstrap` at every start, replacing its key when the
   * file changed (protocol 8). For installations where no one can run `nylorun-operate`.
   */
  managementKeyFile?: string;
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

const USAGE = "Usage: main.js [--service core,loop|gates,keys,egress|harness]";

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
  if (services.has("harness")) return { services, harness: parseHarnessService(env), endpoints: {} };
  // The image sets NYLORUN_LISTEN_*: only the API's processes read them.
  const servesApi = services.has("core") || services.has("loop");
  const listen = servesApi ? parseListen(env) : undefined;
  const gates = services.has("gates") || services.has("keys") ? parseGates(env) : undefined;
  const egress = services.has("egress") ? parseEgress(env) : undefined;
  // The gates service's clients: the loop's model and tool calls, and core's endpoint pings.
  const modelGate = servesApi ? parseModelGate(env) : undefined;
  // The keys service is the gateway's unless NYLORUN_KEYS_URL names another listener.
  const keys = servesApi ? (parseKeysEndpoint(env) ?? modelGate) : undefined;
  if (services.has("loop") && listen && !modelGate)
    throw new StackConfigError(
      "NYLORUN_GATES_URL is required for the loop service in a container: model calls go through the gates service (the gateway container), so the loop never holds a model credential. Set NYLORUN_GATES_URL and NYLORUN_GATES_TOKEN (`nylorun start` sets both)",
    );
  const rawPacking = read(env, "NYLORUN_PACKING");
  if (rawPacking !== undefined && rawPacking !== "combined" && rawPacking !== "split")
    throw new StackConfigError(`NYLORUN_PACKING must be combined or split, not ${rawPacking}`);
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
  const harnessMode = servesApi ? parseHarnessMode(env) : undefined;
  const sandboxes = servesApi ? parseSandboxes(env) : undefined;
  // Pods connect to the Harness API listener even when the Tenant runs its own harness.
  const harnessListener =
    harnessMode === "remote" || sandboxes
      ? parseHarnessListener(env, harnessMode === "remote")
      : undefined;
  if (harnessListener && listen?.port === harnessListener.listen.port)
    throw new StackConfigError("NYLORUN_HARNESS_LISTEN_PORT must differ from NYLORUN_LISTEN_PORT");
  const delivery = parseDelivery(env);
  const tenant = servesApi ? parseTenant(env) : undefined;
  const objectStore = parseObjectStore(env);
  return {
    services,
    ...(deprecatedRole ? { deprecatedRole } : {}),
    ...(gates ? { gates } : {}),
    ...(egress ? { egress } : {}),
    ...(modelGate ? { modelGate } : {}),
    ...(keys ? { keys } : {}),
    ...(rawPacking ? { packing: rawPacking } : {}),
    ...(listen ? { listen } : {}),
    endpoints,
    ...(publicUrl ? { publicUrl } : {}),
    ...(harnessMode ? { harnessMode } : {}),
    ...(harnessListener ? { harnessListener } : {}),
    ...(sandboxes ? { sandboxes } : {}),
    ...(delivery ? { delivery } : {}),
    ...(tenant ? { tenant } : {}),
    ...(objectStore ? { objectStore } : {}),
  };
}

/** S3 bucket names: 3 to 63 lowercase letters, digits, dots and hyphens. */
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** `StackConfig.objectStore` from `NYLORUN_OBJECT_STORE_*`, or `undefined` without an endpoint. */
function parseObjectStore(env: EnvSnapshot): ObjectStoreConfig | undefined {
  const endpoint = parseUrl(env, "NYLORUN_OBJECT_STORE_ENDPOINT", ["http:", "https:"]);
  const accessKeyId = read(env, "NYLORUN_OBJECT_STORE_ACCESS_KEY");
  const secretAccessKey = read(env, "NYLORUN_OBJECT_STORE_SECRET_KEY");
  if (endpoint === undefined) {
    if (accessKeyId !== undefined || secretAccessKey !== undefined)
      throw new StackConfigError(
        "NYLORUN_OBJECT_STORE_ACCESS_KEY or _SECRET_KEY is set without NYLORUN_OBJECT_STORE_ENDPOINT: set the S3 endpoint, e.g. http://rustfs:9000",
      );
    return undefined;
  }
  if (accessKeyId === undefined || secretAccessKey === undefined)
    throw new StackConfigError(
      "NYLORUN_OBJECT_STORE_ACCESS_KEY and NYLORUN_OBJECT_STORE_SECRET_KEY are required with NYLORUN_OBJECT_STORE_ENDPOINT (`nylorun start` sets them)",
    );
  const bucket = read(env, "NYLORUN_OBJECT_STORE_BUCKET") ?? "nylorun";
  if (!BUCKET.test(bucket))
    throw new StackConfigError(
      `NYLORUN_OBJECT_STORE_BUCKET must be an S3 bucket name (3 to 63 of a-z 0-9 . -), not ${bucket}`,
    );
  const region = read(env, "NYLORUN_OBJECT_STORE_REGION") ?? "us-east-1";
  if (!/^[a-z0-9-]+$/.test(region))
    throw new StackConfigError(`NYLORUN_OBJECT_STORE_REGION is not a region: ${region}`);
  return { endpoint: endpoint.replace(/\/+$/, ""), bucket, region, accessKeyId, secretAccessKey };
}

function parseTenant(env: EnvSnapshot): TenantSettings {
  const id = read(env, "NYLORUN_TENANT_ID");
  if (id !== undefined && !isTenantId(id))
    throw new StackConfigError(
      `NYLORUN_TENANT_ID must be a Tenant id (tn_ and 26 Crockford characters), not ${id}`,
    );
  const identityFile = read(env, "NYLORUN_IDENTITY_FILE");
  const managementKeyFile = read(env, "NYLORUN_MANAGEMENT_KEY_FILE");
  return {
    ...(id ? { id } : {}),
    name: read(env, "NYLORUN_TENANT_NAME") ?? "default",
    ...(identityFile ? { identityFile } : {}),
    ...(managementKeyFile ? { managementKeyFile } : {}),
  };
}

const GATES_TOKEN = /^[0-9a-f]{64,}$/i;

/** `NYLORUN_HARNESS`: `in-process` (the default when unset) or `remote`. */
function parseHarnessMode(env: EnvSnapshot): "in-process" | "remote" | undefined {
  const raw = read(env, "NYLORUN_HARNESS");
  if (raw === undefined) return undefined;
  if (raw !== "in-process" && raw !== "remote")
    throw new StackConfigError(`NYLORUN_HARNESS must be in-process or remote, not ${raw}`);
  return raw;
}

function parseHarnessToken(env: EnvSnapshot, why: string): string {
  const token = read(env, "NYLORUN_HARNESS_TOKEN");
  if (token === undefined)
    throw new StackConfigError(`NYLORUN_HARNESS_TOKEN is required ${why} (\`nylorun start\` sets it)`);
  if (!GATES_TOKEN.test(token))
    throw new StackConfigError("NYLORUN_HARNESS_TOKEN must be at least 32 bytes as hex");
  return token;
}

/** `StackConfig.sandboxes` from `NYLORUN_SANDBOXES_*`, or undefined without a URL. */
function parseSandboxes(env: EnvSnapshot): SandboxesConfig | undefined {
  const url = parseUrl(env, "NYLORUN_SANDBOXES_URL", ["http:", "https:"]);
  if (url === undefined) return undefined;
  const token = read(env, "NYLORUN_SANDBOXES_TOKEN");
  if (token === undefined || token.length < 32)
    throw new StackConfigError(
      "NYLORUN_SANDBOXES_TOKEN (at least 32 characters) is required with NYLORUN_SANDBOXES_URL (`nylorun sandbox enable` sets both)",
    );
  const harnessImage = read(env, "NYLORUN_SANDBOX_HARNESS_IMAGE");
  if (harnessImage === undefined || /\s/.test(harnessImage))
    throw new StackConfigError(
      "NYLORUN_SANDBOX_HARNESS_IMAGE is required with NYLORUN_SANDBOXES_URL: the Runtime image sandbox pods copy the engine from (`nylorun start` sets it)",
    );
  return { url: url.replace(/\/+$/, ""), token, harnessImage };
}

/**
 * `StackConfig.harnessListener` from `NYLORUN_HARNESS_LISTEN_*` and `NYLORUN_HARNESS_TOKEN`
 * (required with `NYLORUN_HARNESS=remote`; optional when only sandbox pods connect).
 */
function parseHarnessListener(env: EnvSnapshot, tokenRequired = true): HarnessListenConfig {
  const host = read(env, "NYLORUN_HARNESS_LISTEN_HOST") ?? DEFAULT_CONTAINER_LISTEN_HOST;
  if (/\s|\//.test(host))
    throw new StackConfigError(`NYLORUN_HARNESS_LISTEN_HOST is not an address: ${host}`);
  const rawPort = read(env, "NYLORUN_HARNESS_LISTEN_PORT");
  const port =
    rawPort === undefined
      ? DEFAULT_HARNESS_LISTEN_PORT
      : parsePort("NYLORUN_HARNESS_LISTEN_PORT", rawPort);
  const rawAllowed = read(env, "NYLORUN_HARNESS_ALLOWED_HOSTS");
  const explicit =
    rawAllowed === undefined
      ? []
      : rawAllowed
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry !== "")
          .map((entry) => normalizeAllowedHost("NYLORUN_HARNESS_ALLOWED_HOSTS", entry));
  if (explicit.length === 0 && !isLoopbackAddress(host))
    throw new StackConfigError(
      `NYLORUN_HARNESS_ALLOWED_HOSTS is required when NYLORUN_HARNESS_LISTEN_HOST is ${host}: list the Host headers harnesses send, e.g. runtime:${port}`,
    );
  const token =
    tokenRequired || read(env, "NYLORUN_HARNESS_TOKEN") !== undefined
      ? parseHarnessToken(env, "with NYLORUN_HARNESS=remote: the credential harnesses present")
      : undefined;
  return {
    listen: { host, port, allowedHosts: [...new Set([...explicit, ...loopbackForms(port)])] },
    ...(token ? { token } : {}),
  };
}

/** What a harness process must not hold: it runs next to agent code. */
const HARNESS_REFUSED = ["NYLORUN_DATABASE_URL", "NYLORUN_GATES_TOKEN", "NYLORUN_KEYS_URL"];

/** `StackConfig.harness` from `NYLORUN_HARNESS_*` and `NYLORUN_GATES_URL`. */
function parseHarnessService(env: EnvSnapshot): HarnessServiceConfig {
  const held = [
    ...HARNESS_REFUSED.filter((name) => read(env, name) !== undefined),
    ...Object.keys(env)
      .filter((name) => name.startsWith("NYLORUN_RESTATE_") && read(env, name) !== undefined)
      .sort(),
  ];
  if (held.length > 0)
    throw new StackConfigError(
      `--service harness refuses to start with ${held.join(", ")} set: a harness reaches no database, no gate or keys credential and no Restate`,
    );
  const pod = read(env, "NYLORUN_SANDBOX_KIND") === "pod";
  const url = parseUrl(env, "NYLORUN_HARNESS_URL", pod ? ["http:", "https:", "ws:", "wss:"] : ["ws:", "wss:"]);
  if (url === undefined)
    throw new StackConfigError(
      "NYLORUN_HARNESS_URL is required for --service harness: core's Harness API, e.g. ws://runtime:4200/nylorun/harness/v1",
    );
  const gatesUrl = parseUrl(env, "NYLORUN_GATES_URL", ["http:", "https:"]);
  if (gatesUrl === undefined)
    throw new StackConfigError(
      "NYLORUN_GATES_URL is required for --service harness: its model and MCP calls go through the gates service, e.g. http://gateway:4100",
    );
  const root = read(env, "NYLORUN_HARNESS_ROOT") ?? "/harness";
  if (!root.startsWith("/"))
    throw new StackConfigError(`NYLORUN_HARNESS_ROOT must be an absolute path, not ${root}`);
  const rawHealth = read(env, "NYLORUN_HARNESS_HEALTH_PORT");
  const podHost = pod ? parsePodHost(env, url) : undefined;
  return {
    url: podHost ? podHost.wsUrl : url,
    ...(podHost
      ? { pod: podHost.config }
      : { token: parseHarnessToken(env, "for --service harness: the credential core's Harness API accepts") }),
    gatesUrl: gatesUrl.replace(/\/+$/, ""),
    root,
    healthPort:
      rawHealth === undefined
        ? DEFAULT_HARNESS_HEALTH_PORT
        : parsePort("NYLORUN_HARNESS_HEALTH_PORT", rawHealth),
  };
}

/**
 * The engine in a pod sandbox: the pod's identity and its join file, from the variables the
 * sandboxes service renders into the pod. `NYLORUN_HARNESS_URL` is the listener's address on the
 * Docker host (`http://<host>:<port>`); the WebSocket URL adds the Harness API path.
 */
function parsePodHost(env: EnvSnapshot, url: string): { config: PodHostConfig; wsUrl: string } {
  const need = (name: string) => {
    const value = read(env, name);
    if (value === undefined)
      throw new StackConfigError(`${name} is required for the engine in a sandbox pod (NYLORUN_SANDBOX_KIND=pod)`);
    return value;
  };
  if (read(env, "NYLORUN_HARNESS_TOKEN") !== undefined)
    throw new StackConfigError("A sandbox pod's engine holds no NYLORUN_HARNESS_TOKEN: it joins with its join token");
  const base = new URL(url);
  const secure = base.protocol === "https:" || base.protocol === "wss:";
  const origin = `${secure ? "https" : "http"}://${base.host}`;
  const egress = read(env, "NYLORUN_EGRESS_PROXY");
  return {
    wsUrl: `${secure ? "wss" : "ws"}://${base.host}/nylorun/harness/v1`,
    config: {
      sandboxId: need("NYLORUN_SANDBOX_ID"),
      podUid: need("NYLORUN_POD_UID"),
      joinFile: need("NYLORUN_SANDBOX_JOIN_FILE"),
      httpUrl: origin,
      ...(egress ? { egressProxy: egress.replace(/\/+$/, "") } : {}),
      blocked: blockedAddresses(env),
    },
  };
}

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
  const resolver = parseResolver(env);
  return {
    listen: { host, port, allowedHosts: [...new Set([...explicit, ...loopbackForms(port)])] },
    token,
    ...(resolver ? { resolver } : {}),
  };
}

/** `GatesConfig.resolver` from `NYLORUN_RESOLVER_URL` and `NYLORUN_RESOLVER_TOKEN`: both or neither. */
function parseResolver(env: EnvSnapshot): { url: string; token: string } | undefined {
  const url = parseUrl(env, "NYLORUN_RESOLVER_URL", ["http:", "https:"]);
  const token = read(env, "NYLORUN_RESOLVER_TOKEN");
  if (url === undefined) {
    if (token !== undefined)
      throw new StackConfigError(
        "NYLORUN_RESOLVER_TOKEN is set without NYLORUN_RESOLVER_URL: set the URL of your credential resolver",
      );
    return undefined;
  }
  if (token === undefined)
    throw new StackConfigError(
      "NYLORUN_RESOLVER_TOKEN is required with NYLORUN_RESOLVER_URL: the bearer the gateway presents to your credential resolver",
    );
  if (/\s/.test(token)) throw new StackConfigError("NYLORUN_RESOLVER_TOKEN cannot contain whitespace");
  return { url, token };
}

/** `StackConfig.egress` from `NYLORUN_EGRESS_LISTEN_*`. CONNECT has no Host header to check. */
function parseEgress(env: EnvSnapshot): EgressConfig {
  const host = read(env, "NYLORUN_EGRESS_LISTEN_HOST") ?? DEFAULT_CONTAINER_LISTEN_HOST;
  if (/\s|\//.test(host))
    throw new StackConfigError(`NYLORUN_EGRESS_LISTEN_HOST is not an address: ${host}`);
  const rawPort = read(env, "NYLORUN_EGRESS_LISTEN_PORT");
  const port =
    rawPort === undefined ? DEFAULT_EGRESS_LISTEN_PORT : parsePort("NYLORUN_EGRESS_LISTEN_PORT", rawPort);
  return { listen: { host, port } };
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

/** `StackConfig.keys` from `NYLORUN_KEYS_URL` and `NYLORUN_GATES_TOKEN`. */
function parseKeysEndpoint(env: EnvSnapshot): ModelGateEndpoint | undefined {
  const url = parseUrl(env, "NYLORUN_KEYS_URL", ["http:", "https:"]);
  if (url === undefined) return undefined;
  const token = read(env, "NYLORUN_GATES_TOKEN");
  if (token === undefined)
    throw new StackConfigError(
      "NYLORUN_GATES_TOKEN is required with NYLORUN_KEYS_URL: the keys service refuses calls without it",
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
