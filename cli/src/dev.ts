import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { createAdmin, type Admin } from "@nylorun/admin";
import { baselineEnv } from "./baseline.js";
import { loadProjectEnvironment } from "./environment.js";
import { CliError } from "./errors.js";
import { attachProject } from "./project/attach.js";
import { defaultTenantName } from "./project/create-tenant.js";
import { seedTenantFromProject } from "./project/seed.js";
import { requireProjectRoot } from "./project/root.js";
import {
  defaultStackDeps,
  ensureStack,
  studioLoginUrl,
  tenantStudioPath,
  type StackDeps,
} from "./stack/index.js";

const DEV_FLAGS = ["--ephemeral", "--no-studio", "--no-open"] as const;
const DEV_USAGE =
  "Usage: nylorun dev [entry] [--ephemeral] [--no-studio] [--no-open]\nDefault entry: src/main.ts";

/** The Host feature `--ephemeral` needs: the Tenant-level fixture model. */
export const FIXTURE_MODEL_FEATURE = "tenant-fixture-model";

export const LOCAL_UI_REMOVED =
  "--local-ui was removed: Studio runs in the stack's studio container. Run nylorun studio, or nylorun dev to open it on the Project's Tenant.";

export interface DevelopOptions {
  entry?: string;
  flags?: readonly string[];
  projectRoot?: string;
  /** Environment snapshot for the stack (NYLORUN_HOME, image overrides). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Stack dependencies (tests). Default: docker on PATH, fetch, the terminal. */
  stack?: StackDeps;
  /** The Admin API client for the stack's Host root (tests). Default: `createAdmin({ home })`. */
  admin?: (home: string) => Admin;
}

export type DevelopmentPreflight = {
  tsx: string;
  entry: string;
  ephemeral: boolean;
  /** Start Studio with the stack and print a login URL for the Tenant. */
  studio: boolean;
  /** Open that login URL in the browser. */
  open: boolean;
};

/**
 * Everything that can be checked without contacting the stack, so a Project
 * that cannot run never causes the stack to be started on its behalf.
 */
export function developmentPreflight(
  args: readonly string[] = [],
): DevelopmentPreflight {
  const flags: string[] = [];
  let entry: string | undefined;
  for (const arg of args) {
    if ((DEV_FLAGS as readonly string[]).includes(arg)) {
      flags.push(arg);
      continue;
    }
    if (arg === "--local-ui") throw new CliError(LOCAL_UI_REMOVED, 2);
    if (arg.startsWith("-") || entry !== undefined)
      throw new CliError(DEV_USAGE, 2);
    entry = arg;
  }
  if (new Set(flags).size !== flags.length) throw new CliError(DEV_USAGE, 2);
  const require = createRequire(join(process.cwd(), "package.json"));
  let tsx: string;
  try {
    tsx = require.resolve("tsx/cli");
  } catch {
    throw new Error("Install tsx to use nylorun dev");
  }
  const studio = !flags.includes("--no-studio");
  return {
    tsx,
    entry: entry ?? "src/main.ts",
    ephemeral: flags.includes("--ephemeral"),
    studio,
    open: studio && !flags.includes("--no-open"),
  };
}

/**
 * `nylorun dev [entry]` (D§12, architecture §14.2):
 * 1. start the Docker stack unless it is running;
 * 2. create the Project's Tenant on first run (or check the Project link);
 * 3. seed Tenant settings from `.env`;
 * 4. open Studio on the Tenant through a fresh login URL;
 * 5. run `tsx watch <entry>` with the three Project environment variables.
 *
 * With `--ephemeral`, steps 2–3 use a temporary Tenant with the fixture model
 * instead, deleted on exit (`developEphemeral`).
 */
