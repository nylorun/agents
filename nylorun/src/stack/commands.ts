import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  compareVersions,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
} from "@nylorun/core/compatibility";
import type { HostTenant } from "@nylorun/core/contracts";
import { CliError } from "../errors.js";
import {
  credentialsPath,
  readCredentialsFile,
  readProjectCredentials,
  readProjectLink,
  writeProjectCredentials,
  writeProjectLink,
  type ProjectLink,
} from "../project/link.js";
import { findProjectRoot } from "../project/root.js";
import { seedTenant } from "../project/seed.js";
import {
  readTelemetry,
  STUDIO_ANALYTICS_ID,
  TELEMETRY_NOTICE,
  telemetryDecision,
  writeTelemetry,
} from "../telemetry.js";
import {
  dockerPreflight,
  formatBytes,
  parseComposePs,
  tenantMemory,
  type ComposeService,
  type DockerRunner,
} from "./docker.js";
import type { HarnessMode, SandboxStackEnv } from "./env-file.js";
import { readAdminKey, readHostConfig, STACK_CLIENT_HOST } from "./host-files.js";
import { runtimeImageOverridden, stackImages } from "./images.js";
import { stackPaths, type StackPaths } from "./paths.js";
import type { PortProbe } from "./ports.js";
import { prepareStack, readStackEnv } from "./prepare.js";
import {
  assertTenantName,
  chooseTenantName,
  DEFAULT_TENANT,
  defaultNylorunRoot,
  listTenants,
  moveStackRoots,
  readTenantRecord,
  removeOldProxy,
  sanitizeTenantName,
  tenantRoot,
  tenantsDir,
  writeTenantRecord,
} from "./stacks.js";
import { mintStudioLogin, studioOrigin, type FetchLike } from "./studio-login.js";
import {
  CLI_KEY_ID,
  hostKey,
  keyAuthenticates,
  PROJECT_KEY_ID,
  type AdminEndpoint,
} from "./operator-keys.js";

export const STACK_SERVICES = [
  "postgres",
  "restate",
  "s2-lite",
  "rustfs",
  "gateway",
  "runtime",
  "harness",
  "studio",
] as const;
const CORE_SERVICES = ["postgres", "restate", "s2-lite", "rustfs", "gateway", "runtime", "harness"] as const;

/** The services `start` waits for: the harness only while it runs turns (`NYLORUN_HARNESS=remote`). */
function coreServices(harness: HarnessMode): string[] {
  return CORE_SERVICES.filter((service) => service !== "harness" || harness === "remote");
}

export const stackUsage = `  up|start [--tenant <name>] [--no-link] [--no-studio] [--no-open] [--allow-downgrade] [--studio-embed-origin <origin>]... [--studio-embed-origin-reset] [--restate-ui]
                                      start the project's Tenant, creating it and the Project link (.nylorun/link.json,
                                      credentials.json) on the first run; print the Runtime and Studio URLs and open Studio
                                      signed in (in a terminal). --tenant attaches to (or creates) a named Tenant; --no-link
                                      starts the default Tenant (or --tenant's) without linking the current directory;
                                      --restate-ui (or NYLORUN_RESTATE_UI=1) publishes Restate's UI on loopback for debugging
  down|stop [--tenant <name> | --all] stop the Tenant's containers (--all: every Tenant's); keep volumes
  status [--tenant <name>] [--json]   the Tenant, its id, services, endpoints and Runtime health
  logs [service] [--tenant <name>] [-f] [--tail <n>]
                                      container logs (${STACK_SERVICES.join(", ")})
  studio [--tenant <name>] [--no-open]
                                      sign a browser in to Studio on the Tenant; --no-open prints the login URL; start the Tenant if it is stopped
  reset [--tenant <name>] [--yes]     delete the Tenant's data (volumes, tenant/ and vault key); the next start creates it anew
  ls [--json]                         the Tenants on this machine, with their memory in use
  delete <tenant> --yes               remove a Tenant: containers, volumes and its Host root, with the vault key (KEK)`;

export interface StackDeps {
  /** Environment snapshot (NYLORUN_HOME, NYLORUN_TENANT, image overrides, NYLORUN_COMPOSE_PROJECT). */
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
  /** Where the project is looked for (default: the process's working directory). */
  cwd?: string;
  /** `~/.nylorun`: the Tenants (tests use a temporary directory). */
  nylorunRoot?: string;
  /** Delay between health polls; tests shorten it. */
  pollMs?: number;
  /** How long `start` waits for the Runtime's /health, and then its Tenant, after Compose. */
  healthTimeoutMs?: number;
  /** How long a Studio login is retried before warning. */
  loginTimeoutMs?: number;
}

const usageError = (message: string) => new CliError(message, 2);

/** The Compose project of Tenant `name`: `nylorun-<name>`, or `NYLORUN_COMPOSE_PROJECT`. */
export function stackProject(env: StackDeps["env"], name: string): string {
  const override = env.NYLORUN_COMPOSE_PROJECT?.trim();
  if (!override) return `nylorun-${name}`;
  return assertTenantName(override, "NYLORUN_COMPOSE_PROJECT");
}

interface Context {
  deps: StackDeps;
  /** The Tenant's name. */
  name: string;
  paths: StackPaths;
  /** The Compose project. */
  project: string;
  /** The project directory `start` links; absent outside a project or with --no-link. */
  projectDir?: string;
  /** The project's link as found. */
  link?: ProjectLink;
}

function nylorunRoot(deps: StackDeps): string {
  return deps.nylorunRoot ?? defaultNylorunRoot();
}

/** Before every Tenant command: move 0.4's Host roots, remove 0.6's Studio proxy. */
async function tidyMachine(deps: StackDeps): Promise<void> {
  const base = nylorunRoot(deps);
  await moveStackRoots(base, deps.err);
  await removeOldProxy(deps.docker, base, deps.err);
}

/**
 * Compose's names for a 0.5 Tenant's volumes (`<project>_postgres`, …) that exist on this
 * engine, and whether this release's `<project>-postgres` does.
 */
async function oldVolumes(
  docker: DockerRunner,
  project: string,
): Promise<{ old: string[]; current: boolean }> {
  const result = await docker.run(["volume", "ls", "--quiet", "--filter", `name=${project}`]);
  const names = new Set(result.code === 0 ? result.stdout.split(/\s+/) : []);
  return {
    old: ["postgres", "restate", "s2", "workspaces"]
      .map((volume) => `${project}_${volume}`)
      .filter((name) => names.has(name)),
    current: names.has(`${project}-postgres`),
  };
}

/** `docker compose down` (`reset`, `delete`), then drop a 0.5 Tenant's volumes and network. */
async function composeDown(
  ctx: Pick<Context, "deps" | "project">,
  args: string[],
): Promise<void> {
  const { docker } = ctx.deps;
  const code = await docker.stream(args);
  if (code !== 0) throw new CliError(`docker compose down failed (exit ${code}).`, 1);
  const { old } = await oldVolumes(docker, ctx.project);
  if (old.length) {
    await docker.run(["volume", "rm", ...old]);
    await docker.run(["network", "rm", `${ctx.project}_default`]);
  }
}

