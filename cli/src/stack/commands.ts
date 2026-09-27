import { existsSync } from "node:fs";
import { readFile, rm, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from "@nylorun/agents";
import { CliError } from "../errors.js";
import {
  dockerPreflight,
  parseComposePs,
  type ComposeService,
  type DockerRunner,
} from "./docker.js";
import { readAdminKey, readHostConfig, STACK_CLIENT_HOST } from "./host-files.js";
import { stackImages } from "./images.js";
import { stackPaths, type StackPaths } from "./paths.js";
import type { PortProbe } from "./ports.js";
import { prepareStack, readStackEnv } from "./prepare.js";
import { mintStudioLogin, studioOrigin, type FetchLike } from "./studio-login.js";

export const STACK_SERVICES = ["postgres", "restate", "s2", "runtime", "studio"] as const;
const CORE_SERVICES = ["postgres", "restate", "s2", "runtime"] as const;
const DEFAULT_PROJECT = "nylorun";

export const stackUsage = `  start [--no-studio]          start the local stack (Docker Compose); print the Runtime URL and a Studio login URL
  stop                          stop the stack's containers; keep volumes
  status [--json]               services, endpoints and Runtime health
  stack logs [service] [-f]     stack logs (${STACK_SERVICES.join(", ")})
  stack studio [--no-open]      open a fresh Studio login; start the stack if it is stopped
  reset [--yes]                 delete the stack's volumes and Tenant directories
  stack start|stop|status|logs|reset|studio   the same commands under one name`;

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
  openBrowser(url: string): Promise<void>;
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

function resolveHostRoot(env: StackDeps["env"]): string {
  const fromEnv = env.NYLORUN_HOME?.trim();
  return fromEnv ? resolve(fromEnv) : resolve(join(homedir(), ".nylorun"));
}

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
    paths: stackPaths(resolveHostRoot(deps.env)),
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
}

export function parseStackFlags(
  args: readonly string[],
  allowed: { booleans?: readonly string[]; values?: readonly string[]; aliases?: Record<string, string> },
  usage: string,
): Flags {
  const booleans = new Set<string>();
  const values = new Map<string, string>();
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
    throw usageError(`Unknown option ${raw}. Usage: ${usage}`);
  }
  return { rest, booleans, values };
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
        `The Runtime did not answer ${runtimeUrl}/health. See "nylorun stack logs runtime".`,
        7,
      );
    await sleep(ctx.deps.pollMs ?? 500);
  }
}

