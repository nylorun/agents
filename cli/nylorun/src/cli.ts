#!/usr/bin/env node
import "./baseline.js";
import { baselineEnv } from "./baseline.js";
import { refuseNativeWindows, runCommand } from "./command.js";
import { CliError, HelpRequest, isHelp } from "./errors.js";
import { defaultStackDeps, stackCommand, stackUsage, studioCommand } from "./stack/index.js";

const usage = `nylorun <command>

The installation:
${stackUsage}
  doctor [--json]                     check Node, Docker and Compose v2, and the Tenant's health
  doctor sandbox [--tenant <name>] [--json]
                                      the sandbox backend the Tenant's Host offers

Agent manifests:
  init <path> [--description <text>] [--example]
                                      write <path>/AGENT.md, a new agent folder named after the
                                      path's last segment; --example adds a tool, mcp.json and a
                                      trigger
  check [<dir>...] [--json]           compile each agent folder offline and print every problem
                                      by file, line and column (reads no Runtime)
  apply [<dir>...] [--dry-run] [--if-match <n>] [--agent [<id>]] [--watch [--save]]
                                      save the agent manifest each folder describes (its AGENT.md,
                                      or its agent.manifest.json), with its files (Runtime API);
                                      --agent then makes or moves the Agent; --watch plans again
                                      on each change
  chat <agent> [--session <id>] [--message <text>]
                                      talk to an Agent: send each line, print each reply
  migrate v8 <agent.json> [--runtime <environment-manifest.json>] [--name <name>] [--out <dir>]
                                      write the three manifest files from an agent manifest v7
                                      and an environment manifest v1 (reads no Runtime)
  migrate folder <dir> [--out <dir>]  write the agent folder of a three-file folder
                                      (agent.manifest.json; reads no Runtime)
  export --folder <name>[@<version>] [--out <dir>]
                                      write the agent folder of a saved manifest (Runtime API)
  pull <name>[@<version>] [--out <dir>]
                                      write the folder a version was saved from (Runtime API)

Groups, each with its own --help:
  agent-manifests  list | get | versions | rm
                                      the Tenant's agent manifests (Runtime API)
  agents        list | get | put | pin | track | restart | fork | stop | reset | rm |
                snapshot | restore | versions | delete-version | events | secrets |
                triggers | runs | memories
                                      the Tenant's Agents, made from saved manifests; sessions
                                      run on them (Runtime API)
  sessions      list | create | get | send | approve | respond | cancel | watch | history
                usage | calls | trace | exec
                                      the Tenant's sessions (Runtime API)
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
identity provider's token in NYLORUN_TOKEN, for apply, agent-manifests, agents, sessions and
artifacts.
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
    "nylorun reset moved: nylorun local reset deletes a local Tenant's volumes; nylorun tenant reset clears its sessions or Agents through the Management API",
  environments:
    "nylorun environments is nylorun agents in protocol 16: Environments are Agents, made from saved agent manifests (nylorun apply). Environment manifests are the runtime section of an agent manifest (nylorun migrate v8).",
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
  ls: "nylorun sandbox ls moved: nylorun agents list",
  list: "nylorun sandbox ls moved: nylorun agents list",
  rm: "nylorun sandbox rm moved: nylorun agents rm <id>",
  delete: "nylorun sandbox rm moved: nylorun agents rm <id>",
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
  if (command === "--version" || command === "-v" || command === "version") {
    const { cliVersion } = await import("./stack/versions.js");
    return void console.log(cliVersion());
  }
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
  if (
    command === "apply" ||
    command === "check" ||
    command === "init" ||
    command === "migrate" ||
    command === "export" ||
    command === "pull" ||
    command === "chat" ||
    command === "agent-manifests" ||
    command === "agents" ||
    command === "sessions" ||
    command === "artifacts"
  ) {
    const group = {
      apply: async () => (await import("./client/apply.js")).applyCommand,
      check: async () => (await import("./client/folder.js")).checkCommand,
      init: async () => (await import("./client/folder.js")).initCommand,
      migrate: async () => (await import("./client/migrate.js")).migrateCommand,
      export: async () => (await import("./client/convert.js")).exportCommand,
      pull: async () => (await import("./client/convert.js")).pullCommand,
      chat: async () => (await import("./client/chat.js")).chatCommand,
      "agent-manifests": async () => (await import("./client/agent-manifests.js")).agentManifestsCommand,
      agents: async () => (await import("./client/agents.js")).agentsCommand,
      sessions: async () => (await import("./client/sessions.js")).sessionsCommand,
      artifacts: async () => (await import("./client/artifacts.js")).artifactsCommand,
    }[command];
    process.exitCode = await (await group())(defaultStackDeps(env), args);
    return;
  }
  if (command === "doctor") {
    const [topic, ...options] = args;
    if (topic === "sandbox") {
      const usage = "Usage: nylorun doctor sandbox [--tenant <name>] [--json]";
      if (options.some(isHelp)) throw new HelpRequest(usage);
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
    const usage = "Usage: nylorun doctor [--json] | nylorun doctor sandbox [--tenant <name>] [--json]";
    if (args.some(isHelp)) throw new HelpRequest(usage);
    if (args.some((option) => option !== "--json")) throw usageError(usage);
    const { doctorStack } = await import("./doctor.js");
    process.exitCode = await doctorStack({ json: args.includes("--json"), env });
    return;
  }

  throw usageError(usage);
}

runCommand(main);
