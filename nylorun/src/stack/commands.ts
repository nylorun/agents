import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  compareVersions,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
} from "@nylorun/core/compatibility";
import type { HostTenant } from "@nylorun/core/contracts";
import { CliError } from "../errors.js";
import { deriveTenantKey, PROJECT_PRINCIPAL_ID } from "../project/derived-key.js";
import {
  readProjectCredentials,
  readProjectLink,
  writeProjectCredentials,
  writeProjectLink,
  type ProjectLink,
} from "../project/link.js";
import { findProjectRoot } from "../project/root.js";
import { seedTenant } from "../project/seed.js";
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
import {
  assertStackName,
  chooseStackName,
  defaultNylorunRoot,
  LEGACY_ENTRIES,
  legacyStack,
  listStacks,
  readStackRecord,
  sanitizeStackName,
  stackRoot,
  stacksDir,
  writeStackRecord,
  type LegacyStack,
} from "./stacks.js";
import { mintStudioLogin, studioOrigin, type FetchLike } from "./studio-login.js";

export const STACK_SERVICES = ["postgres", "restate", "s2", "gateway", "runtime", "studio"] as const;
const CORE_SERVICES = ["postgres", "restate", "s2", "gateway", "runtime"] as const;

export const stackUsage = `  up|start [--name <stack>] [--no-link] [--no-studio] [--no-open] [--allow-downgrade] [--studio-embed-origin <origin>]... [--studio-embed-origin-reset]
                                      start the project's stack, creating it, its one Tenant and the Project link
                                      (.nylorun/link.json, credentials.json) on the first run; print the Runtime and Studio URLs
                                      and open Studio signed in (in a terminal). --name attaches to (or creates) a named stack;
                                      --no-link starts a stack without linking the current directory
  down|stop [--name <stack>]          stop the stack's containers; keep volumes
  status [--name <stack>] [--json]    the stack, its Tenant, services, endpoints and Runtime health
  logs [service] [--name <stack>] [-f] [--tail <n>]
                                      stack logs (${STACK_SERVICES.join(", ")})
  studio [--name <stack>] [--no-open] sign a browser in to Studio on the stack's Tenant; --no-open prints the login URL; start the stack if it is stopped
  reset [--name <stack>] [--yes]      delete the stack's volumes and its Tenant directory; the next start creates a new Tenant
  ls [--json]                         the stacks on this machine
  delete <stack> --yes                remove a stack: containers, volumes and its Host root, with the vault key (KEK)
  legacy stop|delete [--yes]          stop or remove the single stack of older releases (Compose project nylorun)`;

export interface StackDeps {
  /** Environment snapshot (NYLORUN_HOME, NYLORUN_STACK, image overrides, NYLORUN_STACK_PROJECT). */
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
  /** `~/.nylorun`: the stacks and the legacy stack (tests use a temporary directory). */
  nylorunRoot?: string;
  /** Delay between health polls; tests shorten it. */
  pollMs?: number;
  /** How long `start` waits for the Runtime's /health, and then its Tenant, after Compose. */
  healthTimeoutMs?: number;
  /** How long a Studio login is retried before warning. */
  loginTimeoutMs?: number;
}

const usageError = (message: string) => new CliError(message, 2);

/** The Compose project of stack `name`: `nylorun-<name>`, or `NYLORUN_STACK_PROJECT`. */
export function stackProject(env: StackDeps["env"], name: string): string {
  const override = env.NYLORUN_STACK_PROJECT?.trim();
  if (!override) return `nylorun-${name}`;
  return assertStackName(override, "NYLORUN_STACK_PROJECT");
}

