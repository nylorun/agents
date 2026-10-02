/**
 * `nylo status`, `nylo reset` and `nylo endpoints`: the linked installation's one Tenant,
 * through the Tenant API with the Project's application key.
 */
import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { createAdmin, type HostTenant } from "@nylorun/admin";
import { createClient } from "@nylorun/agents";
import { CliError } from "../errors.js";
import { linkedConnection, type LinkedConnection } from "../project/connection.js";
import { findProjectRoot } from "../project/root.js";

/** The Tenant API status body (`GET /v1/tenant`), the parts `nylo status` prints. */
type TenantStatusView = {
  tenant: { name: string; id: string };
  path: string;
  checks: Record<string, boolean>;
  counts: Record<string, number>;
  sandbox: { backend: string | null };
};

const projectRoot = () => findProjectRoot() ?? process.cwd();

const clientFor = (connection: LinkedConnection) =>
  createClient({ url: connection.url, key: connection.key });

/** `nylo status [--json]`: the Tenant, its checks and counts; the Host's cause when it is not open. */
export async function statusCommand(args: readonly string[]): Promise<void> {
  const json = args.includes("--json");
  if (args.some((a) => a !== "--json"))
    throw new CliError("Usage: nylo status [--json]", 2);
  const root = projectRoot();
  const connection = await linkedConnection(root);
  const stack = connection.link?.stack;
  let reason: unknown;
  try {
    const body = await clientFor(connection).transport.json<TenantStatusView>(
      "/v1/tenant",
      "GET",
    );
    if (json) {
      console.log(JSON.stringify({ ...(stack ? { stack } : {}), ...body }, null, 2));
      return;
    }
    console.log(`${body.tenant.name}  ${body.tenant.id}`);
    if (stack) console.log(`stack    ${stack}`);
    console.log(`runtime  ${connection.url}`);
    console.log(`path     ${body.path}`);
    console.log(
      `checks   ${Object.entries(body.checks)
        .map(([k, v]) => `${k}=${v ? "ok" : "fail"}`)
        .join(" ")}`,
    );
    console.log(
      `counts   sessions=${body.counts.sessions} running=${body.counts.runningSessions} pending=${body.counts.pendingActions}`,
    );
    console.log(`sandbox  ${body.sandbox.backend ?? "none"}`);
    return;
  } catch (error) {
    // A Tenant that is not open does not answer: the Admin API says why.
    reason = error;
  }
  let tenant: HostTenant;
  try {
    tenant = (await createAdmin({ cwd: root }).status()).tenant;
  } catch {
    throw new CliError(
      reason instanceof Error
        ? reason.message
        : `The Tenant at ${connection.url} is not reachable.`,
      1,
    );
  }
  if (json) {
    console.log(JSON.stringify({ ...(stack ? { stack } : {}), tenant }, null, 2));
    return;
  }
  console.log(`${tenant.name ?? "(unreadable)"}  ${tenant.id ?? "(unknown)"}  ${tenant.state}`);
  if (stack) console.log(`stack    ${stack}`);
  console.log(`runtime  ${connection.url}`);
  if (tenant.cause) {
    console.log(`reason   ${tenant.cause.code}: ${tenant.cause.message}`);
    console.log(`repair   ${tenant.cause.repair}`);
  }
}

const RESET_USAGE = "Usage: nylo reset [--sessions|--sandboxes|--all] [--yes]";
const SCOPES = { "--sessions": "sessions", "--sandboxes": "sandboxes", "--all": "all" } as const;

/** `nylo reset [--sessions|--sandboxes|--all] [--yes]`; `--all` asks first. */
export async function resetCommand(args: readonly string[]): Promise<void> {
  const yes = args.includes("--yes");
  const flags = args.filter((a) => a !== "--yes");
  if (flags.some((f) => !(f in SCOPES)) || args.filter((a) => a === "--yes").length > 1)
    throw new CliError(RESET_USAGE, 2);
  if (flags.length > 1)
    throw new CliError("Pass only one of --sessions, --sandboxes, --all.", 2);
  const scope = flags.length ? SCOPES[flags[0] as keyof typeof SCOPES] : "sessions";
  const connection = await linkedConnection(projectRoot());
  const stack = connection.link?.stack;
  const where = stack ? `stack ${stack} (${connection.url})` : connection.url;
  if (scope === "all" && !yes)
    await confirmOrThrow(
      `Reset ALL data of the Tenant on ${where}? The Project link and credentials are kept. [y/N] `,
    );
  try {
    await clientFor(connection).transport.json("/v1/tenant/reset", "POST", {
      requestId: randomUUID(),
      scope,
      activeWork: "drain",
    });
  } catch (error) {
    throw new CliError(
      error instanceof Error ? error.message : `Tenant reset failed: ${String(error)}`,
      1,
    );
  }
  console.log(`Reset the Tenant on ${where} (${scope}).`);
}

async function confirmOrThrow(prompt: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError(
      "Confirmation required; pass --yes for non-interactive use.",
      2,
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(prompt)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      throw new CliError("Cancelled.", 1);
    }
  } finally {
    rl.close();
  }
}

/** `nylo endpoints [--json]` and `nylo endpoints ping <agent>`. */
export async function endpointsCommand(args: readonly string[]): Promise<void> {
  if (args[0] === "ping") {
    const agentId = args[1];
    if (!agentId || args.length > 2)
      throw new CliError("Usage: nylo endpoints ping <agent>", 2);
    const client = clientFor(await linkedConnection(projectRoot()));
    const answer = await client.transport.json<{
      agentId: string;
      implementationVersion: string;
      manifestHash?: string;
    }>(`/v1/endpoints/${encodeURIComponent(agentId)}/ping`, "POST");
    console.log(
      `${answer.agentId}  serves ${answer.implementationVersion}${answer.manifestHash ? `  ${answer.manifestHash}` : ""}`,
    );
    return;
  }
  const json = args.includes("--json");
  if (args.some((a) => a !== "--json"))
    throw new CliError("Usage: nylo endpoints [--json] | nylo endpoints ping <agent>", 2);
  const client = clientFor(await linkedConnection(projectRoot()));
  const body = await client.transport.json<{
    endpoints: {
      agentId: string;
      url: string;
      implementationVersion: string;
      health: {
        consecutiveFailures: number;
        lastSuccessAt?: string;
        lastError?: { code: string; message: string };
      };
    }[];
  }>("/v1/endpoints", "GET");
  if (json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  if (body.endpoints.length === 0) {
    console.log("No Action endpoints. Register one with createActionHandler(...).register({ url }).");
    return;
  }
  for (const endpoint of body.endpoints) console.log(endpointLine(endpoint));
}

/** One line of `nylo endpoints`: the agent, its URL and version, and how it is doing. */
export function endpointLine(endpoint: {
  agentId: string;
  url: string;
  implementationVersion: string;
  health: {
    consecutiveFailures: number;
    lastSuccessAt?: string;
    lastError?: { code: string; message: string };
  };
}): string {
  const { health } = endpoint;
  const state =
    health.consecutiveFailures > 0
      ? `failing (${health.consecutiveFailures}): ${health.lastError?.message || health.lastError?.code || "unknown"}`
      : health.lastSuccessAt
        ? `ok (last ${health.lastSuccessAt})`
        : "no deliveries yet";
  return `${endpoint.agentId}  ${endpoint.url}  ${endpoint.implementationVersion}  ${state}`;
}
