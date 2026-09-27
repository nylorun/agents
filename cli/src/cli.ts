#!/usr/bin/env node
import "./runtime/baseline.js";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  ConfigurationCancelled,
  configureProvider,
  fetchModelCatalog,
} from "./model/configure.js";
import { putHostModel } from "./model/host-model.js";
import { develop, developmentPreflight, startStudio } from "./dev.js";
import { CliError } from "./errors.js";
import { runtimeCommand, runtimeUsage } from "./runtime/commands.js";
import { findProjectRoot, requireProjectRoot } from "./project/root.js";
import { printLinkedEnvExports } from "./project/attach.js";
import { readLink as readProjectLink } from "./project/link.js";
import { readCredentials as readProjectCredentials } from "./project/credentials.js";
import { tenantCommand } from "./tenant/commands.js";
import { resolveHome } from "./runtime/launcher.js";
import { baselineEnv } from "./runtime/baseline.js";
import { isStackCommand, stackCommand, stackUsage } from "./stack/index.js";

const usage = `nylorun <start|stop|status|reset|stack|runtime|up|down|logs|dev|studio|configure|doctor|tenant>

Local stack (Docker Compose):
${stackUsage}

${runtimeUsage}

  dev [entry] [--ephemeral] [--local-ui] [--no-studio] [--no-open]
  studio [--local-ui] [--port <n>] [--no-open]
  configure
  doctor runtime [--json]  check the prerequisites: Node 24+ and an installed Runtime
  doctor sandbox [--json]  show which sandbox backend this Tenant's Host offers
  tenant current|list [--json]|use <name-or-id>|status [--json]|reset|delete`;

interface Flags {
  rest: string[];
  booleans: Set<string>;
  values: Map<string, string>;
}

function parseFlags(
  args: readonly string[],
  allowed: { booleans?: readonly string[]; values?: readonly string[] } = {},
): Flags {
  const booleans = new Set<string>();
  const values = new Map<string, string>();
  const rest: string[] = [];
  const booleanNames = new Set(allowed.booleans ?? []);
  const valueNames = new Set(allowed.values ?? []);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("-")) {
      rest.push(arg);
      continue;
    }
    if (arg === "--global" || arg === "--db") {
      throw usageError(
        `${arg} was removed. Use the Runtime Host root (NYLORUN_HOME) and a Project link instead.`,
      );
    }
    if (booleanNames.has(arg)) {
      if (booleans.has(arg)) throw usageError(`${arg} may only be supplied once.`);
      booleans.add(arg);
      continue;
    }
    if (valueNames.has(arg)) {
      if (values.has(arg)) throw usageError(`${arg} may only be supplied once.`);
      const value = args[++index];
      if (!value || value.startsWith("-"))
        throw usageError(`${arg} requires a value.`);
      values.set(arg, value);
      continue;
    }
    throw usageError(usage);
  }
  return { rest, booleans, values };
}

const usageError = (message: string) => new CliError(message, 2);

function parsePort(value: string | undefined): number {
  if (value === undefined || !/^\d+$/u.test(value))
    throw usageError(`Invalid --port: ${value ?? "(missing)"}`);
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw usageError(`Invalid --port: ${value}`);
  return port;
}

async function resolveLinkedAuth(projectRoot: string): Promise<{
  url: string;
  key: string;
  tenantId: string;
  tenantName: string;
}> {
  const link = await readProjectLink(projectRoot);
  const credentials = await readProjectCredentials(projectRoot);
  if (link && credentials) {
    return {
      url: link.hostUrl,
      key: credentials.applicationKey,
      tenantId: link.tenantId,
      tenantName: link.tenantId,
    };
  }
  const url = process.env.NYLORUN_RUNTIME_URL?.trim();
  const key = process.env.NYLORUN_SERVER_KEY?.trim();
  const tenantId = process.env.NYLORUN_TENANT?.trim();
  if (url && key && tenantId) {
    return { url, key, tenantId, tenantName: tenantId };
  }
  throw new CliError(
    `No Project link in ${projectRoot}. Run nylorun dev, or set NYLORUN_RUNTIME_URL, NYLORUN_SERVER_KEY and NYLORUN_TENANT.`,
    1,
  );
}

