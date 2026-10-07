/**
 * `nylorun mcp inspect <url>`: a remote MCP server's tools before an agent names it (R2b C12),
 * through the running local Tenant's Management API (`POST /v1/tenant/mcp/preview`) with the
 * Project link's management key, else the Host root's (`runningTenantApi`). It never starts the
 * Tenant, and the Runtime never calls a tool. Its `connect` subcommand (MCP OAuth) was removed
 * in protocol 10, and says so.
 */
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import type { McpPreview, McpPreviewTool } from "@nylorun/core/contracts";
import { CliError } from "../errors.js";
import { parseStackFlags, runningTenantApi, type StackDeps } from "./commands.js";

export const mcpUsage = `  mcp inspect <url> [--server <name>] [--vault <id>] [--sse] [--tenant <name>] [--json]
                                      list a remote MCP server's tools with the installation vault's
                                      credential for <url>: model names, schema sizes, renames, or
                                      that it needs a person's sign-in (the Runtime calls no tool)`;

const INSPECT_USAGE =
  "nylorun mcp inspect <url> [--server <name>] [--vault <id>] [--sse] [--tenant <name>] [--json]";

/** What the removed `connect` subcommand says since protocol 10. */
export const MCP_CONNECT_REMOVED =
  "The connect subcommand of nylorun mcp was removed with MCP OAuth (protocol 10): add the server's key to an installation vault as a bearer or headers credential (Studio's Credentials page, or @nylorun/admin), or reach a server that needs a person's sign-in through a gateway (a credential with via). See its tools with nylorun mcp inspect <url>.";

/** The preview takes up to 15 s in the Runtime; the hop gets a margin. */
const PREVIEW_TIMEOUT_MS = 30_000;
const DESCRIPTION_CHARS = 60;

const usageError = (message: string) => new CliError(message, 2);

async function inspect(deps: StackDeps, args: readonly string[]): Promise<number> {
  const flags = parseStackFlags(
    args,
    { booleans: ["--json", "--sse"], values: ["--server", "--vault", "--tenant"] },
    INSPECT_USAGE,
  );
  if (flags.rest.length !== 1) throw usageError(`Usage: ${INSPECT_USAGE}`);
  const url = flags.rest[0]!;
  const name = flags.values.get("--server");
  const vaultId = flags.values.get("--vault");
  const tenant = flags.values.get("--tenant");
  const api = await runningTenantApi(deps, tenant === undefined ? {} : { name: tenant });
  const response = await deps.fetch(`${api.runtimeUrl}/v1/tenant/mcp/preview`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${api.managementKey}`,
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      url,
      ...(flags.booleans.has("--sse") ? { type: "sse" } : {}),
      ...(name === undefined ? {} : { name }),
      ...(vaultId === undefined ? {} : { vaultId }),
    }),
    redirect: "error",
    signal: AbortSignal.timeout(PREVIEW_TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.status === 404 && body.code === "not_found")
    throw new CliError(
      `Tenant ${api.name} runs a Runtime without MCP previews. Update it: npx nylorun@latest start.`,
      1,
    );
  if (!response.ok) {
    const details = body.details as { failure?: unknown } | undefined;
    const failure = typeof details?.failure === "string" ? ` (${details.failure})` : "";
    throw new CliError(
      typeof body.message === "string"
        ? `${body.message}${failure}`
        : `POST /v1/tenant/mcp/preview returned ${response.status}`,
      1,
    );
  }
  const preview = body as unknown as McpPreview;
  if (flags.booleans.has("--json")) {
    deps.out(JSON.stringify(preview, null, 2));
    return 0;
  }
  for (const line of previewLines(preview)) deps.out(line);
  return 0;
}

/** A preview as a person reads it: the server, a table of tools, the renames, or the sign-in hint. */
export function previewLines(preview: McpPreview): string[] {
  const credential = preview.credentialSent
    ? "with the installation vault's credential"
    : "with no credential (no installation vault holds one for this URL)";
  if (preview.authRequired) {
    const metadata = preview.authRequired.resourceMetadata;
    const servers = Array.isArray(metadata?.authorization_servers)
      ? (metadata.authorization_servers as unknown[]).filter((item) => typeof item === "string")
      : [];
    return [
      preview.credentialSent
        ? `The MCP server at ${preview.url} answered 401: it rejected the installation vault's credential.`
        : `The MCP server at ${preview.url} answered 401: it needs a credential.`,
      ...(servers.length > 0
        ? [`It signs people in with ${servers.join(", ")} (${preview.authRequired.resourceMetadataUrl}).`]
        : []),
      "Nylorun holds no OAuth client: add the server's API key to an installation vault, or reach it",
      "through a gateway that keeps each person's sign-in (a credential with via and an identity header).",
    ];
  }
  const info = preview.serverInfo;
  const label =
    info && typeof info.name === "string"
      ? `${info.name}${typeof info.version === "string" ? ` ${info.version}` : ""}`
      : preview.name;
  const lines = [
    `MCP server ${label} at ${preview.url}, ${credential}: ${preview.tools.length} ${
      preview.tools.length === 1 ? "tool" : "tools"
    }, named for the model as ${preview.name}__<tool>.`,
  ];
  if (preview.tools.length > 0) {
    const rows = [
      ["TOOL", "MODEL NAME", "SCHEMA", "HINTS", "DESCRIPTION"],
      ...preview.tools.map((tool) => [
        tool.serverToolName,
        tool.modelName ?? "(left out: unusable input schema)",
        `${tool.schemaBytes} B`,
        hints(tool),
        oneLine(tool.description ?? ""),
      ]),
    ];
    const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
    lines.push("");
    for (const row of rows)
      lines.push(
        row
          .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!)))
          .join("  ")
          .trimEnd(),
      );
  }
  if (preview.renamed.length > 0) {
    lines.push("", "Renamed for the model (characters outside A-Z, a-z, 0-9, _ and -, or past 64):");
    for (const item of preview.renamed) lines.push(`  ${item.serverToolName} -> ${item.name}`);
  }
  return lines;
}

function hints(tool: McpPreviewTool): string {
  const annotations = tool.annotations ?? {};
  const names = [
    annotations.readOnlyHint === true ? "read-only" : undefined,
    annotations.destructiveHint === true ? "destructive" : undefined,
    annotations.idempotentHint === true ? "idempotent" : undefined,
  ].filter((name) => name !== undefined);
  return names.length === 0 ? "-" : names.join(",");
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > DESCRIPTION_CHARS ? `${flat.slice(0, DESCRIPTION_CHARS - 1)}…` : flat;
}

/** `nylorun mcp <inspect|connect> ...` */
export async function mcpCommand(deps: StackDeps, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "inspect") return inspect(deps, rest);
  if (sub === "connect") throw usageError(MCP_CONNECT_REMOVED);
  throw usageError(`Usage:\n${mcpUsage}`);
}