/** A launcher-managed Runtime (`nylorun runtime up`) shares host.json; refuse to fight it. */
async function refuseLauncherRuntime(ctx: Context): Promise<void> {
  let state: { pid?: unknown } | undefined;
  try {
    state = JSON.parse(await readFile(ctx.paths.state, "utf8")) as { pid?: unknown };
  } catch {
    return;
  }
  if (typeof state?.pid === "number" && ctx.deps.pidAlive(state.pid))
    throw new CliError(
      `A Runtime started by "nylorun runtime up" is running from ${ctx.paths.root} (pid ${state.pid}). Stop it with "nylorun runtime down", then run "nylorun start".`,
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

interface Started {
  runtimeUrl: string;
  studioPort: number;
  studioStarted: boolean;
  adminKey: string;
}

async function bringUp(ctx: Context, options: { studio: boolean }): Promise<Started> {
  const { deps } = ctx;
  await refuseLauncherRuntime(ctx);
  const prepared = await prepareStack({
    paths: ctx.paths,
    images: stackImages(deps.env, {
      runtime: deps.runtimeVersion,
      studio: deps.studioVersion,
    }),
    uid: deps.uid,
    gid: deps.gid,
    runtimeVersion: deps.runtimeVersion,
    ports: deps.ports,
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
      `docker compose up failed (exit ${up}). See "nylorun stack logs runtime" and "nylorun status".`,
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
        `Warning: Studio did not start (image ${prepared.env.studioImage}). The Runtime is up; see "nylorun stack logs studio".`,
      );
  }
  return {
    runtimeUrl,
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

async function start(ctx: Context, args: readonly string[]): Promise<number> {
  const flags = parseStackFlags(args, { booleans: ["--no-studio"] }, "nylorun start [--no-studio]");
  if (flags.rest.length) throw usageError("Usage: nylorun start [--no-studio]");
  await dockerPreflight(ctx.deps.docker);
  const started = await bringUp(ctx, { studio: !flags.booleans.has("--no-studio") });
  ctx.deps.out(`Runtime   ${started.runtimeUrl}`);
  if (started.studioStarted) {
    const login = await tryStudioLogin(ctx, started.studioPort, started.adminKey);
    if (login) ctx.deps.out(`Studio    ${login}`);
  }
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
    healthy: boolean;
    version?: string;
    hostId?: string;
    tenants?: number;
  };
  studio: { url?: string; state: string };
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
  const tenants =
    healthy && runtimeUrl
      ? await adminTenantCount(ctx.deps, runtimeUrl, await readAdminKey(ctx.paths))
      : undefined;
  const studio = services.find((s) => s.service === "studio");
  return {
    ...base,
    state: services.some((s) => s.state === "running") ? "running" : "stopped",
    runtime: {
      ...(runtimeUrl ? { url: runtimeUrl } : {}),
      healthy,
      ...(health?.version ? { version: health.version } : {}),
      ...(health?.hostId ? { hostId: health.hostId } : {}),
      ...(tenants !== undefined ? { tenants } : {}),
    },
    studio: {
      ...(persisted.studioPort ? { url: studioOrigin(persisted.studioPort) } : {}),
      state: studio ? [studio.state, studio.health].filter(Boolean).join(", ") : "absent",
    },
    restate: persisted.restatePort
      ? { url: `http://${STACK_CLIENT_HOST}:${persisted.restatePort}` }
      : {},
    services,
  };
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
    out(`Studio      ${result.studio.url ?? "?"}  ${result.studio.state} (log in with "nylorun stack studio")`);
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
  const usage = `nylorun stack logs [${STACK_SERVICES.join("|")}] [-f] [--tail <n>]`;
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

async function studio(ctx: Context, args: readonly string[]): Promise<number> {
  const flags = parseStackFlags(args, { booleans: ["--no-open"] }, "nylorun stack studio [--no-open]");
  if (flags.rest.length) throw usageError("Usage: nylorun stack studio [--no-open]");
  await dockerPreflight(ctx.deps.docker);
  const persisted = existsSync(ctx.paths.compose) ? await readStackEnv(ctx.paths) : undefined;
  const services = persisted ? await composePs(ctx) : [];
  let studioPort = persisted?.studioPort;
  let adminKey = await readAdminKey(ctx.paths);
  if (!studioPort || !adminKey || !isUp(services, "runtime") || !isUp(services, "studio")) {
    const started = await bringUp(ctx, { studio: true });
    ctx.deps.out(`Runtime   ${started.runtimeUrl}`);
    if (!started.studioStarted)
      throw new CliError(`Studio did not start. See "nylorun stack logs studio".`, 7);
    studioPort = started.studioPort;
    adminKey = started.adminKey;
  }
  const login = await tryStudioLogin(ctx, studioPort, adminKey);
  if (!login) return 1;
  ctx.deps.out(`Studio    ${login}`);
  if (!flags.booleans.has("--no-open")) await ctx.deps.openBrowser(login);
  return 0;
}

const COMMANDS: Record<string, (ctx: Context, args: readonly string[]) => Promise<number>> = {
  start,
  stop,
  status,
  logs,
  reset,
  studio,
};

export function isStackCommand(name: string | undefined): boolean {
  return name !== undefined && Object.hasOwn(COMMANDS, name);
}

/** Run one stack command (`start`, `stop`, `status`, `logs`, `reset`, `studio`). */
export async function runStackCommand(
  name: string,
  args: readonly string[],
  deps: StackDeps,
): Promise<number> {
  const command = COMMANDS[name];
  if (!command) throw usageError(`Unknown stack command ${name}.\n${stackUsage}`);
  return await command(context(deps), args);
}
