/**
 * `nylorun tenant models | usage | calls`: the Tenant's model, what its model calls used, and the
 * calls themselves, through the Management API. `models set` signs in with pi-ai (loaded only
 * there) at a terminal; with `--provider` and `--model` it takes an API key piped in instead,
 * for CI. A key is never an argument.
 */
import { randomUUID } from "node:crypto";
import type { ManagementClient } from "@nylorun/admin";
import type { HostModelView, ModelUsageQuery } from "@nylorun/core/contracts";
import { CliError } from "../errors.js";
import { parseStackFlags, type StackDeps } from "../stack/commands.js";
import { printJson, printTable, readSecret } from "./io.js";
import { connect, managementClient } from "./target.js";

export const modelsUsage = `  models catalog [--tenant <name>] [--json]
                                      every provider and model the Runtime knows
  models providers [--tenant <name>] [--json]
                                      the providers with a credential, and the one in use
  models get [--tenant <name>] [--json]
                                      the Tenant's model
  models set [--tenant <name>]        sign in to a model provider and set the Tenant's model
  models set --provider <id> --model <id> [--base-url <url>] [--tenant <name>]
                                      the same with an API key piped in on stdin (CI)
  models select <provider> [--model <id>] [--tenant <name>]
                                      use a provider that has a credential (default: its model)`;

export const usageUsage = `  usage [--scope tenant|agent|turn] [--id <id>] [--period day|month|total] [--tenant <name>]
                                      what the model calls used and cost (JSON)
  calls [--after <cursor>] [--limit <n>] [--tenant <name>]
                                      every recorded model call, one JSON line each, until
                                      caught up; prints the cursor to resume from on stderr`;

const usageError = (message = `Usage:\n${modelsUsage}`) => new CliError(message, 2);

async function client(deps: StackDeps, tenant: string | undefined): Promise<ManagementClient> {
  return managementClient(deps, await connect(deps, "management", tenant));
}

/** The Tenant's model in one line. */
function describe(view: HostModelView): string {
  if (!view.configured) return "No model is set: run nylorun tenant models set.";
  return [view.provider, view.model, view.authType, ...(view.baseUrl ? [view.baseUrl] : [])].join(
    "  ",
  );
}

/** `models catalog | providers | get`: a table or a line, else `--json`. */
async function read(deps: StackDeps, verb: string, args: readonly string[]): Promise<number> {
  const usage = `nylorun tenant models ${verb} [--tenant <name>] [--json]`;
  const flags = parseStackFlags(args, { booleans: ["--json"], values: ["--tenant"] }, usage);
  if (flags.rest.length) throw usageError(`Usage: ${usage}`);
  const admin = await client(deps, flags.values.get("--tenant"));
  const json = flags.booleans.has("--json");
  if (verb === "catalog") {
    const catalog = await admin.models.catalog();
    if (json) printJson(deps, catalog);
    else
      printTable(deps, [
        ["PROVIDER", "MODEL", "READS"],
        ...catalog.providers.flatMap((provider) =>
          provider.models.map((model) => [provider.id, model.id, model.inputs.join(",")]),
        ),
      ]);
  } else if (verb === "providers") {
    const { providers } = await admin.models.providers();
    if (json) printJson(deps, providers);
    else if (!providers.length)
      deps.err("No provider has a credential: run nylorun tenant models set.");
    else
      printTable(deps, [
        ["PROVIDER", "MODEL", "AUTH", "IN USE"],
        ...providers.map((p) => [p.id, p.model, p.authType, p.active ? "yes" : ""]),
      ]);
  } else {
    const view = await admin.models.get();
    if (json) printJson(deps, view);
    else deps.out(describe(view));
  }
  return 0;
}

const SET_USAGE =
  "nylorun tenant models set [--tenant <name>] | nylorun tenant models set --provider <id> --model <id> [--base-url <url>] [--tenant <name>]";

/**
 * `models set`: at a terminal, the sign-in prompts; with `--provider` and `--model`, the API key
 * on stdin, set as `PUT /v1/tenant/model` with an `api_key` credential (OAuth needs the prompts).
 */
async function set(deps: StackDeps, args: readonly string[]): Promise<number> {
  const flags = parseStackFlags(
    args,
    { values: ["--tenant", "--provider", "--model", "--base-url"] },
    SET_USAGE,
  );
  if (flags.rest.length) throw usageError(`Usage: ${SET_USAGE}`);
  const provider = flags.values.get("--provider");
  const model = flags.values.get("--model");
  const baseUrl = flags.values.get("--base-url");
  if (provider !== undefined || model !== undefined || baseUrl !== undefined) {
    if (provider === undefined || model === undefined)
      throw usageError(`Pass both --provider and --model. Usage: ${SET_USAGE}`);
    const key = await readSecret(
      deps,
      "API key",
      `printenv OPENAI_API_KEY | nylorun tenant models set --provider ${provider} --model ${model}`,
    );
    const admin = await client(deps, flags.values.get("--tenant"));
    const view = await admin.models.put({
      idempotencyKey: randomUUID(),
      provider,
      model,
      ...(baseUrl ? { baseUrl } : {}),
      auth: { type: "api_key", key },
    });
    deps.out(describe(view));
    return 0;
  }
  const admin = await client(deps, flags.values.get("--tenant"));
  const { ConfigurationCancelled, configureProvider, fetchModelCatalog } = await import(
    "./model/configure.js"
  );
  const { putHostModel } = await import("./model/host-model.js");
  const controller = new AbortController();
  const cancel = (signal: "SIGINT" | "SIGTERM") =>
    controller.abort(new ConfigurationCancelled(signal));
  process.once("SIGINT", () => cancel("SIGINT"));
  process.once("SIGTERM", () => cancel("SIGTERM"));
  const catalog = await fetchModelCatalog(admin);
  const prompted = await configureProvider({ signal: controller.signal, catalog });
  await putHostModel(admin, prompted);
  return 0;
}