export async function develop(options: DevelopOptions = {}): Promise<number> {
  const projectRoot = options.projectRoot ?? requireProjectRoot();
  const previous = process.cwd();
  process.chdir(projectRoot);
  let preflight: DevelopmentPreflight;
  try {
    preflight = developmentPreflight([
      ...(options.entry ? [options.entry] : []),
      ...(options.flags ?? []),
    ]);
  } finally {
    process.chdir(previous);
  }

  const deps = options.stack ?? defaultStackDeps(options.env ?? baselineEnv());
  const stack = await ensureStack(deps, { studio: preflight.studio });
  if (preflight.ephemeral)
    return developEphemeral({
      projectRoot,
      preflight,
      deps,
      stack,
      admin: (options.admin ?? ((home) => createAdmin({ home })))(stack.home),
    });

  const attached = await attachProject({
    projectRoot,
    host: {
      home: stack.home,
      url: stack.runtimeUrl,
      hostId: stack.hostId,
      started: stack.started,
    },
  });
  const envMap = loadProjectEnvironment(projectRoot);
  await seedTenantFromProject({
    hostUrl: attached.link.hostUrl,
    tenantId: attached.link.tenantId,
    applicationKey: attached.credentials.applicationKey,
    projectRoot,
    env: envMap,
  });

  let studioUrl: string | undefined;
  if (preflight.studio) {
    if (stack.studioUp)
      studioUrl = await studioLoginUrl(
        deps,
        stack,
        tenantStudioPath(attached.link.tenantId),
      );
    else deps.err(`Studio is not running; see "nylorun logs studio".`);
  }

  return spawnWatcher({
    projectRoot,
    entry: preflight.entry,
    tsx: preflight.tsx,
    envMap,
    hostUrl: attached.link.hostUrl,
    tenantId: attached.link.tenantId,
    applicationKey: attached.credentials.applicationKey,
    tenantName: attached.tenantName,
    ...(attached.created ? { tenantNote: "(created)" } : {}),
    hostStarted: attached.hostStarted,
    ...(studioUrl ? { studioUrl } : {}),
    open: preflight.open ? (url) => deps.openBrowser(url) : undefined,
  });
}

type Stack = Awaited<ReturnType<typeof ensureStack>>;

/**
 * `nylorun dev --ephemeral`: the same watcher on a temporary Tenant of the
 * running stack. The Tenant is created through the Admin API (no Project link
 * or credentials are written), seeded from the Project with the Tenant-level
 * fixture model (no model credential needed or sent), opened in Studio, and
 * deleted when the watcher ends, cancelling its active work, also on Ctrl-C.
 */