async function main() {
  const [rawCommand, ...rawArgs] = process.argv.slice(2);
  if (!rawCommand || rawCommand === "--help" || rawCommand === "-h")
    return void console.log(usage);
  if (process.platform === "win32")
    throw new CliError(
      "Nylorun does not run on native Windows. Use WSL2: install Node 24 and the Nylorun Runtime inside your WSL distribution and run nylorun there (https://learn.microsoft.com/windows/wsl/install).",
      1,
    );
  const aliases: Record<string, string> = {
    up: "up",
    down: "down",
    logs: "logs",
  };
  const command = rawCommand in aliases ? "runtime" : rawCommand;
  const args =
    rawCommand in aliases ? [aliases[rawCommand]!, ...rawArgs] : rawArgs;

  if (command === "tenant") return await tenantCommand(args);

  // The Docker Compose stack. `logs` and `studio` still name the launcher and
  // in-process Studio at the top level until Wave 4, so the stack's versions
  // live under `nylorun stack logs|studio` for now.
  if (["start", "stop", "status", "reset"].includes(command)) {
    process.exitCode = await stackCommand(command, args, baselineEnv());
    return;
  }
  if (command === "stack") {
    const [name, ...rest] = args;
    if (!isStackCommand(name)) throw usageError(usage);
    process.exitCode = await stackCommand(name!, rest, baselineEnv());
    return;
  }

  if (command === "runtime") {
    // F2-7: envHook prints the linked Project's three variables.
    return await runtimeCommand(args, {
      envHook: async () => {
        const root = findProjectRoot() ?? process.cwd();
        await printLinkedEnvExports(root);
      },
    });
  }

  if (command === "doctor") {
    const [topic, ...options] = args;
    if (
      (topic !== "sandbox" && topic !== "runtime") ||
      options.some((option) => option !== "--json")
    )
      throw usageError("Usage: nylorun doctor runtime|sandbox [--json]");
    const { doctorRuntime, doctorSandbox } = await import("./doctor.js");
    const json = options.includes("--json");
    if (topic === "runtime") await doctorRuntime({ json });
    else await doctorSandbox({ json });
    return;
  }

  if (command === "dev") {
    const flags = parseFlags(args, {
      booleans: ["--ephemeral", "--local-ui", "--no-studio", "--no-open"],
    });
    if (flags.rest.length > 1) throw usageError(usage);
    if (flags.booleans.has("--local-ui") && flags.booleans.has("--no-studio"))
      throw usageError("--local-ui cannot be combined with --no-studio.");
    requireProjectRoot();
    developmentPreflight([
      ...flags.rest,
      ...[...flags.booleans],
    ]);
    process.exitCode = await develop({
      ...(flags.rest[0] ? { entry: flags.rest[0] } : {}),
      flags: [...flags.booleans],
    });
    return;
  }

  if (command === "serve") {
    throw usageError(
      "nylorun serve was removed. Use nylorun dev [entry] in development, or node dist/src/main.js with NYLORUN_RUNTIME_URL, NYLORUN_TENANT and NYLORUN_SERVER_KEY.",
    );
  }

  if (command === "studio") {
    const flags = parseFlags(args, {
      booleans: ["--local-ui", "--no-open"],
      values: ["--port"],
    });
    if (flags.rest.length) throw usageError(usage);
    const projectRoot = findProjectRoot() ?? process.cwd();
    // Surface missing Studio early with the same Install message as preflight.
    try {
      createRequire(join(projectRoot, "package.json")).resolve("@nylorun/studio");
    } catch {
      throw new Error("Install @nylorun/studio to use the Studio dashboard.");
    }
    const auth = await resolveLinkedAuth(projectRoot);
    const localUi = flags.booleans.has("--local-ui");
    // I2: startStudio default is hosted; `--local-ui` forces local + cacheDir.
    const dashboard = await startStudio({
      runtimeUrl: auth.url,
      serverKey: auth.key,
      tenant: { id: auth.tenantId, name: auth.tenantName },
      open: !flags.booleans.has("--no-open"),
      localUi,
      cacheDir: resolveHome(),
      projectRoot,
      ...(flags.values.has("--port")
        ? { port: parsePort(flags.values.get("--port")) }
        : {}),
    });
    console.log(`Studio        ${dashboard.launchUrl}`);
    if (!localUi && dashboard.launchUrl.startsWith("https://local.nylorun.studio")) {
      console.log(`Safari or offline: nylorun studio --local-ui`);
    }
    await new Promise<void>((resolve, reject) => {
      const close = () => void dashboard.close().then(resolve, reject);
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
    });
    return;
  }

  if (command === "configure") {
    const flags = parseFlags(args);
    if (flags.rest.length) throw usageError(usage);
    const projectRoot = findProjectRoot() ?? process.cwd();
    const auth = await resolveLinkedAuth(projectRoot);
    const controller = new AbortController();
    const cancel = (signal: "SIGINT" | "SIGTERM") =>
      controller.abort(new ConfigurationCancelled(signal));
    process.once("SIGINT", () => cancel("SIGINT"));
    process.once("SIGTERM", () => cancel("SIGTERM"));
    const health = await fetch(`${auth.url}/health`).catch(() => undefined);
    if (!health?.ok)
      throw new CliError(
        `No Runtime Host is listening at ${auth.url}. Start one with "nylorun runtime up".`,
        6,
      );
    const catalog = await fetchModelCatalog({
      url: auth.url,
      key: auth.key,
      tenantId: auth.tenantId,
    });
    const prompted = await configureProvider({
      signal: controller.signal,
      catalog,
    });
    await putHostModel(auth.url, auth.key, prompted, auth.tenantId);
    return;
  }

  throw usageError(usage);
}

async function finish(code: number): Promise<never> {
  process.exitCode = code;
  for (const stream of [process.stdout, process.stderr])
    await new Promise<void>((resolve) => stream.write("", () => resolve()));
  process.exit(code);
}

void main().then(
  () => finish(process.exitCode === undefined ? 0 : Number(process.exitCode)),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    return finish(
      error instanceof ConfigurationCancelled || error instanceof CliError
        ? error.exitCode
        : 1,
    );
  },
);
