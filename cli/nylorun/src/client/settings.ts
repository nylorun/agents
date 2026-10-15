/**
 * `nylorun tenant budgets | tool-policy | settings | coverage`: the Tenant's documents, through
 * the Management API. Each document is files in, files out: `get` prints it as JSON, `put` reads
 * the request body from a file or stdin (`-`), checks it against its schema before anything is
 * sent, and replaces the whole document.
 */
import type { ManagementClient } from "@nylorun/admin";
import {
  PutModelBudgetsRequestSchema,
  PutTenantArtifactsRequestSchema,
  PutTenantEnvironmentsRequestSchema,
  PutTenantSkillsRequestSchema,
  PutToolPolicyRequestSchema,
} from "@nylorun/core/contracts";
import { CliError } from "../errors.js";
import { parseStackFlags, type StackDeps } from "../stack/commands.js";
import { printJson, printTable, readBody, type BodySchema } from "./io.js";
import { connect, managementClient } from "./target.js";

export const settingsUsage = `  budgets [get | put <file|->] [--tenant <name>]
                                      the model spend caps; put replaces them all
  tool-policy [get | put <file|->] [--tenant <name>]
                                      the Tool Gate's rules; put replaces them all
  settings sandbox [get | put <file|->] [--tenant <name>]
                                      the Environment settings: limits, stop grace, placement
  settings artifacts [get | put <file|->] [--tenant <name>]
                                      the artifact store's limits
  settings skills [get | put <file|->] [--tenant <name>]
                                      the most bytes one skill may hold
  coverage --agent <id> [--environment <id>] [--tenant <name>] [--json]
                                      which secret of the Environment each of the agent's MCP
                                      servers and HTTP tools would get`;

const usageError = (message = `Usage:\n${settingsUsage}`) => new CliError(message, 2);

/** One document `get` reads and `put` replaces. */
interface Document<T> {
  /** As the command names it: `budgets`, `settings sandbox`. */
  name: string;
  schema: BodySchema<T>;
  /** Fields of what `get` prints that a `put` drops, so the output can be edited and put back. */
  readOnly?: readonly string[];
  get(admin: ManagementClient): Promise<unknown>;
  put(admin: ManagementClient, body: T): Promise<unknown>;
}

/* The bodies' `requestId` is optional in the contracts; the client adds one when it is absent. */
const budgets: Document<Parameters<ManagementClient["models"]["budgets"]["put"]>[0]> = {
  name: "budgets",
  schema: PutModelBudgetsRequestSchema,
  get: (admin) => admin.models.budgets.get(),
  put: (admin, body) => admin.models.budgets.put(body),
};
const toolPolicy: Document<Parameters<ManagementClient["toolPolicy"]["put"]>[0]> = {
  name: "tool-policy",
  schema: PutToolPolicyRequestSchema,
  readOnly: ["updatedAt"],
  get: (admin) => admin.toolPolicy.get(),
  put: (admin, body) => admin.toolPolicy.put(body),
};
const sandbox: Document<Parameters<ManagementClient["settings"]["sandbox"]["put"]>[0]> = {
  name: "settings sandbox",
  schema: PutTenantEnvironmentsRequestSchema,
  get: (admin) => admin.settings.sandbox.get(),
  put: (admin, body) => admin.settings.sandbox.put(body),
};
const artifacts: Document<Parameters<ManagementClient["settings"]["artifacts"]["put"]>[0]> = {
  name: "settings artifacts",
  schema: PutTenantArtifactsRequestSchema,
  readOnly: ["usedBytes"],
  get: (admin) => admin.settings.artifacts.get(),
  put: (admin, body) => admin.settings.artifacts.put(body),
};

const skillSettings: Document<Parameters<ManagementClient["settings"]["skills"]["put"]>[0]> = {
  name: "settings skills",
  schema: PutTenantSkillsRequestSchema,
  get: (admin) => admin.settings.skills.get(),
  put: (admin, body) => admin.settings.skills.put(body),
};

/** `<document> [get | put <file|->]`: `get` when no verb is given. */
async function documentCommand<T>(
  deps: StackDeps,
  document: Document<T>,
  args: readonly string[],
): Promise<number> {
  const usage = `nylorun tenant ${document.name} [get | put <file|->] [--tenant <name>]`;
  const flags = parseStackFlags(args, { values: ["--tenant"] }, usage);
  const [verb = "get", ...operands] = flags.rest;
  if (!((verb === "get" && !operands.length) || (verb === "put" && operands.length === 1)))
    throw usageError(`Usage: ${usage}`);
  const body = verb === "put" ? await readBody(deps, operands[0]!, document.schema, document.readOnly) : undefined;
  const admin = managementClient(deps, await connect(deps, "management", flags.values.get("--tenant")));
  printJson(deps, body === undefined ? await document.get(admin) : await document.put(admin, body));
  return 0;
}

export const budgetsCommand = (deps: StackDeps, args: readonly string[]) =>
  documentCommand(deps, budgets, args);
export const toolPolicyCommand = (deps: StackDeps, args: readonly string[]) =>
  documentCommand(deps, toolPolicy, args);

/** `nylorun tenant settings sandbox | artifacts | skills ...` */
export async function settingsCommand(deps: StackDeps, args: readonly string[]): Promise<number> {
  const [which, ...rest] = args;
  if (which === "sandbox") return documentCommand(deps, sandbox, rest);
  if (which === "artifacts") return documentCommand(deps, artifacts, rest);
  if (which === "skills") return documentCommand(deps, skillSettings, rest);
  throw usageError();
}

const COVERAGE_USAGE =
  "nylorun tenant coverage --agent <id> [--environment <id>] [--tenant <name>] [--json]";

/**
 * `nylorun tenant coverage`: which secret of `--environment` each remote MCP server and HTTP tool
 * of saved agent `--agent` would get in a session (none without an Environment). It reads no
 * secret and calls no server.
 */
export async function coverageCommand(deps: StackDeps, args: readonly string[]): Promise<number> {
  const flags = parseStackFlags(
    args,
    { booleans: ["--json"], values: ["--tenant", "--agent", "--environment"] },
    COVERAGE_USAGE,
  );
  const agentId = flags.values.get("--agent");
  const environmentId = flags.values.get("--environment");
  if (flags.rest.length || agentId === undefined) throw usageError(`Usage: ${COVERAGE_USAGE}`);
  const admin = managementClient(deps, await connect(deps, "management", flags.values.get("--tenant")));
  const coverage = await admin.coverage({
    agentId,
    ...(environmentId === undefined ? {} : { environmentId }),
  });
  if (flags.booleans.has("--json")) {
    printJson(deps, coverage);
    return 0;
  }
  const missing = coverage.entries.filter((entry) => entry.status === "missing").length;
  deps.out(
    `${coverage.agentId} in ${coverage.environmentId ?? "no Environment"}: ${
      coverage.complete ? "every credential is covered" : `${missing} of ${coverage.entries.length} missing`
    }`,
  );
  if (coverage.entries.length)
    printTable(deps, [
      ["STATUS", "KIND", "NAME", "URL", "SECRET"],
      ...coverage.entries.map((entry) => [
        entry.status,
        entry.kind,
        entry.agentId ? `${entry.agentId}/${entry.name}` : entry.name,
        entry.url,
        entry.credential?.name ?? (entry.required ? "(required)" : ""),
      ]),
    ]);
  return 0;
}
