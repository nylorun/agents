/**
 * `nylorun mcp connect <url> --server <name>`: signs the running local Tenant in to a remote MCP
 * server with OAuth (F9 C2), through its Tenant API with an operator key (`runningTenantApi`).
 * The Runtime's keys module runs discovery, registration and the code exchange and seals the
 * credential in an installation vault (`mcp` unless `--vault` names one); this command only
 * opens the browser and waits for the credential to appear. It never starts the Tenant.
 */
import { randomUUID } from "node:crypto";
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import type { CredentialInfo, VaultInfo } from "@nylorun/core/contracts";
import { CliError } from "../errors.js";
import { parseStackFlags, runningTenantApi, type StackDeps, type TenantApi } from "./commands.js";

export const mcpUsage = `  mcp connect <url> --server <name> [--vault <id>] [--client-id <id>] [--tenant <name>] [--no-open]
                                      sign the Tenant in to a remote MCP server with OAuth; the credential goes to the
                                      installation vault mcp (or --vault), which sessions attach`;

/** The installation vault `connect` uses unless `--vault` names one. */
export const MCP_VAULT_NAME = "mcp";
/** How long `connect` waits for the browser sign-in: the Runtime keeps it for ten minutes. */
export const CONNECT_TIMEOUT_MS = 10 * 60_000;

const usageError = (message: string) => new CliError(message, 2);

async function call<T>(
  deps: StackDeps,
  api: TenantApi,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await deps.fetch(`${api.runtimeUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${api.applicationKey}`,
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(150_000),
  });
  const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok)
    throw new CliError(
      `${method} ${path} returned ${response.status}${typeof answer.message === "string" ? `: ${answer.message}` : ""}`,
      1,
    );
  return answer as T;
}

/** The URL as the vault binds it: origin, path and query, no default port, no fragment. */
function bindingUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw usageError(`${input} is not a URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw usageError(`${input} is not an http(s) URL.`);
  if (url.username || url.password || url.hash) throw usageError(`${input} must not carry userinfo or a fragment.`);
  return `${url.origin}${url.pathname}${url.search}`;
}

/** The installation vault named `mcp`, created when there is none. */
async function mcpVault(deps: StackDeps, api: TenantApi): Promise<VaultInfo> {
  const { vaults } = await call<{ vaults: VaultInfo[] }>(deps, api, "GET", "/v1/vaults");
  const found = vaults.find((vault) => vault.ownerUserId === "installation" && vault.name === MCP_VAULT_NAME);
  if (found) return found;
  const key = `nylorun-mcp-${randomUUID()}`;
  return await call<VaultInfo>(deps, api, "POST", "/v1/vaults", {
    requestId: key,
    idempotencyKey: key,
    name: MCP_VAULT_NAME,
    scope: "installation",
  });
}

/** Each credential of the vault bound to `url`, by id, with when it last changed. */
async function credentialsFor(deps: StackDeps, api: TenantApi, vaultId: string, url: string) {
  const { credentials } = await call<{ credentials: CredentialInfo[] }>(
    deps,
    api,
    "GET",
    `/v1/vaults/${encodeURIComponent(vaultId)}/credentials`,
  );
  return new Map(
    credentials
      .filter((item) => item.type === "oauth" && item.binding.url === url)
      .map((item) => [item.id, item.rotatedAt ?? item.createdAt] as const),
  );
}

async function connect(deps: StackDeps, args: readonly string[]): Promise<number> {
  const usage =
    "nylorun mcp connect <url> --server <name> [--vault <id>] [--client-id <id>] [--tenant <name>] [--no-open]";
  const flags = parseStackFlags(
    args,
    { booleans: ["--no-open"], values: ["--server", "--vault", "--client-id", "--tenant"] },
    usage,
  );
  if (flags.rest.length !== 1) throw usageError(`Usage: ${usage}`);
  const server = flags.values.get("--server");
  if (!server) throw usageError(`--server names the MCP server, as the agent declares it. Usage: ${usage}`);
  const url = bindingUrl(flags.rest[0]!);
  const clientId = flags.values.get("--client-id");
  const name = flags.values.get("--tenant");
  const api = await runningTenantApi(deps, name === undefined ? {} : { name });
  const vaultId = flags.values.get("--vault") ?? (await mcpVault(deps, api)).id;
  const before = await credentialsFor(deps, api, vaultId, url);
  const started = await call<{ authorizeUrl: string; expiresAt: string }>(
    deps,
    api,
    "POST",
    `/v1/vaults/${encodeURIComponent(vaultId)}/oauth/start`,
    { url, server, ...(clientId === undefined ? {} : { clientId }) },
  );
  deps.out(`Sign in to ${server} in your browser:`);
  deps.out(`  ${started.authorizeUrl}`);
  if (!flags.booleans.has("--no-open")) await deps.openBrowser(started.authorizeUrl);
  deps.out("Waiting for the sign-in to finish…");
  const deadline = Math.min(Date.now() + CONNECT_TIMEOUT_MS, Date.parse(started.expiresAt) || Infinity);
  const pollMs = deps.pollMs ?? 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const now = await credentialsFor(deps, api, vaultId, url);
    for (const [id, changed] of now)
      if (before.get(id) !== changed) {
        deps.out(`Connected ${server} (${url}): credential ${id} in installation vault ${vaultId}.`);
        deps.out(`Sessions use it when they attach the vault: vaultIds: ["${vaultId}"].`);
        return 0;
      }
  }
  throw new CliError(
    `The sign-in to ${server} did not finish in time. Run "nylorun mcp connect" again; the browser page says why when the server refused it.`,
    1,
  );
}

/** `nylorun mcp <connect> ...` */
export async function mcpCommand(deps: StackDeps, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "connect") return connect(deps, rest);
  throw usageError(`Usage:\n${mcpUsage}`);
}