interface Context {
  deps: StackDeps;
  /** The stack's name (also its Tenant's name). */
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

async function stackNames(deps: StackDeps): Promise<string> {
  const names = (await listStacks(nylorunRoot(deps))).map((stack) => stack.name);
  return names.length ? ` Stacks on this machine: ${names.join(", ")}.` : "";
}

/**
 * Which stack a command acts on: `--name`, then `NYLORUN_STACK`, then the stack of the
 * project's link (format 2); for `start` in a project, then a name from the project
 * directory (`chooseStackName`). `NYLORUN_HOME` sets the Host root whatever the name; its
 * name otherwise comes from its `stack.json`, the project directory or the Host root's own.
 */
async function selectStack(
  deps: StackDeps,
  options: { name?: string; start?: boolean; noLink?: boolean } = {},
): Promise<Context> {
  const { env } = deps;
  const base = nylorunRoot(deps);
  const projectDir = options.noLink ? undefined : findProjectRoot(deps.cwd ?? process.cwd());
  const link = projectDir ? await readProjectLink(projectDir) : undefined;
  const explicit = options.name ?? (env.NYLORUN_STACK?.trim() || undefined);
  if (explicit !== undefined)
    assertStackName(explicit, options.name !== undefined ? "--name" : "NYLORUN_STACK");
  let name = explicit ?? (link?.format === 2 ? link.stack : undefined);
  let root: string;
  const home = env.NYLORUN_HOME?.trim();
  if (home) {
    root = resolve(home);
    name ??=
      (await readStackRecord(root))?.name ??
      sanitizeStackName(basename(projectDir ?? root));
  } else {
    if (name === undefined && options.start && projectDir)
      name = await chooseStackName(base, projectDir);
    if (name === undefined)
      throw usageError(
        options.start
          ? `Not in a project: name the stack with "nylorun start --name <stack>" (or NYLORUN_STACK).${await stackNames(deps)}`
          : `No stack selected: run this in a project "nylorun start" linked, pass --name <stack>, or set NYLORUN_STACK.${await stackNames(deps)}`,
      );
    root = stackRoot(base, name);
  }
  assertStackName(name, "The stack name");
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
      `No Nylorun stack ${ctx.name} under ${ctx.paths.root}. Run "nylorun start" first.`,
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

/** `--name` when given. */
function nameOption(flags: Flags): { name?: string } {
  const name = flags.values.get("--name");
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

/** `/v1/admin/status`'s Tenant on the operator listener; undefined when it does not answer. */
async function fetchTenant(
  deps: StackDeps,
  adminUrl: string,
  adminKey: string | undefined,
): Promise<StackTenant | undefined> {
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
    const tenant = ((await response.json()) as { tenant?: Partial<HostTenant> }).tenant;
    if (!tenant || (tenant.state !== "open" && tenant.state !== "unavailable")) return undefined;
    return {
      id: typeof tenant.id === "string" ? tenant.id : null,
      name: typeof tenant.name === "string" ? tenant.name : null,
      state: tenant.state,
      ...(tenant.cause ? { cause: tenant.cause } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Why the stack's Tenant is unavailable, with the repair the Runtime names. */
function tenantCauseMessage(ctx: Context, tenant: StackTenant): string {
  const cause = tenant.cause!;
  const hint =
    cause.code === "schema-too-new"
      ? ` This nylorun pins Runtime ${ctx.deps.runtimeVersion}, older than the stack's database: update nylorun (npx nylorun@latest start).`
      : "";
  return `The Tenant of stack ${ctx.name} is unavailable (${cause.code}): ${cause.message} ${cause.repair}${hint} See "nylorun logs runtime".`;
}

/**
 * Wait until the stack's Tenant is open: the Runtime creates it on the first start and opens
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
        `The Tenant of stack ${ctx.name} did not open (${adminUrl}/v1/admin/status: ${
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
 * Refuse a Runtime older than the stack's database: the Runtime that last ran the stack
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
      `Warning: starting Runtime ${pinned} on stack ${ctx.name}, which Runtime ${host.runtimeVersion} last ran. If that Runtime migrated the database, the Tenant stays unavailable (schema-too-new).`,
    );
    return;
  }
  throw new CliError(
    `Refusing to start Runtime ${pinned} on stack ${ctx.name}: Runtime ${host.runtimeVersion} last ran it (${ctx.paths.config}), and a Runtime older than the stack's database cannot open its Tenant. Update nylorun (npx nylorun@latest start), or run "nylorun start --allow-downgrade" when both Runtimes use the same database schema.`,
    5,
  );
}

/** Ports other stacks (and the legacy stack) keep in their `.env`, so a new stack avoids them. */
async function reservedPorts(ctx: Context): Promise<Set<number>> {
  const base = nylorunRoot(ctx.deps);
  const roots = (await listStacks(base)).map((stack) => stack.root);
  if (legacyStack(base)) roots.push(base);
  const reserved = new Set<number>();
  for (const root of roots) {
    if (resolve(root) === ctx.paths.root) continue;
    const persisted = await readStackEnv(stackPaths(root));
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

interface Started {
  runtimeUrl: string;
  adminUrl: string;
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
    ...(deps.env.NYLORUN_DERIVED_PRINCIPALS?.trim()
      ? { derivedPrincipals: deps.env.NYLORUN_DERIVED_PRINCIPALS }
      : {}),
    ...(options.studioEmbedOrigins ? { studioEmbedOrigins: options.studioEmbedOrigins } : {}),
  });
  const record = await readStackRecord(ctx.paths.root);
  const project = record?.project ?? ctx.projectDir;
  if (record?.name !== ctx.name || record.project !== project)
    await writeStackRecord(ctx.paths.root, { name: ctx.name, ...(project ? { project } : {}) });
  if (prepared.firstRun)
    deps.err(
      `Created stack ${ctx.name} under ${ctx.paths.root} (Runtime port ${prepared.env.runtimePort}, Studio port ${prepared.env.studioPort}).`,
    );
  const runtimeUrl = `http://${STACK_CLIENT_HOST}:${prepared.env.runtimePort}`;
  const adminUrl = `http://${STACK_CLIENT_HOST}:${prepared.env.adminPort}`;
  const up = await deps.docker.stream(
    composeArgs(ctx, "up", "--detach", "--wait", "--wait-timeout", "300", ...CORE_SERVICES),
  );
  if (up !== 0) {
    // A Runtime whose Tenant cannot open fails readiness; its status names the cause.
    const tenant = await fetchTenant(deps, adminUrl, prepared.adminKey);
    if (tenant?.cause) throw new CliError(tenantCauseMessage(ctx, tenant), 7);
    throw new CliError(
      `docker compose up failed (exit ${up}). See "nylorun logs runtime", "nylorun logs gateway" and "nylorun status".`,
      7,
    );
  }
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
    adminUrl,
    hostId: prepared.host.hostId,
    studioPort: prepared.env.studioPort,
    studioStarted,
    adminKey: prepared.adminKey,
  };
}

async function tryStudioLogin(
  ctx: Pick<Context, "deps">,
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
async function openLogin(ctx: Pick<Context, "deps">, login: string): Promise<void> {
  if (!(await ctx.deps.openBrowser(login))) ctx.deps.out(`Sign in   ${login}`);
}

/** The legacy stack is mentioned once per machine (a marker under `stacks/`). */
async function noteLegacy(deps: StackDeps): Promise<void> {
  const base = nylorunRoot(deps);
  const legacy = legacyStack(base);
  const marker = join(stacksDir(base), ".legacy-noted");
  if (!legacy || existsSync(marker)) return;
  deps.err(
    `Note: the single stack of an older release is still on this machine (Compose project nylorun, Host root ${legacy.root}). Stacks are now one per project, and the old one is left as it is: stop it with "npx nylorun legacy stop", or remove it and its Tenants with "npx nylorun legacy delete --yes".`,
  );
  await mkdir(stacksDir(base), { recursive: true, mode: 0o700 });
  await writeFile(marker, "", { mode: 0o600 });
}

/**
 * Link the project to the stack: `.nylorun/link.json` (format 2) and
 * `.nylorun/credentials.json` with the key of the derived principal `project`. The link is
 * rewritten only when the stack, its URL, Host or Tenant changed; a new link seeds the
 * Tenant from the project's `.env`.
 */
async function linkProject(
  ctx: Context & { projectDir: string },
  started: Started,
  tenantId: string,
): Promise<void> {
  const { deps, projectDir, link } = ctx;
  if (link && link.format < 2)
    deps.err(
      `This project was linked to a Tenant on ${link.hostUrl}, a stack of an older Runtime. It gets its own stack, ${ctx.name}, and a new link; model credentials come from .env (or Studio), and agents register again (npm run dev).`,
    );
  const applicationKey = deriveTenantKey(started.adminKey, tenantId, PROJECT_PRINCIPAL_ID);
  const fresh =
    link?.format !== 2 ||
    link.stack !== ctx.name ||
    link.hostUrl !== started.runtimeUrl ||
    link.hostId !== started.hostId ||
    link.tenantId !== tenantId;
  if (fresh)
    await writeProjectLink(projectDir, {
      stack: ctx.name,
      hostUrl: started.runtimeUrl,
      hostId: started.hostId,
      tenantId,
    });
  const credentials = await readProjectCredentials(projectDir);
  if (
    fresh ||
    credentials?.applicationKey !== applicationKey ||
    credentials.principalId !== PROJECT_PRINCIPAL_ID
  )
    await writeProjectCredentials(projectDir, {
      applicationKey,
      principalId: PROJECT_PRINCIPAL_ID,
    });
  if (!fresh) return;
  deps.err(`Linked ${projectDir} to stack ${ctx.name} (.nylorun/link.json, .nylorun/credentials.json).`);
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
  "nylorun start [--name <stack>] [--no-link] [--no-studio] [--no-open] [--allow-downgrade] [--studio-embed-origin <origin>]... [--studio-embed-origin-reset]";

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
      ],
      values: ["--name"],
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
  await noteLegacy(deps);
  const embedOrigins = flags.lists.get("--studio-embed-origin") ?? [];
  const resetEmbed = flags.booleans.has("--studio-embed-origin-reset");
  const started = await bringUp(ctx, {
    studio: !flags.booleans.has("--no-studio"),
    allowDowngrade: flags.booleans.has("--allow-downgrade"),
    ...(embedOrigins.length || resetEmbed
      ? { studioEmbedOrigins: { add: embedOrigins, reset: resetEmbed } }
      : {}),
  });
  const tenant = await waitForTenant(ctx, started.adminUrl, started.adminKey);
  if (ctx.projectDir) await linkProject({ ...ctx, projectDir: ctx.projectDir }, started, tenant.id);
  deps.out(`Stack     ${ctx.name}  (${ctx.paths.root})`);
  deps.out(`Tenant    ${tenant.id}${tenant.name ? `  (${tenant.name})` : ""}`);
  deps.out(`Runtime   ${started.runtimeUrl}`);
  if (started.studioStarted) {
    deps.out(`Studio    ${studioOrigin(started.studioPort)}`);
    if (opensBrowser(deps, flags)) {
      const login = await tryStudioLogin(ctx, started.studioPort, started.adminKey);
      if (login) await openLogin(ctx, withNext(login, tenantStudioPath(tenant.id)));
    } else deps.err(STUDIO_SIGN_IN_HINT);
  }
  return 0;
}

async function stop(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun stop [--name <stack>]";
  const flags = parseStackFlags(args, { values: ["--name"] }, usage);
  if (flags.rest.length) throw usageError(`Usage: ${usage}`);
  const ctx = await selectStack(deps, nameOption(flags));
  requireStackFiles(ctx);
  await dockerPreflight(deps.docker);
  const code = await deps.docker.stream(composeArgs(ctx, "stop"));
  if (code !== 0) throw new CliError(`docker compose stop failed (exit ${code}).`, 1);
  deps.out(`Stopped stack ${ctx.name}; volumes are kept.`);
  return 0;
}

export interface StackStatus {
  /** The stack's name. */
  name: string;
  /** The Compose project. */
  project: string;
  /** The Host root. */
  home: string;
  state: "running" | "stopped" | "absent";
  runtime: {
    url?: string;
    /** The Admin API (operator listener), when the stack publishes one. */
    adminUrl?: string;
    healthy: boolean;
    version?: string;
    hostId?: string;
  };
  /** The stack's one Tenant, while the Runtime answers. */
  tenant?: StackTenant;
  studio: {
    url?: string;
    state: string;
    /** Exact origins that may show Studio in a frame (Studio §8.9). */
    embedOrigins?: string[];
  };
  restate: { url?: string };
  /** The gateway container (the Model Gate), in the combined packing. */
  gateway: { state: string; healthy: boolean };
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
    restate: {},
    gateway: { state: "absent", healthy: false },
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
  const tenant =
    healthy && adminUrl
      ? await fetchTenant(ctx.deps, adminUrl, await readAdminKey(ctx.paths))
      : undefined;
  const studio = services.find((s) => s.service === "studio");
  const gateway = services.find((s) => s.service === "gateway");
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
    restate: persisted.restatePort
      ? { url: `http://${STACK_CLIENT_HOST}:${persisted.restatePort}` }
      : {},
    gateway: {
      state: gateway ? [gateway.state, gateway.health].filter(Boolean).join(", ") : "absent",
      healthy: isUp(services, "gateway"),
    },
    services,
  };
}

/** What `nylorun status` reports, as data (`nylorun doctor`). */
export async function readStackStatus(
  deps: StackDeps,
  options: { name?: string } = {},
): Promise<StackStatus> {
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
  const usage = "nylorun status [--name <stack>] [--json]";
  const flags = parseStackFlags(args, { booleans: ["--json"], values: ["--name"] }, usage);
  if (flags.rest.length) throw usageError(`Usage: ${usage}`);
  const result = await stackStatus(await selectStack(deps, nameOption(flags)));
  const { out } = deps;
  if (flags.booleans.has("--json")) {
    out(JSON.stringify(result, null, 2));
  } else if (result.state === "absent") {
    out(`Stack       ${result.name} absent (nothing under ${result.home}; run "nylorun start")`);
  } else {
    out(`Stack       ${result.name} ${result.state} (Compose project ${result.project})`);
    out(`Host root   ${result.home} (admin key in host-credentials.json, mode 0600)`);
    if (result.tenant) out(`Tenant      ${describeTenant(result.tenant)}`);
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
  }
  return result.runtime.healthy ? 0 : 3;
}

async function logs(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = `nylorun logs [${STACK_SERVICES.join("|")}] [--name <stack>] [-f] [--tail <n>]`;
  const flags = parseStackFlags(
    args,
    { booleans: ["--follow"], values: ["--tail", "--name"], aliases: { "-f": "--follow" } },
    usage,
  );
  if (flags.rest.length > 1) throw usageError(`Usage: ${usage}`);
  const service = flags.rest[0];
  if (service !== undefined && !(STACK_SERVICES as readonly string[]).includes(service))
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
  const usage = "nylorun reset [--name <stack>] [--yes]";
  const flags = parseStackFlags(
    args,
    { booleans: ["--yes"], values: ["--name"], aliases: { "-y": "--yes" } },
    usage,
  );
  if (flags.rest.length) throw usageError(`Usage: ${usage}`);
  const ctx = await selectStack(deps, nameOption(flags));
  const { paths } = ctx;
  if (!flags.booleans.has("--yes")) {
    const question = `Delete stack ${ctx.name}'s volumes (Compose project ${ctx.project}) and its Tenant directory ${paths.tenant}, with the vault key? Its Tenant's data is lost and the next start creates a new Tenant. [y/N] `;
    if (!deps.confirm)
      throw usageError(
        `nylorun reset deletes stack ${ctx.name}'s Tenant and all its data; pass --yes to confirm when not in a terminal.`,
      );
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
  await rm(paths.tenant, { recursive: true, force: true });
  await mkdir(paths.tenant, { recursive: true, mode: 0o700 });
  deps.out(
    `Reset stack ${ctx.name}: volumes and the Tenant directory deleted. Run "nylorun start" to start again with a new Tenant (it relinks the project).`,
  );
  return 0;
}

interface ListedStack {
  name: string;
  /** The Host root. */
  root: string;
  /** The project directory the stack was created for. */
  project?: string;
  state: "running" | "stopped" | "unknown";
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
  const stacks: ListedStack[] = [];
  for (const entry of await listStacks(base)) {
    const persisted = (await readStackEnv(stackPaths(entry.root))) ?? {};
    stacks.push({
      name: entry.name,
      root: entry.root,
      ...(entry.record?.project ? { project: entry.record.project } : {}),
      state: state(`nylorun-${entry.name}`),
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
  const legacy = legacyStack(base);
  const legacyView = legacy
    ? { root: legacy.root, project: legacy.project, state: state(legacy.project) }
    : undefined;
  if (flags.booleans.has("--json")) {
    deps.out(JSON.stringify({ stacks, ...(legacyView ? { legacy: legacyView } : {}) }, null, 2));
    return 0;
  }
  if (stacks.length === 0)
    deps.out(`No stacks under ${stacksDir(base)}. Run "npx nylorun start" in a project.`);
  else {
    const width = Math.max(4, ...stacks.map((stack) => stack.name.length)) + 2;
    deps.out(`${"NAME".padEnd(width)}${"STATE".padEnd(9)}${"RUNTIME".padEnd(24)}${"STUDIO".padEnd(24)}PROJECT`);
    for (const stack of stacks)
      deps.out(
        `${stack.name.padEnd(width)}${stack.state.padEnd(9)}${(stack.runtimeUrl ?? "-").padEnd(24)}${(stack.studioUrl ?? "-").padEnd(24)}${stack.project ?? "-"}`,
      );
  }
  if (legacyView)
    deps.out(
      `Legacy stack: Compose project nylorun, Host root ${legacyView.root} (${legacyView.state}); "nylorun legacy stop|delete" handles it.`,
    );
  return 0;
}

async function deleteStack(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun delete <stack> --yes";
  const flags = parseStackFlags(args, { booleans: ["--yes"], aliases: { "-y": "--yes" } }, usage);
  const [name, ...extra] = flags.rest;
  if (name === undefined || extra.length) throw usageError(`Usage: ${usage}`);
  assertStackName(name, "The stack name");
  const base = nylorunRoot(deps);
  const ctx = { deps, project: stackProject(deps.env, name), paths: stackPaths(stackRoot(base, name)) };
  if (!existsSync(ctx.paths.root))
    throw new CliError(`No stack ${name} under ${stacksDir(base)}. See "nylorun ls".`, 3);
  if (!flags.booleans.has("--yes"))
    throw usageError(
      `nylorun delete removes stack ${name}: its containers, volumes and Host root ${ctx.paths.root}, with the Tenant's vault key (KEK) and all its data. This cannot be undone; pass --yes to confirm.`,
    );
  await dockerPreflight(deps.docker);
  const files = existsSync(ctx.paths.compose) && existsSync(ctx.paths.env);
  const code = await deps.docker.stream(
    files
      ? composeArgs(ctx, "down", "--volumes", "--remove-orphans")
      : ["compose", "--project-name", ctx.project, "down", "--volumes", "--remove-orphans"],
  );
  if (code !== 0) throw new CliError(`docker compose down failed (exit ${code}).`, 1);
  await rm(ctx.paths.root, { recursive: true, force: true });
  deps.out(`Deleted stack ${name}: its containers, volumes and Host root (vault key included).`);
  return 0;
}

function legacyCompose(legacy: LegacyStack, ...args: string[]): string[] {
  return [
    "compose",
    "--project-name",
    legacy.project,
    "--file",
    legacy.compose,
    "--env-file",
    legacy.env,
    ...args,
  ];
}

async function legacy(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun legacy stop|delete [--yes]";
  const flags = parseStackFlags(args, { booleans: ["--yes"], aliases: { "-y": "--yes" } }, usage);
  const [action, ...extra] = flags.rest;
  if ((action !== "stop" && action !== "delete") || extra.length) throw usageError(`Usage: ${usage}`);
  if (action === "stop" && flags.booleans.has("--yes")) throw usageError(`Usage: ${usage}`);
  const base = nylorunRoot(deps);
  const stack = legacyStack(base);
  if (!stack) {
    deps.out(`No legacy stack under ${base} (no stack/compose.yaml).`);
    return 0;
  }
  if (action === "stop") {
    await dockerPreflight(deps.docker);
    const code = await deps.docker.stream(legacyCompose(stack, "stop"));
    if (code !== 0) throw new CliError(`docker compose stop failed (exit ${code}).`, 1);
    deps.out("Stopped the legacy stack (Compose project nylorun); its volumes are kept.");
    return 0;
  }
  if (!flags.booleans.has("--yes"))
    throw usageError(
      `nylorun legacy delete removes the legacy stack (Compose project nylorun): its containers, volumes, every Tenant on it with their vault keys, and its files under ${base} (${LEGACY_ENTRIES.join(", ")}). ${stacksDir(base)} is kept. Pass --yes to confirm.`,
    );
  await dockerPreflight(deps.docker);
  const code = await deps.docker.stream(legacyCompose(stack, "down", "--volumes", "--remove-orphans"));
  if (code !== 0) throw new CliError(`docker compose down failed (exit ${code}).`, 1);
  for (const entry of LEGACY_ENTRIES) await rm(join(base, entry), { recursive: true, force: true });
  deps.out(`Deleted the legacy stack: its containers, volumes and files under ${base}; ${stacksDir(base)} is kept.`);
  return 0;
}

/** The running stack as clients reach it. */
export interface StackEndpoints {
  /** The stack's name. */
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
  if (!isUp(services, "runtime") || !isUp(services, "gateway")) return undefined;
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
    studioUp: started.studioStarted,
    started: !runtimeWasUp,
  };
}

/**
 * Start the selected stack unless it is already running (`nylorun studio`): the
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

/** Add Studio's `next` path (e.g. `/tenants/<id>`) to a login URL. */
export function withNext(loginUrl: string, next: string | undefined): string {
  if (!next) return loginUrl;
  const url = new URL(loginUrl);
  url.searchParams.set("next", next);
  return url.toString();
}

/** The Studio page of the stack's Tenant, as a login `next` path. */
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
  const login = await tryStudioLogin({ deps }, stack.studioPort, stack.adminKey);
  return login === undefined ? undefined : withNext(login, next);
}

async function studio(
  deps: StackDeps,
  args: readonly string[],
  options: { next?: string } = {},
): Promise<number> {
  const usage = "nylorun studio [--name <stack>] [--no-open]";
  const flags = parseStackFlags(args, { booleans: ["--no-open"], values: ["--name"] }, usage);
  if (flags.rest.length) throw usageError(`Usage: ${usage}`);
  const ctx = await selectStack(deps, nameOption(flags));
  const stack = await ensureSelected(ctx, { studio: true });
  if (stack.started) deps.out(`Runtime   ${stack.runtimeUrl}`);
  if (!stack.studioUp)
    throw new CliError(`Studio did not start. See "nylorun logs studio".`, 7);
  // Studio serves the stack's one Tenant; the link's Tenant id stands in while it is opening.
  let next = options.next;
  if (next === undefined) {
    const tenant = await fetchTenant(deps, stack.adminUrl, stack.adminKey);
    const linked =
      ctx.link?.format === 2 && ctx.link.stack === ctx.name ? ctx.link.tenantId : undefined;
    const tenantId = tenant?.id ?? linked;
    if (tenantId) next = tenantStudioPath(tenantId);
  }
  const login = await studioLoginUrl(deps, stack, next);
  if (!login) return 1;
  if (flags.booleans.has("--no-open")) {
    deps.out(`Studio    ${login}`);
    return 0;
  }
  const origin = studioOrigin(stack.studioPort);
  deps.out(`Studio    ${next ? new URL(next, origin).toString() : origin}`);
  await openLogin({ deps }, login);
  return 0;
}

/** `nylorun studio`, landing on `next` when given, else on the stack's Tenant. */
export async function runStudioCommand(
  args: readonly string[],
  deps: StackDeps,
  options: { next?: string } = {},
): Promise<number> {
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
  legacy,
};

export function isStackCommand(name: string | undefined): boolean {
  return name !== undefined && Object.hasOwn(COMMANDS, name);
}

/** Run one stack command (`up`/`start`, `down`/`stop`, `status`, `logs`, `reset`, `studio`, `ls`, `delete`, `legacy`). */
export async function runStackCommand(
  name: string,
  args: readonly string[],
  deps: StackDeps,
): Promise<number> {
  const command = COMMANDS[name];
  if (!command) throw usageError(`Unknown stack command ${name}.\n${stackUsage}`);
  return await command(deps, args);
}
