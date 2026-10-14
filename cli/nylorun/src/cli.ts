#!/usr/bin/env node
import "./baseline.js";
import { baselineEnv } from "./baseline.js";
import { refuseNativeWindows, runCommand } from "./command.js";
import { CliError } from "./errors.js";
import { defaultStackDeps, stackCommand, stackUsage, studioCommand } from "./stack/index.js";

const usage = `nylorun <command>

The installation:
${stackUsage}
  doctor [--json]                     check Node, Docker and Compose v2, and the Tenant's health
  doctor sandbox [--tenant <name>] [--json]
                                      the sandbox backend the Tenant's Host offers

Groups, each with its own --help:
  agents        list | get | save     the Tenant's agents (Runtime API, an application key)
  sessions      list | create | get | send | approve | respond | cancel | watch | history
                usage | calls | trace | exec
                                      the Tenant's sessions (Runtime API)
  environments  list | get | put | stop | reset | delete | snapshot | restore | versions
                events | secrets      the Tenant's Environments (Runtime API)
  artifacts     list | get | upload | download | tree | diff | zip | link | rm
                                      the Tenant's file artifacts (Runtime API)
  tenant        reset | keys | signing-keys | models | usage | calls | budgets | tool-policy |
                settings | coverage | mcp
                                      the Tenant's settings (Management API, a management key)
  local         ls | delete | logs | reset | sandbox | telemetry
                                      the Tenants on this machine (Docker and kubectl)

A command acts on the local Tenant --tenant names, else the linked project's, else (outside a
project) the default Tenant; NYLORUN_HOME sets its Host root (default
~/.nylorun/tenants/<name>). Without --tenant, NYLORUN_RUNTIME_URL names a remote installation:
with NYLORUN_MANAGEMENT_KEY for status, doctor sandbox and tenant; with NYLORUN_SERVER_KEY, or an
identity provider's token in NYLORUN_TOKEN, for agents, sessions, environments and artifacts.
The Runtime API groups act for a person with --as <subject> [--scope <scope>]...`;

const localUsage = `nylorun local <command>

The Tenants on this machine (Docker Compose), one per project:
  ls [--json]                         the Tenants on this machine, with their memory in use
  delete <tenant> --yes               remove a Tenant: containers, volumes and its Host root, with
                                      the vault key (KEK)
  logs [service] [--tenant <name>] [-f] [--tail <n>]
                                      container logs
  reset [--tenant <name>] [--yes]     delete the Tenant's data (volumes, tenant/ and vault key); the
                                      next start creates it anew
  sandbox enable | disable | status   run the Tenant's sandboxes as pods on a Kubernetes cluster
                                      (nylorun local sandbox --help)
  telemetry [status|enable|disable]   Studio's anonymous usage analytics (on unless disabled,
                                      NYLORUN_TELEMETRY_DISABLED=1, DO_NOT_TRACK=1 or CI)`;

/** Commands that moved into a group, or were removed. */
const MOVED: Record<string, string> = {
  logs: "nylorun logs moved: nylorun local logs",
  ls: "nylorun ls moved: nylorun local ls",
  delete: "nylorun delete moved: nylorun local delete",
  telemetry: "nylorun telemetry moved: nylorun local telemetry",
  reset:
    "nylorun reset moved: nylorun local reset deletes a local Tenant's volumes; nylorun tenant reset clears its sessions or Environments through the Management API",
  key: "nylorun key moved: nylorun tenant keys put|list|rm",
  keys: "nylorun keys is nylorun tenant keys put|list|rm",
  mcp: "nylorun mcp moved: nylorun tenant mcp inspect <url>",
  configure: "nylorun configure is nylorun tenant models set",
  access: "nylorun access is nylorun tenant signing-keys list|rotate|revoke",
  env: 'nylorun env was removed: the SDKs read the Project link themselves. For a process outside the project, give it a key of its own (nylorun tenant keys put <id>) and the Runtime URL "nylorun status" prints.',
  dev: "nylorun dev was removed: run `npx nylorun start` in your project (it creates the project's Tenant and the Project link), then your project's `npm run dev`.",
  serve: "nylorun serve was removed. Use node dist/src/main.js with NYLORUN_RUNTIME_URL and NYLORUN_SERVER_KEY.",
  runtime: "nylorun runtime was removed: the local Runtime runs in Docker Compose. Use nylorun up|down|status and nylorun local logs.",
};

const SANDBOX_MOVED: Record<string, string> = {
  ls: "nylorun sandbox ls moved: nylorun environments list",
  list: "nylorun sandbox ls moved: nylorun environments list",
  rm: "nylorun sandbox rm moved: nylorun environments delete <id>",
  delete: "nylorun sandbox rm moved: nylorun environments delete <id>",
};

const LOCAL_UI_REMOVED =
  "--local-ui was removed: Studio runs in its own container. Run nylorun studio.";

