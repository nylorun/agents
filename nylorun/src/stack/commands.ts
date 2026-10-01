import { existsSync } from "node:fs";
import { readFile, rm, mkdir } from "node:fs/promises";
import {
  compareVersions,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
} from "@nylorun/core/compatibility";
import { CliError } from "../errors.js";
import { resolveHome } from "../home.js";
import {
  dockerPreflight,
  parseComposePs,
  type ComposeService,
  type DockerRunner,
} from "./docker.js";
import { readAdminKey, readHostConfig, STACK_CLIENT_HOST } from "./host-files.js";
import { runtimeImageOverridden, stackImages } from "./images.js";
import { stackPaths, type StackPaths } from "./paths.js";
import type { PortProbe } from "./ports.js";
import { prepareStack, readStackEnv } from "./prepare.js";
import { mintStudioLogin, studioOrigin, type FetchLike } from "./studio-login.js";

export const STACK_SERVICES = ["postgres", "restate", "s2", "runtime", "studio"] as const;
const CORE_SERVICES = ["postgres", "restate", "s2", "runtime"] as const;
const DEFAULT_PROJECT = "nylorun";

export const stackUsage = `  up|start [--no-studio] [--no-open] [--allow-downgrade] [--studio-embed-origin <origin>]... [--studio-embed-origin-reset]
                                      set up the stack on first run, then start it; print the Runtime and Studio URLs and open Studio signed in (in a terminal).
                                      refuses a Runtime older than the Host last ran unless --allow-downgrade.
                                      --studio-embed-origin lets one more exact origin show Studio in a frame (a desktop app's development server); kept across starts until --studio-embed-origin-reset
  down|stop                           stop the stack's containers; keep volumes
  status [--json] [--env]             services, endpoints and Runtime health (--env: the linked Project's variables)
  logs [service] [-f] [--tail <n>]    stack logs (${STACK_SERVICES.join(", ")})
  studio [--no-open]                  sign a browser in to Studio (on the linked Project's Tenant); --no-open prints the login URL; start the stack if it is stopped
  reset [--yes]                       delete the stack's volumes and Tenant directories`;

export interface StackDeps {
  /** Environment snapshot (NYLORUN_HOME, image overrides, NYLORUN_STACK_PROJECT). */
  env: Readonly<Record<string, string | undefined>>;
  docker: DockerRunner;
  fetch: FetchLike;
  ports: PortProbe;
  uid: number;
  gid: number;
  runtimeVersion: string;
  studioVersion: string;
  out(line: string): void;
  err(line: string): void;
  /** Ask a yes/no question on the terminal; undefined when not interactive. */
  confirm?(question: string): Promise<boolean>;
  /** A developer is at a terminal: `start` may open a browser. */
  interactive?: boolean;
  /** Open `url` in a browser; false when no browser could be started. */
  openBrowser(url: string): Promise<boolean>;
  /** Is this process id alive? (launcher-managed Runtime detection) */
  pidAlive(pid: number): boolean;
  /** Delay between health polls; tests shorten it. */
  pollMs?: number;
  /** How long `start` waits for the Runtime's /health after Compose. */
  healthTimeoutMs?: number;
  /** How long a Studio login is retried before warning. */
  loginTimeoutMs?: number;
}

const usageError = (message: string) => new CliError(message, 2);


export function stackProject(env: StackDeps["env"]): string {
  const project = env.NYLORUN_STACK_PROJECT?.trim() || DEFAULT_PROJECT;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project))
    throw usageError(
      `NYLORUN_STACK_PROJECT must be lowercase letters, digits, "-" or "_": ${project}`,
    );
  return project;
}

interface Context {
  deps: StackDeps;
  paths: StackPaths;
  project: string;
}

function context(deps: StackDeps): Context {
  return {
    deps,
    paths: stackPaths(resolveHome(undefined, deps.env)),
    project: stackProject(deps.env),
  };
}