async function tenantNames(deps: StackDeps): Promise<string> {
  const names = (await listTenants(nylorunRoot(deps))).map((tenant) => tenant.name);
  return names.length ? ` Tenants on this machine: ${names.join(", ")}.` : "";
}

/**
 * Which Tenant a command acts on: `--tenant`, then `NYLORUN_TENANT`, then the Tenant of the
 * project's link (format 3; `start` replaces an older one); for `start` in a project, then a
 * name from the project directory (`chooseTenantName`); outside a project (or with
 * --no-link), `default`. `NYLORUN_HOME` sets the Host root whatever the name; its name
 * otherwise comes from its `tenant.json`, the project directory or the Host root's own.
 */
async function selectStack(
  deps: StackDeps,
  options: { name?: string; start?: boolean; noLink?: boolean } = {},
): Promise<Context> {
  const { env } = deps;
  const base = nylorunRoot(deps);
  const projectDir = options.noLink ? undefined : findProjectRoot(deps.cwd ?? process.cwd());
  const link = projectDir ? await readProjectLink(projectDir) : undefined;
  const explicit = options.name ?? (env.NYLORUN_TENANT?.trim() || undefined);
  if (explicit !== undefined)
    assertTenantName(explicit, options.name !== undefined ? "--tenant" : "NYLORUN_TENANT");
  let name = explicit ?? link?.tenant;
  let root: string;
  const home = env.NYLORUN_HOME?.trim();
  if (home) {
    root = resolve(home);
    name ??=
      (await readTenantRecord(root))?.name ??
      sanitizeTenantName(basename(projectDir ?? root));
  } else {
    if (name === undefined && options.start && projectDir)
      name = await chooseTenantName(base, projectDir);
    if (name === undefined && !projectDir) name = DEFAULT_TENANT;
    if (name === undefined)
      throw usageError(
        `No Tenant selected: run "nylorun start" in this project, pass --tenant <name>, or set NYLORUN_TENANT.${await tenantNames(deps)}`,
      );
    root = tenantRoot(base, name);
  }
  assertTenantName(name, "The Tenant name");
  return {
    deps,
    name,
    paths: stackPaths(root),
    project: stackProject(env, name),
    ...(projectDir ? { projectDir } : {}),
    ...(link ? { link } : {}),
  };
}