const usageError = (message: string) => new CliError(message, 2);

/** `nylorun local <command>`: the Docker and kubectl commands of this machine's Tenants. */
async function local(args: readonly string[]): Promise<number> {
  const [command, ...rest] = args;
  if (command === "--help" || command === "-h") {
    console.log(localUsage);
    return 0;
  }
  if (command === "ls" || command === "delete" || command === "logs" || command === "reset")
    return stackCommand(command, rest, baselineEnv());
  if (command === "sandbox") {
    const [sub] = rest;
    if (sub && SANDBOX_MOVED[sub]) throw usageError(SANDBOX_MOVED[sub]);
    const { runSandboxCommand, sandboxUsage } = await import("./sandbox/commands.js");
    if (sub === "--help" || sub === "-h") {
      console.log(`nylorun local sandbox <enable|disable|status>\n\n${sandboxUsage}`);
      return 0;
    }
    const { spawnKubectl } = await import("./sandbox/kubectl.js");
    const deps = defaultStackDeps(baselineEnv());
    return runSandboxCommand(rest, { stack: deps, kubectl: spawnKubectl(deps.env) });
  }
  if (command === "telemetry") {
    const { telemetryCommand } = await import("./telemetry.js");
    const { defaultNylorunRoot } = await import("./stack/stacks.js");
    return telemetryCommand(rest, {
      nylorunRoot: defaultNylorunRoot(),
      env: baselineEnv(),
      out: (line) => console.log(line),
    });
  }
  throw usageError(command ? `Unknown local command ${command}.\n${localUsage}` : localUsage);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h")
    return void console.log(usage);
  refuseNativeWindows();

  if (command === "sandbox") {
    const sub = args[0];
    throw usageError(
      (sub && SANDBOX_MOVED[sub]) ??
        `nylorun sandbox moved: nylorun local sandbox ${sub && !sub.startsWith("-") ? sub : "enable|disable|status"}`,
    );
  }
  const moved = MOVED[command];
  if (moved) throw usageError(moved);
  if (command === "status" && args.includes("--env")) throw usageError(MOVED.env!);

  const env = baselineEnv();
  if (command === "studio") {
    if (args.includes("--local-ui")) throw usageError(LOCAL_UI_REMOVED);
    process.exitCode = await studioCommand(args, env);
    return;
  }
  if (command === "status" && !args.includes("--tenant")) {
    // An installation the environment names answers through the Management API.
    const { remoteConnection } = await import("./client/target.js");
    if (remoteConnection(env, "management")) {
      const { remoteStatus } = await import("./client/tenant.js");
      process.exitCode = await remoteStatus(defaultStackDeps(env), args);
      return;
    }
  }
  if (["up", "start", "down", "stop", "status"].includes(command)) {
    process.exitCode = await stackCommand(command, args, env);
    return;
  }
  if (command === "local") {
    process.exitCode = await local(args);
    return;
  }
  if (command === "tenant") {
    const { tenantCommand } = await import("./client/tenant.js");
    process.exitCode = await tenantCommand(defaultStackDeps(env), args);
    return;
  }
  if (command === "agents" || command === "sessions" || command === "environments" || command === "artifacts") {
    const group = {
      agents: async () => (await import("./client/agents.js")).agentsCommand,
      sessions: async () => (await import("./client/sessions.js")).sessionsCommand,
      environments: async () => (await import("./client/environments.js")).environmentsCommand,
      artifacts: async () => (await import("./client/artifacts.js")).artifactsCommand,
    }[command];
    process.exitCode = await (await group())(defaultStackDeps(env), args);
    return;
  }
  if (command === "doctor") {
    const [topic, ...options] = args;
    if (topic === "sandbox") {
      const usage = "Usage: nylorun doctor sandbox [--tenant <name>] [--json]";
      const tenantAt = options.indexOf("--tenant");
      const tenant = tenantAt < 0 ? undefined : options[tenantAt + 1];
      const rest = options.filter((_, index) => index !== tenantAt && index !== tenantAt + 1);
      if ((tenantAt >= 0 && (!tenant || tenant.startsWith("-"))) || rest.some((option) => option !== "--json"))
        throw usageError(usage);
      const { doctorSandbox } = await import("./client/doctor.js");
      await doctorSandbox(defaultStackDeps(env), {
        json: rest.includes("--json"),
        ...(tenant ? { tenant } : {}),
      });
      return;
    }
    if (args.some((option) => option !== "--json"))
      throw usageError("Usage: nylorun doctor [--json] | nylorun doctor sandbox [--tenant <name>] [--json]");
    const { doctorStack } = await import("./doctor.js");
    process.exitCode = await doctorStack({ json: args.includes("--json"), env });
    return;
  }

  throw usageError(usage);
}

runCommand(main);
