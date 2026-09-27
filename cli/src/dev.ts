import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { baselineEnv } from "./baseline.js";
import { loadProjectEnvironment } from "./environment.js";
import { CliError } from "./errors.js";
import { attachProject } from "./project/attach.js";
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

/** `--ephemeral` until Wave 4a adds a Tenant-level fixture model to the Runtime. */
export const EPHEMERAL_UNSUPPORTED =
  "nylorun dev --ephemeral is not supported yet on the Docker stack; coming in this release. Run nylorun dev without it.";

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

  if (preflight.ephemeral) {
    // Wave 4a plugs `--ephemeral` in here, once the Runtime has a Tenant-level
    // fixture model: ensureStack (below), then `admin.createTenant` for a
    // temporary Tenant with that fixture-model setting (no Project link
    // written), seedTenantFromProject, the Studio login on that Tenant,
    // spawnWatcher, and `admin.deleteTenant` in a finally block on exit.
    throw new CliError(EPHEMERAL_UNSUPPORTED, 2);
  }

  const deps = options.stack ?? defaultStackDeps(options.env ?? baselineEnv());
  const stack = await ensureStack(deps, { studio: preflight.studio });
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
    tenantCreated: attached.created,
    hostStarted: attached.hostStarted,
    ...(studioUrl ? { studioUrl } : {}),
    open: preflight.open ? (url) => deps.openBrowser(url) : undefined,
  });
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
  tenantCreated: boolean;
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
  tenantCreated: boolean;
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
    `Tenant        ${options.tenantName}  ${short}${options.tenantCreated ? "  (created)" : ""}`,
  );
  console.log(`Entry         ${options.entry}`);
  if (options.studioUrl) {
    console.log(`Studio        ${options.studioUrl}`);
    console.log(`              (single-use login; nylorun studio opens a fresh one)`);
  }
  console.log("");
  console.log("Ctrl-C stops this Project only. nylorun stop stops the stack.");
}
