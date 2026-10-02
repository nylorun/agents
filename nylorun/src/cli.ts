#!/usr/bin/env node
import "./baseline.js";
import { baselineEnv } from "./baseline.js";
import { CliError } from "./errors.js";
import {
  isStackCommand,
  stackCommand,
  stackUsage,
  studioCommand,
} from "./stack/index.js";

const usage = `nylorun <up|down|start|stop|status|logs|studio|reset|ls|delete|legacy|doctor>

Local stacks (Docker Compose), one per project:
${stackUsage}
  doctor [--json]                     check Node, Docker and Compose v2, and the stack's health

A command acts on the stack --name or NYLORUN_STACK names, else the linked project's;
NYLORUN_HOME sets its Host root (default ~/.nylorun/stacks/<name>).

nylorun sets up and runs local stacks. "nylorun start" in a project creates the
project's stack, its one Tenant and the Project link. Agents, sessions and model
providers belong to the Runtime client: npx @nylorun/cli --help`;

const CLIENT = "npx @nylorun/cli";

/** Commands that were removed, or moved to the Runtime client (`@nylorun/cli`, command `nylo`). */
const MOVED_TO_CLIENT: Record<string, string> = {
  dev: "nylorun dev was removed: run `npx nylorun start` in your project (it creates the project's stack, its Tenant and the Project link), then your project's `npm run dev`.",
  tenant: `Tenant commands were removed: a stack serves one Tenant, which \`npx nylorun start\` in a project creates with the stack and the Project link. Use nylorun status|reset, or ${CLIENT} status|reset|endpoints.`,
  configure: `nylorun configure moved to the Runtime client: ${CLIENT} configure`,
  serve: "nylorun serve was removed. Use node dist/src/main.js with NYLORUN_RUNTIME_URL and NYLORUN_SERVER_KEY.",
  runtime: "nylorun runtime was removed: the local Runtime runs in the Docker Compose stack. Use nylorun up|down|status|logs.",
};

const LOCAL_UI_REMOVED =
  "--local-ui was removed: Studio runs in the stack's studio container. Run nylorun studio.";

const usageError = (message: string) => new CliError(message, 2);

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h")
    return void console.log(usage);
  if (process.platform === "win32")
    throw new CliError(
      "Nylorun does not run on native Windows. Use WSL2: install Node 24 and Docker (Docker Desktop's WSL integration) inside your WSL distribution and run nylorun there (https://learn.microsoft.com/windows/wsl/install).",
      1,
    );

  const moved = MOVED_TO_CLIENT[command];
  if (moved) throw usageError(moved);
  if (command === "status" && args.includes("--env"))
    throw usageError(`nylorun status --env moved to the Runtime client: ${CLIENT} env`);

  if (command === "studio") {
    if (args.includes("--local-ui")) throw usageError(LOCAL_UI_REMOVED);
    process.exitCode = await studioCommand(args, baselineEnv());
    return;
  }
  if (isStackCommand(command)) {
    process.exitCode = await stackCommand(command, args, baselineEnv());
    return;
  }
  // `nylorun stack <command>`: the Wave 1 spelling, kept as a hidden alias.
  if (command === "stack") {
    const [name, ...rest] = args;
    if (!isStackCommand(name)) throw usageError(usage);
    process.exitCode = await stackCommand(name!, rest, baselineEnv());
    return;
  }

  if (command === "doctor") {
    // `doctor stack` and `doctor runtime` are older spellings of `doctor`.
    const options = args[0] === "stack" || args[0] === "runtime" ? args.slice(1) : args;
    if (args[0] === "sandbox")
      throw usageError(`nylorun doctor sandbox moved to the Runtime client: ${CLIENT} doctor sandbox`);
    if (options.some((option) => option !== "--json"))
      throw usageError("Usage: nylorun doctor [--json]");
    const { doctorStack } = await import("./doctor.js");
    process.exitCode = await doctorStack({ json: options.includes("--json"), env: baselineEnv() });
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
    return finish(error instanceof CliError ? error.exitCode : 1);
  },
);