async function developEphemeral(input: {
  projectRoot: string;
  preflight: DevelopmentPreflight;
  deps: StackDeps;
  stack: Stack;
  admin: Admin;
}): Promise<number> {
  const { projectRoot, preflight, deps, stack, admin } = input;
  const hostUrl = stack.runtimeUrl.replace(/\/$/, "");
  await requireHostFeature(deps, hostUrl, FIXTURE_MODEL_FEATURE);

  // From here on a signal ends in the finally block that deletes the Tenant.
  let stopping: NodeJS.Signals | undefined;
  const interrupt = () => (stopping ??= "SIGINT");
  const terminate = () => (stopping ??= "SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  const stopped = () => (stopping === "SIGINT" ? 130 : 143);
  try {
    let created: Awaited<ReturnType<Admin["createTenant"]>>;
    try {
      created = await admin.createTenant({
        name: `${await defaultTenantName(projectRoot)} (ephemeral)`,
      });
    } catch (error) {
      throw new CliError(
        `Could not create a temporary Tenant: ${error instanceof Error ? error.message : String(error)}`,
        1,
      );
    }
    const tenantId = created.tenant.id;
    try {
      if (stopping) return stopped();
      const envMap = loadProjectEnvironment(projectRoot);
      await seedTenantFromProject({
        hostUrl,
        tenantId,
        applicationKey: created.applicationKey,
        projectRoot,
        env: envMap,
        fixtureModel: true,
      });
      let studioUrl: string | undefined;
      if (preflight.studio) {
        if (stack.studioUp)
          studioUrl = await studioLoginUrl(deps, stack, tenantStudioPath(tenantId));
        else deps.err(`Studio is not running; see "nylorun logs studio".`);
      }
      if (stopping) return stopped();
      return await spawnWatcher({
        projectRoot,
        entry: preflight.entry,
        tsx: preflight.tsx,
        envMap,
        hostUrl,
        tenantId,
        applicationKey: created.applicationKey,
        tenantName: created.tenant.name,
        tenantNote: "(temporary, fixture model; deleted on exit)",
        hostStarted: stack.started,
        ...(studioUrl ? { studioUrl } : {}),
        open: preflight.open ? (url) => deps.openBrowser(url) : undefined,
      });
    } finally {
      try {
        await admin.deleteTenant(tenantId, { activeWork: "cancel" });
        deps.err(`Deleted temporary Tenant ${tenantId}.`);
      } catch (error) {
        deps.err(
          `Could not delete temporary Tenant ${tenantId}: ${error instanceof Error ? error.message : String(error)}. Delete it with: nylorun tenant delete ${tenantId} --yes`,
        );
      }
    }
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}

/** Fails unless the running Runtime advertises `feature` on `/health`. */
async function requireHostFeature(
  deps: StackDeps,
  hostUrl: string,
  feature: string,
): Promise<void> {
  let features: unknown;
  let version: unknown;
  try {
    const response = await deps.fetch(`${hostUrl}/health`, {
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
    });
    const body = (await response.json()) as {
      version?: unknown;
      protocol?: { features?: unknown };
    };
    features = body.protocol?.features;
    version = body.version;
  } catch {
    /* reported below */
  }
  if (Array.isArray(features) && features.includes(feature)) return;
  throw new CliError(
    `The running Runtime${typeof version === "string" ? ` (${version})` : ""} does not support nylorun dev --ephemeral (Host feature ${feature}). Restart the stack on this CLI's Runtime: nylorun stop, then nylorun start.`,
    1,
  );
}

async function spawnWatcher(options: {
  projectRoot: string;
  entry: string;
  tsx: string;
  envMap: Record<string, string>;
  hostUrl: string;
  tenantId: string;
  applicationKey: string;
  tenantName: string;
  /** Shown after the Tenant id, e.g. "(created)". */
  tenantNote?: string;
  hostStarted: boolean;
  studioUrl?: string;
  open: ((url: string) => Promise<void>) | undefined;
}): Promise<number> {
  const entryPath = resolve(options.projectRoot, options.entry);
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.envMap,
    NYLORUN_RUNTIME_URL: options.hostUrl,
    NYLORUN_TENANT: options.tenantId,
    NYLORUN_SERVER_KEY: options.applicationKey,
  };

  // Handle signals before the banner: a supervisor may stop us as soon as it
  // reads it, and an unhandled SIGTERM would kill this process and orphan the
  // detached watcher.
  let child: ReturnType<typeof spawn> | undefined;
  let stopping: NodeJS.Signals | undefined;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = signal;
    child?.kill(signal);
  };
  const interrupt = () => stop("SIGINT");
  const terminate = () => stop("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    printBanner(options);
    if (options.studioUrl && options.open) await options.open(options.studioUrl);
    if (stopping) return stopping === "SIGINT" ? 130 : 143;

    const watcher = spawn(
      process.execPath,
      [options.tsx, "watch", "--clear-screen=false", entryPath],
      {
        cwd: options.projectRoot,
        stdio: "inherit",
        env: childEnv,
        detached: true,
      },
    );
    child = watcher;
    return await new Promise<number>((resolvePromise, reject) => {
      watcher.once("error", reject);
      watcher.once("exit", (code, signal) =>
        resolvePromise(code ?? (signal === "SIGINT" ? 130 : 143)),
      );
    });
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}

function printBanner(options: {
  hostUrl: string;
  hostStarted: boolean;
  tenantName: string;
  tenantId: string;
  tenantNote?: string;
  entry: string;
  studioUrl?: string;
}): void {
  const hostNote = options.hostStarted ? "(started; stays running)" : "(already running)";
  const short =
    options.tenantId.length > 12
      ? `${options.tenantId.slice(0, 12)}…`
      : options.tenantId;
  console.log(`Runtime       ${options.hostUrl}  ${hostNote}`);
  console.log(
    `Tenant        ${options.tenantName}  ${short}${options.tenantNote ? `  ${options.tenantNote}` : ""}`,
  );
  console.log(`Entry         ${options.entry}`);
  if (options.studioUrl) {
    console.log(`Studio        ${options.studioUrl}`);
    console.log(`              (single-use login; nylorun studio opens a fresh one)`);
  }
  console.log("");
  console.log("Ctrl-C stops this Project only. nylorun stop stops the stack.");
}