function composeArgs(ctx: Context, ...args: string[]): string[] {
  return [
    "compose",
    "--project-name",
    ctx.project,
    "--file",
    ctx.paths.compose,
    "--env-file",
    ctx.paths.env,
    ...args,
  ];
}

function requireStackFiles(ctx: Context): void {
  if (!existsSync(ctx.paths.compose) || !existsSync(ctx.paths.env))
    throw new CliError(
      `No Nylorun stack under ${ctx.paths.root}. Run "nylorun start" first.`,
      3,
    );
}

interface Flags {
  rest: string[];
  booleans: Set<string>;
  values: Map<string, string>;
  /** Options that may repeat, in order. */
  lists: Map<string, string[]>;
}

export function parseStackFlags(
  args: readonly string[],
  allowed: {
    booleans?: readonly string[];
    values?: readonly string[];
    lists?: readonly string[];
    aliases?: Record<string, string>;
  },
  usage: string,
): Flags {
  const booleans = new Set<string>();
  const values = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]!;
    const arg = allowed.aliases?.[raw] ?? raw;
    if (!arg.startsWith("-")) {
      rest.push(arg);
      continue;
    }
    if (allowed.booleans?.includes(arg)) {
      booleans.add(arg);
      continue;
    }
    if (allowed.values?.includes(arg)) {
      const value = args[++index];
      if (value === undefined || value.startsWith("-"))
        throw usageError(`${arg} requires a value.`);
      values.set(arg, value);
      continue;
    }
    if (allowed.lists?.includes(arg)) {
      const value = args[++index];
      if (value === undefined || value.startsWith("-"))
        throw usageError(`${arg} requires a value.`);
      lists.set(arg, [...(lists.get(arg) ?? []), value]);
      continue;
    }
    throw usageError(`Unknown option ${raw}. Usage: ${usage}`);
  }
  return { rest, booleans, values, lists };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

interface Health {
  status?: string;
  version?: string;
  hostId?: string;
}

async function fetchHealth(
  deps: StackDeps,
  runtimeUrl: string,
): Promise<Health | undefined> {
  try {
    const response = await deps.fetch(`${runtimeUrl}/health`, {
      signal: AbortSignal.timeout(3000),
      redirect: "error",
    });
    if (!response.ok) return undefined;
    return (await response.json()) as Health;
  } catch {
    return undefined;
  }
}

async function waitForHealth(
  ctx: Context,
  runtimeUrl: string,
  hostId: string,
): Promise<Health> {
  const deadline = Date.now() + (ctx.deps.healthTimeoutMs ?? 60_000);
  for (;;) {
    const health = await fetchHealth(ctx.deps, runtimeUrl);
    if (health?.status === "ok") {
      if (health.hostId !== hostId)
        throw new CliError(
          `The Runtime at ${runtimeUrl} reports Host ${health.hostId ?? "(none)"}, not ${hostId} from ${ctx.paths.config}. Another Runtime holds the port; stop it or change NYLORUN_PORT in ${ctx.paths.env}.`,
          4,
        );
      return health;
    }
    if (Date.now() > deadline)
      throw new CliError(
        `The Runtime did not answer ${runtimeUrl}/health. See "nylorun logs runtime".`,
        7,
      );
    await sleep(ctx.deps.pollMs ?? 500);
  }
}

/**
 * A Runtime started by the removed launcher (`nylorun runtime up`, the
 * `nylorun-runtime` bin) shares host.json; refuse to fight it.
 */
async function refuseLauncherRuntime(ctx: Context): Promise<void> {
  let state: { pid?: unknown } | undefined;
  try {
    state = JSON.parse(await readFile(ctx.paths.state, "utf8")) as { pid?: unknown };
  } catch {
    return;
  }
  if (typeof state?.pid === "number" && ctx.deps.pidAlive(state.pid))
    throw new CliError(
      `A Runtime started by the old "nylorun runtime up" is running from ${ctx.paths.root} (pid ${state.pid}). Stop it with "nylorun-runtime --home ${ctx.paths.root} down" or end pid ${state.pid}, then run "nylorun start".`,
      4,
    );
}