function composeArgs(ctx: Pick<Context, "project" | "paths">, ...args: string[]): string[] {
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
      `No Tenant ${ctx.name} under ${ctx.paths.root}. Run "nylorun start" first.`,
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

/** `--tenant` when given. */
function nameOption(flags: Flags): { name?: string } {
  const name = flags.values.get("--tenant");
  return name === undefined ? {} : { name };
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

/** The Host's one Tenant as `/v1/admin/status` reports it (no envelope). */
export type StackTenant = Pick<HostTenant, "id" | "name" | "state" | "cause">;

/** `/v1/admin/status` on the operator listener: the Tenant, and its harnesses (F6.2). */
interface StackAdminStatus {
  tenant: StackTenant;
  harness?: { mode: HarnessMode; connected: number };
}

/** `/v1/admin/status` on the operator listener; undefined when it does not answer. */
async function fetchAdminStatus(
  deps: StackDeps,
  adminUrl: string,
  adminKey: string | undefined,
): Promise<StackAdminStatus | undefined> {
  if (!adminKey) return undefined;
  try {
    const response = await deps.fetch(`${adminUrl}/v1/admin/status`, {
      headers: {
        authorization: `Bearer ${adminKey}`,
        [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
        accept: "application/json",
      },
      signal: AbortSignal.timeout(3000),
      redirect: "error",
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as {
      tenant?: Partial<HostTenant>;
      aggregate?: { harness?: { mode?: unknown; connected?: unknown } };
    };
    const tenant = body.tenant;
    if (!tenant || (tenant.state !== "open" && tenant.state !== "unavailable")) return undefined;
    const harness = body.aggregate?.harness;
    return {
      tenant: {
        id: typeof tenant.id === "string" ? tenant.id : null,
        name: typeof tenant.name === "string" ? tenant.name : null,
        state: tenant.state,
        ...(tenant.cause ? { cause: tenant.cause } : {}),
      },
      ...((harness?.mode === "remote" || harness?.mode === "in-process") &&
      typeof harness.connected === "number"
        ? { harness: { mode: harness.mode, connected: harness.connected } }
        : {}),
    };
  } catch {
    return undefined;
  }
}

/** `/v1/admin/status`'s Tenant on the operator listener; undefined when it does not answer. */
async function fetchTenant(
  deps: StackDeps,
  adminUrl: string,
  adminKey: string | undefined,
): Promise<StackTenant | undefined> {
  return (await fetchAdminStatus(deps, adminUrl, adminKey))?.tenant;
}

/** Why the Tenant is unavailable, with the repair the Runtime names. */
function tenantCauseMessage(ctx: Context, tenant: StackTenant): string {
  const cause = tenant.cause!;
  const hint =
    cause.code === "schema-too-new"
      ? ` This nylorun pins Runtime ${ctx.deps.runtimeVersion}, older than the Tenant's database: update nylorun (npx nylorun@latest start).`
      : "";
  return `Tenant ${ctx.name} is unavailable (${cause.code}): ${cause.message} ${cause.repair}${hint} See "nylorun logs runtime".`;
}

/**
 * Wait until the Tenant is open: the Runtime creates it on the first start and opens
 * it on later ones. A Tenant that could not be opened has a cause; report it.
 */
async function waitForTenant(
  ctx: Context,
  adminUrl: string,
  adminKey: string,
): Promise<StackTenant & { id: string }> {
  const deadline = Date.now() + (ctx.deps.healthTimeoutMs ?? 60_000);
  for (;;) {
    const tenant = await fetchTenant(ctx.deps, adminUrl, adminKey);
    if (tenant?.state === "open" && tenant.id) return { ...tenant, id: tenant.id };
    if (tenant?.cause) throw new CliError(tenantCauseMessage(ctx, tenant), 7);
    if (Date.now() > deadline)
      throw new CliError(
        `Tenant ${ctx.name} did not open (${adminUrl}/v1/admin/status: ${
          tenant ? tenant.state : "no answer"
        }). See "nylorun status" and "nylorun logs runtime".`,
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

async function composePs(ctx: Pick<Context, "deps" | "project" | "paths">): Promise<ComposeService[]> {
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

/**
 * Refuse a Runtime older than the Tenant's database: the Runtime that last ran the Tenant
 * (host.json `runtimeVersion`) migrated it, and an older one cannot open its Tenant
 * (`schema-too-new`). Checked before Compose replaces anything. Skipped when
 * `NYLORUN_RUNTIME_IMAGE` names the image.
 */
async function refuseDowngrade(ctx: Context, allowDowngrade: boolean): Promise<void> {
  const pinned = ctx.deps.runtimeVersion;
  const host = await readHostConfig(ctx.paths);
  if (!isOlder(pinned, host?.runtimeVersion)) return;
  if (allowDowngrade) {
    ctx.deps.err(
      `Warning: starting Runtime ${pinned} on Tenant ${ctx.name}, which Runtime ${host.runtimeVersion} last ran. If that Runtime migrated the database, the Tenant stays unavailable (schema-too-new).`,
    );
    return;
  }
  throw new CliError(
    `Refusing to start Runtime ${pinned} on Tenant ${ctx.name}: Runtime ${host.runtimeVersion} last ran it (${ctx.paths.config}), and a Runtime older than the Tenant's database cannot open its Tenant. Update nylorun (npx nylorun@latest start), or run "nylorun start --allow-downgrade" when both Runtimes use the same database schema.`,
    5,
  );
}

/** Ports the Tenants on this machine keep in their `.env` (but the one under `except`). */
async function tenantPorts(base: string, except?: string): Promise<Set<number>> {
  const others = (await listTenants(base))
    .filter((tenant) => resolve(tenant.root) !== except)
    .map((tenant) => stackPaths(tenant.root));
  const reserved = new Set<number>();
  for (const paths of others) {
    const persisted = await readStackEnv(paths);
    for (const port of [
      persisted?.runtimePort,
      persisted?.adminPort,
      persisted?.studioPort,
      persisted?.restatePort,
    ])
      if (port !== undefined) reserved.add(port);
  }
  return reserved;
}

/** Ports other Tenants keep, so a new Tenant avoids them. */
async function reservedPorts(ctx: Context): Promise<Set<number>> {
  return await tenantPorts(nylorunRoot(ctx.deps), ctx.paths.root);
}

interface Started {
  runtimeUrl: string;
  adminUrl: string;
  hostId: string;
  studioPort: number;
  /** `http://localhost:<studio port>` */
  studioUrl: string;
  studioStarted: boolean;
  adminKey: string;
  /** Restate's UI, when this start published it (`--restate-ui`). */
  restateUrl?: string;
}

async function bringUp(
  ctx: Context,
  options: {
    studio: boolean;
    allowDowngrade?: boolean;
    studioEmbedOrigins?: { add?: readonly string[]; reset?: boolean };
    /** `nylorun sandbox enable|disable`: set or remove the sandboxes settings. */
    sandboxes?: SandboxStackEnv | null;
    /** `start`: publish Restate's UI or not; other callers keep what the last start chose. */
    restateUi?: boolean;
  },
): Promise<Started> {
  const { deps } = ctx;
  await refuseLauncherRuntime(ctx);
  const overridden = runtimeImageOverridden(deps.env);
  if (!overridden) await refuseDowngrade(ctx, options.allowDowngrade ?? false);
  const legacy = await oldVolumes(deps.docker, ctx.project);
  if (legacy.old.length && !legacy.current)
    throw new CliError(
      `Tenant ${ctx.name} was created by nylorun 0.5; its data is in the old volumes ${legacy.old.join(", ")}. Run "nylorun reset --tenant ${ctx.name}" to start it fresh; that also removes the old volumes (or drop them yourself with "docker volume rm ${legacy.old.join(" ")}").`,
      3,
    );
  const base = nylorunRoot(deps);
  const telemetry = await readTelemetry(base);
  const analytics = telemetryDecision(deps.env, telemetry).enabled;
  const prepared = await prepareStack({
    paths: ctx.paths,
    name: ctx.name,
    project: ctx.project,
    images: stackImages(deps.env, {
      runtime: deps.runtimeVersion,
      studio: deps.studioVersion,
    }),
    uid: deps.uid,
    gid: deps.gid,
    // An overriding image's version is unknown: keep the recorded one.
    runtimeVersion: overridden ? undefined : deps.runtimeVersion,
    ports: deps.ports,
    reserved: await reservedPorts(ctx),
    ...(options.studioEmbedOrigins ? { studioEmbedOrigins: options.studioEmbedOrigins } : {}),
    ...(analytics ? { studioAnalyticsId: STUDIO_ANALYTICS_ID } : {}),
    ...(options.sandboxes !== undefined ? { sandboxes: options.sandboxes } : {}),
    ...(options.restateUi !== undefined ? { restateUi: options.restateUi } : {}),
  });
  if (analytics && options.studio && telemetry.noticeShown === undefined) {
    deps.err(TELEMETRY_NOTICE);
    await writeTelemetry(nylorunRoot(deps), { ...telemetry, noticeShown: new Date().toISOString() });
  }
  const record = await readTenantRecord(ctx.paths.root);
  const project = record?.project ?? ctx.projectDir;
  if (record?.name !== ctx.name || record.project !== project)
    await writeTenantRecord(ctx.paths.root, { name: ctx.name, ...(project ? { project } : {}) });
  if (prepared.firstRun)
    deps.err(
      `Created Tenant ${ctx.name} under ${ctx.paths.root} (Runtime port ${prepared.env.runtimePort}, Studio port ${prepared.env.studioPort}).`,
    );
  const runtimeUrl = `http://${STACK_CLIENT_HOST}:${prepared.env.runtimePort}`;
  const adminUrl = `http://${STACK_CLIENT_HOST}:${prepared.env.adminPort}`;
  const up = await deps.docker.stream(
    // --remove-orphans: a service this start's file no longer has (the harness after a rollback
    // to NYLORUN_HARNESS=in-process, sandboxes after disable) is removed, not left running.
    composeArgs(
      ctx,
      "up",
      "--detach",
      "--wait",
      "--wait-timeout",
      "300",
      "--remove-orphans",
      ...coreServices(prepared.env.harness),
    ),
  );
  if (up !== 0) {
    // A Runtime whose Tenant cannot open fails readiness; its status names the cause.
    const tenant = await fetchTenant(deps, adminUrl, prepared.adminKey);
    if (tenant?.cause) throw new CliError(tenantCauseMessage(ctx, tenant), 7);
    throw new CliError(
      `docker compose up failed (exit ${up}). See "nylorun logs runtime", "nylorun logs gateway", "nylorun logs harness" and "nylorun status".`,
      7,
    );
  }
  await waitForHealth(ctx, runtimeUrl, prepared.host.hostId);
  // Without --wait: a cluster that is down must not fail the start; sessions refuse pods.
  if (prepared.env.sandboxes) {
    const sandboxes = await deps.docker.stream(composeArgs(ctx, "up", "--detach", "sandboxes"));
    if (sandboxes !== 0)
      deps.err(`Warning: the sandboxes service did not start. See "nylorun logs sandboxes".`);
  }

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
    adminUrl,
    hostId: prepared.host.hostId,
    studioPort: prepared.env.studioPort,
    studioUrl: studioOrigin(prepared.env.studioPort),
    studioStarted,
    adminKey: prepared.adminKey,
    ...(prepared.env.restateUi
      ? { restateUrl: `http://${STACK_CLIENT_HOST}:${prepared.env.restatePort}` }
      : {}),
  };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A login URL on Studio's own port, retried while it starts. */
async function tryStudioLogin(
  ctx: Pick<Context, "deps">,
  studioPort: number,
  adminKey: string,
): Promise<string | undefined> {
  const { deps } = ctx;
  const origin = studioOrigin(studioPort);
  const deadline = Date.now() + (deps.loginTimeoutMs ?? 15_000);
  let lastError = "";
  for (;;) {
    try {
      return await mintStudioLogin({ fetch: deps.fetch, origin, adminKey });
    } catch (error) {
      lastError = errorText(error);
    }
    if (Date.now() > deadline) break;
    await sleep(deps.pollMs ?? 500);
  }
  deps.err(`Warning: Studio at ${origin} is not reachable for a login (${lastError}).`);
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
async function openLogin(ctx: Pick<Context, "deps">, login: string): Promise<void> {
  if (!(await ctx.deps.openBrowser(login))) ctx.deps.out(`Sign in   ${login}`);
}

/**
 * Link the project to the Tenant: `.nylorun/link.json` (format 3) and
 * `.nylorun/credentials.json`. The link is rewritten only when it is older, or the Tenant's
 * name, URL, Host or id changed; a new link seeds the Tenant from the project's `.env`.
 *
 * The credentials file is kept while its key still reaches the Tenant (one authenticated
 * read). Otherwise it gets the operator key `project` (F9 I1): the one the Host root keeps for
 * the projects linked to this Tenant (`project-credentials.json`), or a new one put through
 * the Admin API. Every checkout linked to the Tenant shares it, so linking one never rotates
 * another's key.
 */
async function linkProject(
  ctx: Context & { projectDir: string },
  started: Started,
  tenantId: string,
): Promise<void> {
  const { deps, projectDir, link } = ctx;
  const fresh =
    link?.format !== 3 ||
    link.tenant !== ctx.name ||
    link.hostUrl !== started.runtimeUrl ||
    link.hostId !== started.hostId ||
    link.tenantId !== tenantId;
  if (fresh)
    await writeProjectLink(projectDir, {
      tenant: ctx.name,
      hostUrl: started.runtimeUrl,
      hostId: started.hostId,
      tenantId,
    });
  const existing = await readProjectCredentials(projectDir);
  const admin: AdminEndpoint = {
    fetch: deps.fetch,
    adminUrl: started.adminUrl,
    adminKey: started.adminKey,
  };
  const keyOptions = {
    admin,
    runtimeUrl: started.runtimeUrl,
    id: PROJECT_KEY_ID,
    file: ctx.paths.projectCredentials,
    lock: ctx.paths.keysLock,
  };
  let applicationKey: string;
  if (existing && (await keyAuthenticates(deps.fetch, started.runtimeUrl, existing.applicationKey))) {
    applicationKey = existing.applicationKey;
    // A project key from before operator keys becomes the one the Host root keeps.
    if (
      existing.principalId === PROJECT_KEY_ID &&
      (await readCredentialsFile(ctx.paths.projectCredentials))?.applicationKey !== applicationKey
    )
      await hostKey({ ...keyOptions, adopt: existing });
  } else {
    const key = await hostKey(keyOptions);
    applicationKey = key.applicationKey;
    await writeProjectCredentials(projectDir, {
      applicationKey: key.applicationKey,
      principalId: key.principalId,
    });
    if (existing && !fresh)
      deps.err(`Replaced the project's key, which no longer reaches Tenant ${ctx.name} (.nylorun/credentials.json).`);
  }
  if (!fresh) return;
  deps.err(`Linked ${projectDir} to Tenant ${ctx.name} (.nylorun/link.json, .nylorun/credentials.json).`);
  try {
    const seeded = await seedTenant({
      fetch: deps.fetch,
      runtimeUrl: started.runtimeUrl,
      applicationKey,
      projectRoot: projectDir,
    });
    const set = [...seeded.applied, ...(seeded.model ? [`model ${seeded.model}`] : [])];
    if (set.length) deps.err(`Seeded the Tenant from .env: ${set.join(", ")}.`);
  } catch (error) {
    deps.err(
      `Warning: could not seed the Tenant from .env (${error instanceof Error ? error.message : String(error)}). Set the model in Studio or with "npx @nylorun/cli configure".`,
    );
  }
}

const START_USAGE =
  "nylorun start [--tenant <name>] [--no-link] [--no-studio] [--no-open] [--allow-downgrade] [--studio-embed-origin <origin>]... [--studio-embed-origin-reset] [--restate-ui]";

async function start(deps: StackDeps, args: readonly string[]): Promise<number> {
  const flags = parseStackFlags(
    args,
    {
      booleans: [
        "--no-studio",
        "--no-open",
        "--no-link",
        "--allow-downgrade",
        "--studio-embed-origin-reset",
        "--restate-ui",
      ],
      values: ["--tenant"],
      lists: ["--studio-embed-origin"],
    },
    START_USAGE,
  );
  if (flags.rest.length) throw usageError(`Usage: ${START_USAGE}`);
  const ctx = await selectStack(deps, {
    ...nameOption(flags),
    start: true,
    noLink: flags.booleans.has("--no-link"),
  });
  await dockerPreflight(deps.docker);
  const embedOrigins = flags.lists.get("--studio-embed-origin") ?? [];
  const resetEmbed = flags.booleans.has("--studio-embed-origin-reset");
  const started = await bringUp(ctx, {
    studio: !flags.booleans.has("--no-studio"),
    allowDowngrade: flags.booleans.has("--allow-downgrade"),
    restateUi: flags.booleans.has("--restate-ui") || deps.env.NYLORUN_RESTATE_UI?.trim() === "1",
    ...(embedOrigins.length || resetEmbed
      ? { studioEmbedOrigins: { add: embedOrigins, reset: resetEmbed } }
      : {}),
  });
  const tenant = await waitForTenant(ctx, started.adminUrl, started.adminKey);
  if (ctx.projectDir) await linkProject({ ...ctx, projectDir: ctx.projectDir }, started, tenant.id);
  deps.out(`Tenant    ${ctx.name}  (${tenant.id})`);
  deps.out(`Runtime   ${started.runtimeUrl}`);
  if (started.restateUrl) deps.out(`Restate   ${started.restateUrl}  (UI and admin, unauthenticated; for debugging)`);
  if (started.studioStarted) {
    deps.out(`Studio    ${started.studioUrl}`);
    if (opensBrowser(deps, flags)) {
      const login = await tryStudioLogin(ctx, started.studioPort, started.adminKey);
      if (login) await openLogin(ctx, withNext(login, tenantStudioPath(tenant.id)));
    } else deps.err(STUDIO_SIGN_IN_HINT);
  }
  await alsoRunning(ctx);
  return 0;
}

/** After `start`: the machine's other running Tenants and their memory, on stderr. */
async function alsoRunning(ctx: Context): Promise<void> {
  const { deps } = ctx;
  const projects = await composeProjects(deps.docker);
  if (!projects) return;
  const others = (await listTenants(nylorunRoot(deps)))
    .map((tenant) => tenant.name)
    .filter((name) => name !== ctx.name && projects.get(`nylorun-${name}`) === "running");
  if (others.length === 0) return;
  const memory = await tenantMemory(deps.docker);
  const sizes = others.map((name) => memory?.get(name));
  const total = sizes.every((size) => size !== undefined)
    ? sizes.reduce((sum: number, size) => sum + size!, 0)
    : undefined;
  deps.err(
    `Also running: ${others.join(", ")}${total === undefined ? "" : ` (about ${formatBytes(total)})`}. "nylorun stop --all" stops them all.`,
  );
}

async function stop(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun stop [--tenant <name> | --all]";
  const flags = parseStackFlags(args, { booleans: ["--all"], values: ["--tenant"] }, usage);
  if (flags.rest.length) throw usageError(`Usage: ${usage}`);
  if (flags.booleans.has("--all")) {
    if (flags.values.has("--tenant"))
      throw usageError(`--all and --tenant are exclusive. Usage: ${usage}`);
    return await stopAll(deps);
  }
  const ctx = await selectStack(deps, nameOption(flags));
  requireStackFiles(ctx);
  await dockerPreflight(deps.docker);
  const code = await deps.docker.stream(composeArgs(ctx, "stop"));
  if (code !== 0) throw new CliError(`docker compose stop failed (exit ${code}).`, 1);
  deps.out(`Stopped Tenant ${ctx.name}; its data is kept.`);
  return 0;
}

/** `stop --all`: every running Tenant on this machine; volumes are kept. */
async function stopAll(deps: StackDeps): Promise<number> {
  await dockerPreflight(deps.docker);
  const projects = (await composeProjects(deps.docker)) ?? new Map<string, string>();
  const stopped: string[] = [];
  for (const tenant of await listTenants(nylorunRoot(deps))) {
    const project = `nylorun-${tenant.name}`;
    if (projects.get(project) !== "running") continue;
    const paths = stackPaths(tenant.root);
    const code = await deps.docker.stream(
      existsSync(paths.compose) && existsSync(paths.env)
        ? composeArgs({ project, paths }, "stop")
        : ["compose", "--project-name", project, "stop"],
    );
    if (code !== 0)
      throw new CliError(`docker compose stop failed for Tenant ${tenant.name} (exit ${code}).`, 1);
    stopped.push(tenant.name);
  }
  deps.out(
    stopped.length
      ? `Stopped Tenants ${stopped.join(", ")}; their data is kept.`
      : "No Tenant was running.",
  );
  return 0;
}

export interface StackStatus {
  /** The Tenant's name. */
  name: string;
  /** The Compose project. */
  project: string;
  /** The Host root. */
  home: string;
  state: "running" | "stopped" | "absent";
  runtime: {
    url?: string;
    /** The Admin API (operator listener), when the Tenant publishes one. */
    adminUrl?: string;
    healthy: boolean;
    version?: string;
    hostId?: string;
  };
  /** The Tenant as the Runtime reports it, while it answers. */
  tenant?: StackTenant;
  studio: {
    /** `http://localhost:<port>`: also what an embedding app frames (same site as its own localhost). */
    url?: string;
    state: string;
    /** Exact origins that may show Studio in a frame (Studio §8.9). */
    embedOrigins?: string[];
  };
  /** Restate's UI: `url` only while published (`nylorun start --restate-ui`). */
  restate: { url?: string; published: boolean };
  /** The gateway container (the Model Gate), in the combined packing. */
  gateway: { state: string; healthy: boolean };
  /**
   * Where agent turns, MCP servers and workspaces run (F6.2): `remote`, the harness container,
   * or `in-process`, the runtime container (`NYLORUN_HARNESS` in .env). `connected` counts the
   * harnesses attached to the Tenant, as the Runtime reports them.
   */
  harness: { mode: HarnessMode; state: string; healthy: boolean; connected?: number };
  services: ComposeService[];
}

async function stackStatus(ctx: Context): Promise<StackStatus> {
  const base: StackStatus = {
    name: ctx.name,
    project: ctx.project,
    home: ctx.paths.root,
    state: "absent",
    runtime: { healthy: false },
    studio: { state: "absent" },
    restate: { published: false },
    gateway: { state: "absent", healthy: false },
    harness: { mode: "remote", state: "absent", healthy: false },
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
  // The Admin API answers on the operator port; an older Host root has only the Runtime port.
  const adminUrl = persisted.adminPort
    ? `http://${STACK_CLIENT_HOST}:${persisted.adminPort}`
    : runtimeUrl;
  const answered =
    healthy && adminUrl
      ? await fetchAdminStatus(ctx.deps, adminUrl, await readAdminKey(ctx.paths))
      : undefined;
  const tenant = answered?.tenant;
  const studio = services.find((s) => s.service === "studio");
  const gateway = services.find((s) => s.service === "gateway");
  const harness = services.find((s) => s.service === "harness");
  const harnessMode = persisted.harness ?? "remote";
  return {
    ...base,
    state: services.some((s) => s.state === "running") ? "running" : "stopped",
    runtime: {
      ...(runtimeUrl ? { url: runtimeUrl } : {}),
      ...(persisted.adminPort && adminUrl ? { adminUrl } : {}),
      healthy,
      ...(health?.version ? { version: health.version } : {}),
      ...(health?.hostId ? { hostId: health.hostId } : {}),
    },
    ...(tenant ? { tenant } : {}),
    studio: {
      ...(persisted.studioPort ? { url: studioOrigin(persisted.studioPort) } : {}),
      state: studio ? [studio.state, studio.health].filter(Boolean).join(", ") : "absent",
      ...(persisted.studioFrameAncestors
        ? { embedOrigins: persisted.studioFrameAncestors }
        : {}),
    },
    restate:
      persisted.restatePort && persisted.restateUi
        ? { url: `http://${STACK_CLIENT_HOST}:${persisted.restatePort}`, published: true }
        : { published: false },
    gateway: {
      state: gateway ? [gateway.state, gateway.health].filter(Boolean).join(", ") : "absent",
      healthy: isUp(services, "gateway"),
    },
    harness: {
      mode: answered?.harness?.mode ?? harnessMode,
      state: harness ? [harness.state, harness.health].filter(Boolean).join(", ") : "absent",
      healthy: isUp(services, "harness"),
      ...(answered?.harness ? { connected: answered.harness.connected } : {}),
    },
    services,
  };
}

/** What `nylorun status` reports, as data (`nylorun doctor`). */
export async function readStackStatus(
  deps: StackDeps,
  options: { name?: string } = {},
): Promise<StackStatus> {
  await tidyMachine(deps);
  return await stackStatus(await selectStack(deps, options));
}

function describeTenant(tenant: StackTenant): string {
  const who = `${tenant.id ?? "(no id yet)"}${tenant.name ? ` (${tenant.name})` : ""}`;
  if (tenant.state === "open") return `${who}  open`;
  return tenant.cause
    ? `${who}  unavailable: ${tenant.cause.code}: ${tenant.cause.message} ${tenant.cause.repair}`
    : `${who}  unavailable (opening)`;
}

async function status(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun status [--tenant <name>] [--json]";
  const flags = parseStackFlags(args, { booleans: ["--json"], values: ["--tenant"] }, usage);
  if (flags.rest.length) throw usageError(`Usage: ${usage}`);
  const result = await stackStatus(await selectStack(deps, nameOption(flags)));
  const { out } = deps;
  if (flags.booleans.has("--json")) {
    out(JSON.stringify(result, null, 2));
  } else if (result.state === "absent") {
    out(`Tenant      ${result.name} absent (nothing under ${result.home}; run "nylorun start")`);
  } else {
    out(`Tenant      ${result.name}  ${result.state} (Compose project ${result.project})`);
    out(`Host root   ${result.home} (admin key in host-credentials.json, mode 0600)`);
    if (result.tenant) out(`Tenant id   ${describeTenant(result.tenant)}`);
    const runtimeDetail = result.runtime.healthy
      ? `healthy, ${result.runtime.version ?? "?"}, ${result.runtime.hostId ?? "?"}`
      : "not answering";
    out(`Runtime     ${result.runtime.url ?? "?"}  ${runtimeDetail}`);
    if (result.runtime.adminUrl)
      out(`Admin API   ${result.runtime.adminUrl}  (operators only, never proxied)`);
    out(`Studio      ${result.studio.url ?? "?"}  ${result.studio.state} (log in with "nylorun studio")`);
    if (result.studio.embedOrigins?.length)
      out(`Embeds      ${result.studio.embedOrigins.join(" ")}  (may show Studio in a frame)`);
    out(
      `Gateway     ${result.gateway.state} (the Model Gate; model calls fail while it is down)`,
    );
    out(
      result.harness.mode === "remote"
        ? `Harness     ${result.harness.state}, remote${
            result.harness.connected === undefined ? "" : `, ${result.harness.connected} connected`
          } (agent turns, MCP servers and workspaces; "nylorun logs harness")`
        : `Harness     in-process (NYLORUN_HARNESS=in-process in .env: turns run in the runtime container)`,
    );
    out(
      result.restate.url
        ? `Restate UI  ${result.restate.url}  (unauthenticated; published by --restate-ui)`
        : `Restate UI  not published (nylorun start --restate-ui)`,
    );
    const sandboxes = result.services.find((s) => s.service === "sandboxes");
    if (sandboxes)
      out(
        `Sandboxes   ${[sandboxes.state, sandboxes.health].filter(Boolean).join(", ")} (see "nylorun sandbox status")`,
      );
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
  }
  return result.runtime.healthy ? 0 : 3;
}

async function logs(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = `nylorun logs [${STACK_SERVICES.join("|")}] [--tenant <name>] [-f] [--tail <n>]`;
  const flags = parseStackFlags(
    args,
    { booleans: ["--follow"], values: ["--tail", "--tenant"], aliases: { "-f": "--follow" } },
    usage,
  );
  if (flags.rest.length > 1) throw usageError(`Usage: ${usage}`);
  const service = flags.rest[0];
  if (service !== undefined && ![...STACK_SERVICES, "sandboxes"].includes(service))
    throw usageError(`Unknown service ${service}. Usage: ${usage}`);
  const tail = flags.values.get("--tail");
  if (tail !== undefined && !/^\d+$/.test(tail)) throw usageError(`Invalid --tail: ${tail}`);
  const ctx = await selectStack(deps, nameOption(flags));
  requireStackFiles(ctx);
  await dockerPreflight(deps.docker);
  return await deps.docker.stream(
    composeArgs(
      ctx,
      "logs",
      ...(flags.booleans.has("--follow") ? ["--follow"] : []),
      ...(tail !== undefined ? ["--tail", tail] : []),
      ...(service ? [service] : []),
    ),
  );
}

async function reset(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun reset [--tenant <name>] [--yes]";
  const flags = parseStackFlags(
    args,
    { booleans: ["--yes"], values: ["--tenant"], aliases: { "-y": "--yes" } },
    usage,
  );
  if (flags.rest.length) throw usageError(`Usage: ${usage}`);
  const ctx = await selectStack(deps, nameOption(flags));
  const { paths } = ctx;
  if (!flags.booleans.has("--yes")) {
    const question = `Delete Tenant ${ctx.name}'s volumes (Compose project ${ctx.project}), its Tenant directory ${paths.tenant} and its vault key ${paths.vaultKey}? Its data is lost, and the next start creates the Tenant anew, with a new id. [y/N] `;
    if (!deps.confirm)
      throw usageError(
        `nylorun reset deletes all of Tenant ${ctx.name}'s data; pass --yes to confirm when not in a terminal.`,
      );
    if (!(await deps.confirm(question))) {
      deps.err("Reset cancelled.");
      return 1;
    }
  }
  if (existsSync(paths.compose) && existsSync(paths.env)) {
    await dockerPreflight(deps.docker);
    await composeDown(ctx, composeArgs(ctx, "down", "--volumes", "--remove-orphans"));
  }
  await rm(paths.tenant, { recursive: true, force: true });
  await mkdir(paths.tenant, { recursive: true, mode: 0o700 });
  // The vault key goes with the Tenant's data; the next start writes a new one.
  await rm(paths.keys, { recursive: true, force: true });
  deps.out(
    `Reset Tenant ${ctx.name}: its volumes, Tenant directory and vault key deleted. Run "nylorun start" to create it anew (it relinks the project).`,
  );
  return 0;
}

interface ListedTenant {
  name: string;
  /** The Host root. */
  root: string;
  /** The project directory the Tenant was created for. */
  project?: string;
  state: "running" | "stopped" | "unknown";
  /** Memory its running containers use (`docker stats`); null when stopped or unknown. */
  memoryBytes: number | null;
  runtimeUrl?: string;
  studioUrl?: string;
  ports: { runtime?: number; admin?: number; studio?: number; restate?: number };
}

/** Compose projects on this Docker engine and whether any container runs; undefined without Docker. */
async function composeProjects(
  docker: DockerRunner,
): Promise<Map<string, "running" | "stopped"> | undefined> {
  const result = await docker.run(["compose", "ls", "--all", "--format", "json"]);
  if (result.code !== 0) return undefined;
  try {
    const text = result.stdout.trim();
    const rows = (text === "" ? [] : JSON.parse(text)) as { Name?: unknown; Status?: unknown }[];
    return new Map(
      rows.map((row) => [
        String(row.Name ?? ""),
        /running/.test(String(row.Status ?? "")) ? "running" : "stopped",
      ]),
    );
  } catch {
    return undefined;
  }
}

async function ls(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun ls [--json]";
  const flags = parseStackFlags(args, { booleans: ["--json"] }, usage);
  if (flags.rest.length) throw usageError(`Usage: ${usage}`);
  const base = nylorunRoot(deps);
  const projects = await composeProjects(deps.docker);
  const state = (project: string) => (projects ? (projects.get(project) ?? "stopped") : "unknown");
  const memory = [...(projects?.values() ?? [])].includes("running")
    ? await tenantMemory(deps.docker)
    : undefined;
  const tenants: ListedTenant[] = [];
  for (const entry of await listTenants(base)) {
    const persisted = (await readStackEnv(stackPaths(entry.root))) ?? {};
    const tenantState = state(`nylorun-${entry.name}`);
    tenants.push({
      name: entry.name,
      root: entry.root,
      ...(entry.record.project ? { project: entry.record.project } : {}),
      state: tenantState,
      memoryBytes: (tenantState === "running" && memory?.get(entry.name)) || null,
      ...(persisted.runtimePort
        ? { runtimeUrl: `http://${STACK_CLIENT_HOST}:${persisted.runtimePort}` }
        : {}),
      ...(persisted.studioPort ? { studioUrl: studioOrigin(persisted.studioPort) } : {}),
      ports: {
        ...(persisted.runtimePort ? { runtime: persisted.runtimePort } : {}),
        ...(persisted.adminPort ? { admin: persisted.adminPort } : {}),
        ...(persisted.studioPort ? { studio: persisted.studioPort } : {}),
        ...(persisted.restatePort ? { restate: persisted.restatePort } : {}),
      },
    });
  }
  if (flags.booleans.has("--json")) {
    deps.out(JSON.stringify({ tenants }, null, 2));
    return 0;
  }
  if (tenants.length === 0) {
    deps.out(
      'No Tenants on this machine. Run "npx nylorun start" in a project (or anywhere, for the default Tenant).',
    );
    return 0;
  }
  const rows = [
    ["TENANT", "STATE", "MEMORY", "RUNTIME", "STUDIO", "PROJECT"],
    ...tenants.map((tenant) => [
      tenant.name,
      tenant.state,
      tenant.memoryBytes === null ? "-" : formatBytes(tenant.memoryBytes),
      tenant.runtimeUrl ?? "-",
      tenant.studioUrl ?? "-",
      tenant.project ?? "-",
    ]),
  ];
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)) + 2);
  for (const row of rows)
    deps.out(row.map((cell, column) => (column < row.length - 1 ? cell.padEnd(widths[column]!) : cell)).join(""));
  return 0;
}

async function deleteStack(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun delete <tenant> --yes";
  const flags = parseStackFlags(args, { booleans: ["--yes"], aliases: { "-y": "--yes" } }, usage);
  const [name, ...extra] = flags.rest;
  if (name === undefined || extra.length) throw usageError(`Usage: ${usage}`);
  assertTenantName(name, "The Tenant name");
  const base = nylorunRoot(deps);
  const ctx = { deps, project: stackProject(deps.env, name), paths: stackPaths(tenantRoot(base, name)) };
  if (!existsSync(ctx.paths.root))
    throw new CliError(`No Tenant ${name} under ${tenantsDir(base)}. See "nylorun ls".`, 3);
  if (!flags.booleans.has("--yes"))
    throw usageError(
      `nylorun delete removes Tenant ${name}: its containers, volumes and Host root ${ctx.paths.root}, with its vault key (KEK) and all its data. This cannot be undone; pass --yes to confirm.`,
    );
  await dockerPreflight(deps.docker);
  const files = existsSync(ctx.paths.compose) && existsSync(ctx.paths.env);
  await composeDown(
    ctx,
    files
      ? composeArgs(ctx, "down", "--volumes", "--remove-orphans")
      : ["compose", "--project-name", ctx.project, "down", "--volumes", "--remove-orphans"],
  );
  await rm(ctx.paths.root, { recursive: true, force: true });
  deps.out(`Deleted Tenant ${name}: its containers, volumes and Host root (vault key included).`);
  return 0;
}

/** The running Tenant as clients reach it. */
export interface StackEndpoints {
  /** The Tenant's name. */
  name: string;
  /** The Host root. */
  home: string;
  /** `http://localhost:<port>` */
  runtimeUrl: string;
  /** The operator listener (Admin API). */
  adminUrl: string;
  hostId: string;
  adminKey: string;
  studioPort: number;
  /** `http://localhost:<studio port>` */
  studioUrl: string;
  /** Studio is running and healthy. */
  studioUp: boolean;
  /** This call started the Runtime (it was not running before). */
  started: boolean;
}

/** The Tenant when the Runtime (and Studio, if wanted) already answer; otherwise undefined. */
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
  if (!isUp(services, "runtime") || !isUp(services, "gateway")) return undefined;
  // An older Tenant without the harness container is brought up again (remote is the default).
  if ((persisted.harness ?? "remote") === "remote" && !isUp(services, "harness")) return undefined;
  const studioUp = isUp(services, "studio");
  if (options.studio && !studioUp) return undefined;
  const runtimeUrl = `http://${STACK_CLIENT_HOST}:${persisted.runtimePort}`;
  const health = await fetchHealth(ctx.deps, runtimeUrl);
  if (health?.status !== "ok" || health.hostId !== host.hostId) return undefined;
  return {
    name: ctx.name,
    home: ctx.paths.root,
    runtimeUrl,
    adminUrl: persisted.adminPort
      ? `http://${STACK_CLIENT_HOST}:${persisted.adminPort}`
      : runtimeUrl,
    hostId: host.hostId,
    adminKey,
    studioPort: persisted.studioPort,
    studioUrl: studioOrigin(persisted.studioPort),
    studioUp,
    started: false,
  };
}

async function ensureSelected(ctx: Context, options: { studio: boolean }): Promise<StackEndpoints> {
  await dockerPreflight(ctx.deps.docker);
  const running = await runningStack(ctx, options);
  if (running) return running;
  const runtimeWasUp = isUp(
    existsSync(ctx.paths.compose) ? await composePs(ctx) : [],
    "runtime",
  );
  const started = await bringUp(ctx, options);
  return {
    name: ctx.name,
    home: ctx.paths.root,
    runtimeUrl: started.runtimeUrl,
    adminUrl: started.adminUrl,
    hostId: started.hostId,
    adminKey: started.adminKey,
    studioPort: started.studioPort,
    studioUrl: started.studioUrl,
    studioUp: started.studioStarted,
    started: !runtimeWasUp,
  };
}

/** The running Tenant's API, reached with an operator key (`nylorun sandbox`). */
export interface TenantApi {
  /** The Tenant's name. */
  name: string;
  runtimeUrl: string;
  /**
   * The linked project's key (`.nylorun/credentials.json`) when it reaches the Tenant, else
   * the operator key `cli` the Host root keeps (`cli-credentials.json`).
   */
  applicationKey: string;
}

/** The selected Tenant's Admin API while it runs: `nylorun key` and `runningTenantApi`. */
export interface RunningAdmin extends AdminEndpoint {
  /** The Tenant's name. */
  name: string;
  runtimeUrl: string;
  paths: StackPaths;
}

async function runningSelected(
  deps: StackDeps,
  options: { name?: string },
): Promise<{ ctx: Context; admin: RunningAdmin }> {
  const ctx = await selectStack(deps, options);
  requireStackFiles(ctx);
  await dockerPreflight(deps.docker);
  const running = await runningStack(ctx, { studio: false });
  if (!running)
    throw new CliError(`Tenant ${ctx.name} is not running. Run "nylorun start" first.`, 3);
  const tenant = await fetchTenant(deps, running.adminUrl, running.adminKey);
  if (!tenant?.id || tenant.state !== "open")
    throw new CliError(`Tenant ${ctx.name} is not open. See "nylorun status".`, 7);
  return {
    ctx,
    admin: {
      name: ctx.name,
      runtimeUrl: running.runtimeUrl,
      paths: ctx.paths,
      fetch: deps.fetch,
      adminUrl: running.adminUrl,
      adminKey: running.adminKey,
    },
  };
}

/**
 * The selected Tenant's Admin API while it runs; exit 3 when it is not running, 7 when it is
 * not open.
 */
export async function runningAdmin(
  deps: StackDeps,
  options: { name?: string } = {},
): Promise<RunningAdmin> {
  return (await runningSelected(deps, options)).admin;
}

/**
 * The selected Tenant's API while it runs: commands that read or change the Tenant's data never
 * start it. Exit 3 when it is not running, 7 when it is not open.
 */
export async function runningTenantApi(
  deps: StackDeps,
  options: { name?: string } = {},
): Promise<TenantApi> {
  const { ctx, admin } = await runningSelected(deps, options);
  if (ctx.projectDir && ctx.link?.format === 3 && ctx.link.tenant === ctx.name) {
    const project = await readCredentialsFile(credentialsPath(ctx.projectDir));
    if (project && (await keyAuthenticates(deps.fetch, admin.runtimeUrl, project.applicationKey)))
      return { name: ctx.name, runtimeUrl: admin.runtimeUrl, applicationKey: project.applicationKey };
  }
  const key = await hostKey({
    admin,
    runtimeUrl: admin.runtimeUrl,
    id: CLI_KEY_ID,
    file: ctx.paths.cliCredentials,
    lock: ctx.paths.keysLock,
  });
  return { name: ctx.name, runtimeUrl: admin.runtimeUrl, applicationKey: key.applicationKey };
}

/**
 * Start the selected Tenant unless it is already running (`nylorun studio`): the
 * `start` code path without its output, its Tenant wait or the Project link. Compose
 * progress still streams, since the first run pulls images.
 */
export async function ensureStack(
  deps: StackDeps,
  options: { studio: boolean; name?: string },
): Promise<StackEndpoints> {
  return await ensureSelected(
    await selectStack(deps, options.name === undefined ? {} : { name: options.name }),
    options,
  );
}

/** A started Tenant as `nylorun sandbox` sees it. */
export interface SelectedTenant {
  name: string;
  paths: StackPaths;
  project: string;
  /** `docker compose` arguments for this Tenant's project and files. */
  compose(...args: string[]): string[];
}

/** The Tenant `nylorun sandbox` acts on; it must have been started once. */
export async function selectTenant(
  deps: StackDeps,
  options: { name?: string } = {},
): Promise<SelectedTenant> {
  await tidyMachine(deps);
  const ctx = await selectStack(deps, options);
  requireStackFiles(ctx);
  return {
    name: ctx.name,
    paths: ctx.paths,
    project: ctx.project,
    compose: (...args) => composeArgs(ctx, ...args),
  };
}

/**
 * Rewrite the Tenant's Compose files with `sandboxes` set (an object) or removed (null),
 * and bring it up again: Compose recreates the containers whose settings changed.
 */
export async function restartTenant(
  deps: StackDeps,
  options: { name?: string; sandboxes: SandboxStackEnv | null },
): Promise<void> {
  const ctx = await selectStack(deps, options.name === undefined ? {} : { name: options.name });
  await dockerPreflight(deps.docker);
  await bringUp(ctx, { studio: false, sandboxes: options.sandboxes });
}

/** Ports every Tenant on this machine keeps for sandboxes, but the one under `except`. */
export async function reservedSandboxPorts(deps: StackDeps, except: string): Promise<Set<number>> {
  const reserved = await tenantPorts(nylorunRoot(deps), except);
  for (const tenant of await listTenants(nylorunRoot(deps))) {
    if (resolve(tenant.root) === except) continue;
    const sandboxes = (await readStackEnv(stackPaths(tenant.root)))?.sandboxes;
    for (const port of [sandboxes?.harnessPort, sandboxes?.gatesPort, sandboxes?.egressPort])
      if (port !== undefined) reserved.add(port);
  }
  return reserved;
}

/** Add Studio's `next` path (e.g. `/tenants/<id>`) to a login URL. */
export function withNext(loginUrl: string, next: string | undefined): string {
  if (!next) return loginUrl;
  const url = new URL(loginUrl);
  url.searchParams.set("next", next);
  return url.toString();
}

/** The Tenant's Studio page, as a login `next` path. */
export function tenantStudioPath(tenantId: string): string {
  return `/tenants/${encodeURIComponent(tenantId)}`;
}

/**
 * Mint a fresh Studio login URL on a running Tenant, landing on `next`.
 * Undefined (after a warning) when Studio does not answer.
 */
export async function studioLoginUrl(
  deps: StackDeps,
  running: Pick<StackEndpoints, "studioPort" | "adminKey">,
  next?: string,
): Promise<string | undefined> {
  const login = await tryStudioLogin({ deps }, running.studioPort, running.adminKey);
  return login === undefined ? undefined : withNext(login, next);
}

async function studio(
  deps: StackDeps,
  args: readonly string[],
  options: { next?: string } = {},
): Promise<number> {
  const usage = "nylorun studio [--tenant <name>] [--no-open]";
  const flags = parseStackFlags(args, { booleans: ["--no-open"], values: ["--tenant"] }, usage);
  if (flags.rest.length) throw usageError(`Usage: ${usage}`);
  const ctx = await selectStack(deps, nameOption(flags));
  const running = await ensureSelected(ctx, { studio: true });
  if (running.started) deps.out(`Runtime   ${running.runtimeUrl}`);
  if (!running.studioUp)
    throw new CliError(`Studio did not start. See "nylorun logs studio".`, 7);
  // Studio serves the one Tenant; the link's Tenant id stands in while it is opening.
  let next = options.next;
  if (next === undefined) {
    const tenant = await fetchTenant(deps, running.adminUrl, running.adminKey);
    const linked =
      ctx.link?.tenant === ctx.name ? ctx.link.tenantId : undefined;
    const tenantId = tenant?.id ?? linked;
    if (tenantId) next = tenantStudioPath(tenantId);
  }
  const login = await studioLoginUrl(deps, running, next);
  if (!login) return 1;
  if (flags.booleans.has("--no-open")) {
    deps.out(`Studio    ${login}`);
    return 0;
  }
  const origin = new URL(login).origin;
  deps.out(`Studio    ${next ? new URL(next, origin).toString() : origin}`);
  await openLogin({ deps }, login);
  return 0;
}

/** `nylorun studio`, landing on `next` when given, else on the Tenant's page. */
export async function runStudioCommand(
  args: readonly string[],
  deps: StackDeps,
  options: { next?: string } = {},
): Promise<number> {
  await tidyMachine(deps);
  return await studio(deps, args, options);
}

const COMMANDS: Record<string, (deps: StackDeps, args: readonly string[]) => Promise<number>> = {
  start,
  stop,
  // Docker Compose spellings.
  up: start,
  down: stop,
  status,
  logs,
  reset,
  studio: (deps, args) => studio(deps, args),
  ls,
  delete: deleteStack,
};

export function isStackCommand(name: string | undefined): boolean {
  return name !== undefined && Object.hasOwn(COMMANDS, name);
}

/** Run one Tenant command (`up`/`start`, `down`/`stop`, `status`, `logs`, `reset`, `studio`, `ls`, `delete`). */
export async function runStackCommand(
  name: string,
  args: readonly string[],
  deps: StackDeps,
): Promise<number> {
  const command = COMMANDS[name];
  if (!command) throw usageError(`Unknown command ${name}.\n${stackUsage}`);
  await tidyMachine(deps);
  return await command(deps, args);
}