/**
 * `models select <provider>`: the provider's stored model and endpoint unless `--model` says
 * otherwise (the Runtime keeps only the endpoint the request names).
 */
async function select(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage = "nylorun tenant models select <provider> [--model <id>] [--tenant <name>]";
  const flags = parseStackFlags(args, { values: ["--tenant", "--model"] }, usage);
  if (flags.rest.length !== 1) throw usageError(`Usage: ${usage}`);
  const id = flags.rest[0]!;
  const admin = await client(deps, flags.values.get("--tenant"));
  const stored = (await admin.models.providers()).providers.find((p) => p.id === id);
  if (!stored)
    throw new CliError(
      `Provider ${id} has no credential: run nylorun tenant models set (nylorun tenant models providers lists those that do).`,
      1,
    );
  const view = await admin.models.select({
    idempotencyKey: randomUUID(),
    provider: id,
    model: flags.values.get("--model") ?? stored.model,
    ...(stored.baseUrl ? { baseUrl: stored.baseUrl } : {}),
  });
  deps.out(describe(view));
  return 0;
}

/** `nylorun tenant models <verb> ...` */
export async function modelsCommand(deps: StackDeps, args: readonly string[]): Promise<number> {
  const [verb, ...rest] = args;
  if (verb === "catalog" || verb === "providers" || verb === "get") return read(deps, verb, rest);
  if (verb === "set") return set(deps, rest);
  if (verb === "select") return select(deps, rest);
  throw usageError();
}

const SCOPES = ["tenant", "agent", "turn"] as const;
const PERIODS = ["day", "month", "total"] as const;
const USAGE_USAGE =
  "nylorun tenant usage [--scope tenant|agent|turn] [--id <id>] [--period day|month|total] [--tenant <name>]";

/** `nylorun tenant usage`: one scope's totals for one period, as JSON. */
export async function usageCommand(deps: StackDeps, args: readonly string[]): Promise<number> {
  const flags = parseStackFlags(args, { values: ["--tenant", "--scope", "--id", "--period"] }, USAGE_USAGE);
  if (flags.rest.length) throw usageError(`Usage: ${USAGE_USAGE}`);
  const scope = flags.values.get("--scope") ?? "tenant";
  const period = flags.values.get("--period") ?? "total";
  const id = flags.values.get("--id");
  if (!(SCOPES as readonly string[]).includes(scope))
    throw usageError(`--scope is one of ${SCOPES.join(", ")}.`);
  if (!(PERIODS as readonly string[]).includes(period))
    throw usageError(`--period is one of ${PERIODS.join(", ")}.`);
  if ((scope === "tenant") !== (id === undefined))
    throw usageError(
      scope === "tenant" ? "--id names an agent or a turn: pass --scope agent or turn." : `--scope ${scope} needs --id.`,
    );
  const query: ModelUsageQuery = {
    scope: scope as ModelUsageQuery["scope"],
    period: period as ModelUsageQuery["period"],
    ...(id === undefined ? {} : { id }),
  };
  printJson(deps, await (await client(deps, flags.values.get("--tenant"))).models.usage(query));
  return 0;
}

const CALLS_USAGE = "nylorun tenant calls [--after <cursor>] [--limit <n>] [--tenant <name>]";

/**
 * `nylorun tenant calls`: every recorded model call from `--after`, one JSON object per line
 * (NDJSON) on stdout, page by page (`--limit` a page) until caught up; then the cursor to resume
 * from on stderr. Rows may repeat across runs: deduplicate by id.
 */
export async function callsCommand(deps: StackDeps, args: readonly string[]): Promise<number> {
  const flags = parseStackFlags(args, { values: ["--tenant", "--after", "--limit"] }, CALLS_USAGE);
  if (flags.rest.length) throw usageError(`Usage: ${CALLS_USAGE}`);
  const after = flags.values.get("--after");
  const limitFlag = flags.values.get("--limit");
  const limit = limitFlag === undefined ? undefined : Number(limitFlag);
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= 1000))
    throw usageError("--limit is a whole number from 1 to 1000.");
  const admin = await client(deps, flags.values.get("--tenant"));
  let next: string | null = null;
  for await (const page of admin.models.exportCalls({
    ...(after === undefined ? {} : { after }),
    ...(limit === undefined ? {} : { limit }),
  })) {
    for (const call of page.calls) deps.out(JSON.stringify(call));
    next = page.next;
  }
  if (next !== null) deps.err(`Caught up. Resume with --after ${next}`);
  return 0;
}