async function composePs(ctx: Context): Promise<ComposeService[]> {
  const result = await ctx.deps.docker.run(
    composeArgs(ctx, "ps", "--all", "--format", "json"),
  );
  if (result.code !== 0) return [];
  try {
    return parseComposePs(result.stdout);
  } catch {
    return [];
  }
}

function isUp(services: ComposeService[], name: string): boolean {
  const service = services.find((s) => s.service === name);
  return service?.state === "running" && (service.health === "" || service.health === "healthy");
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** `version` is a SemVer older than `than` (prereleases sort before releases). */
function isOlder(version: string, than: unknown): than is string {
  return (
    typeof than === "string" &&
    SEMVER.test(version) &&
    SEMVER.test(than) &&
    compareVersions(version, than) < 0
  );
}

/** The version of this Host's Runtime when it answers on the stack's port. */
async function runningRuntimeVersion(
  ctx: Context,
  hostId: unknown,
): Promise<string | undefined> {
  const persisted = await readStackEnv(ctx.paths);
  if (!persisted?.runtimePort || typeof hostId !== "string") return undefined;
  const health = await fetchHealth(
    ctx.deps,
    `http://${STACK_CLIENT_HOST}:${persisted.runtimePort}`,
  );
  return health?.status === "ok" && health.hostId === hostId ? health.version : undefined;
}

/**
 * Refuse to start a Runtime older than the one the Host last ran (host.json
 * `runtimeVersion`) or the one running now: Compose would replace it, every
 * client on the machine shares the stack, and a Runtime older than a Tenant's
 * schema quarantines that Tenant. Skipped when `NYLORUN_RUNTIME_IMAGE` names
 * the image.
 */
async function refuseDowngrade(ctx: Context, allowDowngrade: boolean): Promise<void> {
  const pinned = ctx.deps.runtimeVersion;
  const host = await readHostConfig(ctx.paths);
  const newer: string[] = [];
  if (isOlder(pinned, host?.runtimeVersion))
    newer.push(`the Host last ran Runtime ${host.runtimeVersion} (${ctx.paths.config})`);
  const running = await runningRuntimeVersion(ctx, host?.hostId);
  if (isOlder(pinned, running) && running !== host?.runtimeVersion)
    newer.push(`Runtime ${running} is running`);
  if (newer.length === 0) return;
  if (allowDowngrade) {
    ctx.deps.err(
      `Warning: downgrading to Runtime ${pinned}: ${newer.join(" and ")}. Tenants a newer Runtime migrated are quarantined.`,
    );
    return;
  }
  throw new CliError(
    `Refusing to downgrade: this nylorun pins Runtime ${pinned}, but ${newer.join(" and ")}. Every project and app on this machine shares the stack, and a Runtime older than a Tenant's schema quarantines that Tenant. Update nylorun (npx nylorun@latest up), or run "nylorun start --allow-downgrade" to start Runtime ${pinned} anyway.`,
    5,
  );
}

interface Started {
  runtimeUrl: string;
  hostId: string;
  studioPort: number;
  studioStarted: boolean;
  adminKey: string;
}

async function bringUp(
  ctx: Context,
  options: {
    studio: boolean;
    allowDowngrade?: boolean;
    studioEmbedOrigins?: { add?: readonly string[]; reset?: boolean };
  },
): Promise<Started> {
  const { deps } = ctx;
  await refuseLauncherRuntime(ctx);
  const overridden = runtimeImageOverridden(deps.env);
  if (!overridden) await refuseDowngrade(ctx, options.allowDowngrade ?? false);
  const prepared = await prepareStack({
    paths: ctx.paths,
    images: stackImages(deps.env, {
      runtime: deps.runtimeVersion,
      studio: deps.studioVersion,
    }),
    uid: deps.uid,
    gid: deps.gid,
    // An overriding image's version is unknown: keep the recorded one.
    runtimeVersion: overridden ? undefined : deps.runtimeVersion,
    ports: deps.ports,
    ...(options.studioEmbedOrigins ? { studioEmbedOrigins: options.studioEmbedOrigins } : {}),
  });
  if (prepared.firstRun)
    deps.err(
      `Wrote ${ctx.paths.compose} and ${ctx.paths.env} (Runtime port ${prepared.env.runtimePort}, Studio port ${prepared.env.studioPort}).`,
    );
  const up = await deps.docker.stream(
    composeArgs(ctx, "up", "--detach", "--wait", "--wait-timeout", "300", ...CORE_SERVICES),
  );
  if (up !== 0)
    throw new CliError(
      `docker compose up failed (exit ${up}). See "nylorun logs runtime" and "nylorun status".`,
      7,
    );
  const runtimeUrl = `http://${STACK_CLIENT_HOST}:${prepared.env.runtimePort}`;
  await waitForHealth(ctx, runtimeUrl, prepared.host.hostId);

  let studioStarted = false;
  if (options.studio) {
    const studio = await deps.docker.stream(
      composeArgs(ctx, "up", "--detach", "--wait", "--wait-timeout", "120", "studio"),
    );
    studioStarted = studio === 0;
    if (!studioStarted)
      deps.err(
        `Warning: Studio did not start (image ${prepared.env.studioImage}). The Runtime is up; see "nylorun logs studio".`,
      );
  }
  return {
    runtimeUrl,
    hostId: prepared.host.hostId,
    studioPort: prepared.env.studioPort,
    studioStarted,
    adminKey: prepared.adminKey,
  };
}

async function tryStudioLogin(
  ctx: Context,
  studioPort: number,
  adminKey: string,
): Promise<string | undefined> {
  const deadline = Date.now() + (ctx.deps.loginTimeoutMs ?? 15_000);
  let lastError = "";
  for (;;) {
    try {
      return await mintStudioLogin({ fetch: ctx.deps.fetch, studioPort, adminKey });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() > deadline) break;
    await sleep(ctx.deps.pollMs ?? 500);
  }
  ctx.deps.err(
    `Warning: Studio at ${studioOrigin(studioPort)} is not reachable for a login (${lastError}).`,
  );
  return undefined;
}

/** Printed by `start` when it does not open Studio itself. */
export const STUDIO_SIGN_IN_HINT =
  'To sign a browser in to Studio, run "npx nylorun studio".';

/** `start` opens Studio only for a developer at a terminal, outside CI. */
function opensBrowser(deps: StackDeps, flags: Flags): boolean {
  return Boolean(deps.interactive) && !deps.env.CI && !flags.booleans.has("--no-open");
}

/**
 * Open a Studio login in the browser, or print it when no browser starts.
 * The login URL carries a single-use token, so it is printed only as a fallback.
 */
async function openLogin(ctx: Context, login: string): Promise<void> {
  if (!(await ctx.deps.openBrowser(login))) ctx.deps.out(`Sign in   ${login}`);
}

/** Printed by `start` while the Host has no Tenant: nylorun never creates one. */
export const TENANT_HINT =
  "No Tenant yet. Create one in Studio, or run `npx @nylorun/cli tenant create` in your project.";

const START_USAGE =
  "nylorun start [--no-studio] [--no-open] [--allow-downgrade] [--studio-embed-origin <origin>]... [--studio-embed-origin-reset]";

async function start(ctx: Context, args: readonly string[]): Promise<number> {
  const flags = parseStackFlags(
    args,
    {
      booleans: ["--no-studio", "--no-open", "--allow-downgrade", "--studio-embed-origin-reset"],
      lists: ["--studio-embed-origin"],
    },
    START_USAGE,
  );
  if (flags.rest.length) throw usageError(`Usage: ${START_USAGE}`);
  await dockerPreflight(ctx.deps.docker);
  const embedOrigins = flags.lists.get("--studio-embed-origin") ?? [];
  const resetEmbed = flags.booleans.has("--studio-embed-origin-reset");
  const started = await bringUp(ctx, {
    studio: !flags.booleans.has("--no-studio"),
    allowDowngrade: flags.booleans.has("--allow-downgrade"),
    ...(embedOrigins.length || resetEmbed
      ? { studioEmbedOrigins: { add: embedOrigins, reset: resetEmbed } }
      : {}),
  });
  ctx.deps.out(`Runtime   ${started.runtimeUrl}`);
  if (started.studioStarted) {
    ctx.deps.out(`Studio    ${studioOrigin(started.studioPort)}`);
    if (opensBrowser(ctx.deps, flags)) {
      const login = await tryStudioLogin(ctx, started.studioPort, started.adminKey);
      if (login) await openLogin(ctx, login);
    } else ctx.deps.err(STUDIO_SIGN_IN_HINT);
  }
  if ((await adminTenantCount(ctx.deps, started.runtimeUrl, started.adminKey)) === 0)
    ctx.deps.err(TENANT_HINT);
  return 0;
}

async function stop(ctx: Context, args: readonly string[]): Promise<number> {
  if (args.length) throw usageError("Usage: nylorun stop");
  requireStackFiles(ctx);
  await dockerPreflight(ctx.deps.docker);
  const code = await ctx.deps.docker.stream(composeArgs(ctx, "stop"));
  if (code !== 0) throw new CliError(`docker compose stop failed (exit ${code}).`, 1);
  ctx.deps.out("Stopped the Nylorun stack; volumes are kept.");
  return 0;
}

export interface StackStatus {
  project: string;
  home: string;
  state: "running" | "stopped" | "absent";
  runtime: {
    url?: string;
    /** The Admin API (operator listener), when the stack publishes one. */
    adminUrl?: string;
    healthy: boolean;
    version?: string;
    hostId?: string;
    tenants?: number;
  };
  studio: {
    url?: string;
    state: string;
    /** Exact origins that may show Studio in a frame (Studio §8.9). */
    embedOrigins?: string[];
  };
  restate: { url?: string };
  services: ComposeService[];
}

async function adminTenantCount(
  deps: StackDeps,
  runtimeUrl: string,
  adminKey: string | undefined,
): Promise<number | undefined> {
  if (!adminKey) return undefined;
  try {
    const response = await deps.fetch(`${runtimeUrl}/v1/admin/status`, {
      headers: {
        authorization: `Bearer ${adminKey}`,
        [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
        accept: "application/json",
      },
      signal: AbortSignal.timeout(3000),
      redirect: "error",
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { tenants?: unknown };
    return Array.isArray(body.tenants) ? body.tenants.length : undefined;
  } catch {
    return undefined;
  }
}

async function stackStatus(ctx: Context): Promise<StackStatus> {
  const base: StackStatus = {
    project: ctx.project,
    home: ctx.paths.root,
    state: "absent",
    runtime: { healthy: false },
    studio: { state: "absent" },
    restate: {},
    services: [],
  };
  if (!existsSync(ctx.paths.compose) || !existsSync(ctx.paths.env)) return base;
  await dockerPreflight(ctx.deps.docker);
  const persisted = (await readStackEnv(ctx.paths)) ?? {};
  const services = await composePs(ctx);
  const runtimeUrl = persisted.runtimePort
    ? `http://${STACK_CLIENT_HOST}:${persisted.runtimePort}`
    : undefined;
  const health = runtimeUrl ? await fetchHealth(ctx.deps, runtimeUrl) : undefined;
  const host = await readHostConfig(ctx.paths);
  const healthy =
    health?.status === "ok" && (host === undefined || health.hostId === host.hostId);
  // The Admin API answers on the operator port; an older stack has only the Runtime port.
  const adminUrl = persisted.adminPort
    ? `http://${STACK_CLIENT_HOST}:${persisted.adminPort}`
    : runtimeUrl;
  const tenants =
    healthy && adminUrl
      ? await adminTenantCount(ctx.deps, adminUrl, await readAdminKey(ctx.paths))
      : undefined;
  const studio = services.find((s) => s.service === "studio");
  return {
    ...base,
    state: services.some((s) => s.state === "running") ? "running" : "stopped",
    runtime: {
      ...(runtimeUrl ? { url: runtimeUrl } : {}),
      ...(persisted.adminPort && adminUrl ? { adminUrl } : {}),
      healthy,
      ...(health?.version ? { version: health.version } : {}),
      ...(health?.hostId ? { hostId: health.hostId } : {}),
      ...(tenants !== undefined ? { tenants } : {}),
    },
    studio: {
      ...(persisted.studioPort ? { url: studioOrigin(persisted.studioPort) } : {}),
      state: studio ? [studio.state, studio.health].filter(Boolean).join(", ") : "absent",
      ...(persisted.studioFrameAncestors
        ? { embedOrigins: persisted.studioFrameAncestors }
        : {}),
    },
    restate: persisted.restatePort
      ? { url: `http://${STACK_CLIENT_HOST}:${persisted.restatePort}` }
      : {},
    services,
  };
}

/** What `nylorun status` reports, as data (`nylorun doctor`). */
export async function readStackStatus(deps: StackDeps): Promise<StackStatus> {
  return await stackStatus(context(deps));
}

async function status(ctx: Context, args: readonly string[]): Promise<number> {
  const flags = parseStackFlags(args, { booleans: ["--json"] }, "nylorun status [--json]");
  if (flags.rest.length) throw usageError("Usage: nylorun status [--json]");
  const result = await stackStatus(ctx);
  const { out } = ctx.deps;
  if (flags.booleans.has("--json")) {
    out(JSON.stringify(result, null, 2));
  } else if (result.state === "absent") {
    out(`Stack       absent (no stack under ${result.home}; run "nylorun start")`);
  } else {
    out(`Stack       ${result.state} (project ${result.project})`);
    const runtimeDetail = result.runtime.healthy
      ? `healthy, ${result.runtime.version ?? "?"}, ${result.runtime.hostId ?? "?"}${
          result.runtime.tenants !== undefined ? `, ${result.runtime.tenants} Tenant(s)` : ""
        }`
      : "not answering";
    out(`Runtime     ${result.runtime.url ?? "?"}  ${runtimeDetail}`);
    if (result.runtime.adminUrl)
      out(`Admin API   ${result.runtime.adminUrl}  (operators only, never proxied)`);
    out(`Studio      ${result.studio.url ?? "?"}  ${result.studio.state} (log in with "nylorun studio")`);
    if (result.studio.embedOrigins?.length)
      out(`Embeds      ${result.studio.embedOrigins.join(" ")}  (may show Studio in a frame)`);
    if (result.restate.url) out(`Restate UI  ${result.restate.url}`);
    out(
      `Services    ${
        STACK_SERVICES.map((name) => {
          const service = result.services.find((s) => s.service === name);
          const state = service
            ? [service.state, service.health].filter(Boolean).join("/")
            : "absent";
          return `${name} ${state}`;
        }).join(", ")
      }`,
    );
    out(`Host root   ${result.home} (admin key in host-credentials.json, mode 0600)`);
  }
  return result.runtime.healthy ? 0 : 3;
}

async function logs(ctx: Context, args: readonly string[]): Promise<number> {
  const usage = `nylorun logs [${STACK_SERVICES.join("|")}] [-f] [--tail <n>]`;
  const flags = parseStackFlags(
    args,
    { booleans: ["--follow"], values: ["--tail"], aliases: { "-f": "--follow" } },
    usage,
  );
  if (flags.rest.length > 1) throw usageError(`Usage: ${usage}`);
  const service = flags.rest[0];
  if (service !== undefined && !(STACK_SERVICES as readonly string[]).includes(service))
    throw usageError(`Unknown service ${service}. Usage: ${usage}`);
  const tail = flags.values.get("--tail");
  if (tail !== undefined && !/^\d+$/.test(tail)) throw usageError(`Invalid --tail: ${tail}`);
  requireStackFiles(ctx);
  await dockerPreflight(ctx.deps.docker);
  return await ctx.deps.docker.stream(
    composeArgs(
      ctx,
      "logs",
      ...(flags.booleans.has("--follow") ? ["--follow"] : []),
      ...(tail !== undefined ? ["--tail", tail] : []),
      ...(service ? [service] : []),
    ),
  );
}

async function reset(ctx: Context, args: readonly string[]): Promise<number> {
  const flags = parseStackFlags(args, { booleans: ["--yes"], aliases: { "-y": "--yes" } }, "nylorun reset [--yes]");
  if (flags.rest.length) throw usageError("Usage: nylorun reset [--yes]");
  const { deps, paths } = ctx;
  if (!flags.booleans.has("--yes")) {
    const question = `Delete the stack's volumes (project ${ctx.project}) and every Tenant under ${paths.tenants}? This cannot be undone. [y/N] `;
    if (!deps.confirm)
      throw usageError("nylorun reset deletes all Tenants; pass --yes to confirm when not in a terminal.");
    if (!(await deps.confirm(question))) {
      deps.err("Reset cancelled.");
      return 1;
    }
  }
  if (existsSync(paths.compose) && existsSync(paths.env)) {
    await dockerPreflight(deps.docker);
    const code = await deps.docker.stream(
      composeArgs(ctx, "down", "--volumes", "--remove-orphans"),
    );
    if (code !== 0) throw new CliError(`docker compose down failed (exit ${code}).`, 1);
  }
  await rm(paths.tenants, { recursive: true, force: true });
  await mkdir(paths.tenants, { recursive: true, mode: 0o700 });
  deps.out(
    `Reset the Nylorun stack: volumes and Tenant directories deleted. Run "nylorun start" to start again.`,
  );
  return 0;
}

/** The running stack as clients reach it. */
export interface StackEndpoints {
  /** The Host root (`NYLORUN_HOME` or `~/.nylorun`). */
  home: string;
  /** `http://localhost:<port>` */
  runtimeUrl: string;
  hostId: string;
  adminKey: string;
  studioPort: number;
  /** Studio is running and healthy. */
  studioUp: boolean;
  /** This call started the Runtime (it was not running before). */
  started: boolean;
}

/** The stack when the Runtime (and Studio, if wanted) already answer; otherwise undefined. */
async function runningStack(
  ctx: Context,
  options: { studio: boolean },
): Promise<StackEndpoints | undefined> {
  if (!existsSync(ctx.paths.compose) || !existsSync(ctx.paths.env)) return undefined;
  const persisted = await readStackEnv(ctx.paths);
  const adminKey = await readAdminKey(ctx.paths);
  const host = await readHostConfig(ctx.paths);
  if (!persisted?.runtimePort || !persisted.studioPort || !adminKey) return undefined;
  if (typeof host?.hostId !== "string") return undefined;
  const services = await composePs(ctx);
  if (!isUp(services, "runtime")) return undefined;
  const studioUp = isUp(services, "studio");
  if (options.studio && !studioUp) return undefined;
  const runtimeUrl = `http://${STACK_CLIENT_HOST}:${persisted.runtimePort}`;
  const health = await fetchHealth(ctx.deps, runtimeUrl);
  if (health?.status !== "ok" || health.hostId !== host.hostId) return undefined;
  return {
    home: ctx.paths.root,
    runtimeUrl,
    hostId: host.hostId,
    adminKey,
    studioPort: persisted.studioPort,
    studioUp,
    started: false,
  };
}

/**
 * Start the stack unless it is already running (`nylorun studio`): the
 * `start` code path without its own output. Compose progress
 * still streams, since the first run pulls images.
 */
export async function ensureStack(
  deps: StackDeps,
  options: { studio: boolean },
): Promise<StackEndpoints> {
  const ctx = context(deps);
  await dockerPreflight(deps.docker);
  const running = await runningStack(ctx, options);
  if (running) return running;
  const runtimeWasUp = isUp(
    existsSync(ctx.paths.compose) ? await composePs(ctx) : [],
    "runtime",
  );
  const started = await bringUp(ctx, options);
  return {
    home: ctx.paths.root,
    runtimeUrl: started.runtimeUrl,
    hostId: started.hostId,
    adminKey: started.adminKey,
    studioPort: started.studioPort,
    studioUp: started.studioStarted,
    started: !runtimeWasUp,
  };
}

/** Add Studio's `next` path (e.g. `/tenants/<id>`) to a login URL. */
export function withNext(loginUrl: string, next: string | undefined): string {
  if (!next) return loginUrl;
  const url = new URL(loginUrl);
  url.searchParams.set("next", next);
  return url.toString();
}

/** The Studio page for one Tenant, as a login `next` path. */
export function tenantStudioPath(tenantId: string): string {
  return `/tenants/${encodeURIComponent(tenantId)}`;
}

/**
 * Mint a fresh Studio login URL on a running stack, landing on `next`.
 * Undefined (after a warning) when Studio does not answer.
 */
export async function studioLoginUrl(
  deps: StackDeps,
  stack: Pick<StackEndpoints, "studioPort" | "adminKey">,
  next?: string,
): Promise<string | undefined> {
  const login = await tryStudioLogin(context(deps), stack.studioPort, stack.adminKey);
  return login === undefined ? undefined : withNext(login, next);
}

async function studio(
  ctx: Context,
  args: readonly string[],
  options: { next?: string } = {},
): Promise<number> {
  const flags = parseStackFlags(args, { booleans: ["--no-open"] }, "nylorun studio [--no-open]");
  if (flags.rest.length) throw usageError("Usage: nylorun studio [--no-open]");
  const stack = await ensureStack(ctx.deps, { studio: true });
  if (stack.started) ctx.deps.out(`Runtime   ${stack.runtimeUrl}`);
  if (!stack.studioUp)
    throw new CliError(`Studio did not start. See "nylorun logs studio".`, 7);
  const login = await studioLoginUrl(ctx.deps, stack, options.next);
  if (!login) return 1;
  if (flags.booleans.has("--no-open")) {
    ctx.deps.out(`Studio    ${login}`);
    return 0;
  }
  const origin = studioOrigin(stack.studioPort);
  ctx.deps.out(`Studio    ${options.next ? new URL(options.next, origin).toString() : origin}`);
  await openLogin(ctx, login);
  return 0;
}

/** `nylorun studio`, landing on `next` (the linked Project's Tenant) when given. */
export async function runStudioCommand(
  args: readonly string[],
  deps: StackDeps,
  options: { next?: string } = {},
): Promise<number> {
  return await studio(context(deps), args, options);
}

const COMMANDS: Record<string, (ctx: Context, args: readonly string[]) => Promise<number>> = {
  start,
  stop,
  // Docker Compose spellings.
  up: start,
  down: stop,
  status,
  logs,
  reset,
  studio: (ctx, args) => studio(ctx, args),
};

export function isStackCommand(name: string | undefined): boolean {
  return name !== undefined && Object.hasOwn(COMMANDS, name);
}

/** Run one stack command (`up`/`start`, `down`/`stop`, `status`, `logs`, `reset`, `studio`). */
export async function runStackCommand(
  name: string,
  args: readonly string[],
  deps: StackDeps,
): Promise<number> {
  const command = COMMANDS[name];
  if (!command) throw usageError(`Unknown stack command ${name}.\n${stackUsage}`);
  return await command(context(deps), args);
}
