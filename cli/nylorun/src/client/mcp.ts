/**
 * `nylorun tenant mcp inspect <url>`: a remote MCP server's tools before an agent names it (R2b
 * C12), through the Management API (`POST /v1/tenant/mcp/preview`) of the installation
 * `target.ts` picks. It never starts a local Tenant, and the Runtime never calls a tool. `--environment <id>` sends that Environment's
 * credential for the URL (protocol 11; it replaced `--vault`); an Environment's secrets are
 * written on the Runtime API (`client.environments.secrets.put` of `@nylorun/agents`). Its
 * `connect` subcommand (MCP OAuth) was removed in protocol 10, and says so.
 */
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import type { McpPreview, McpPreviewTool } from "@nylorun/core/contracts";
import { CliError } from "../errors.js";
import { parseStackFlags, type StackDeps } from "../stack/commands.js";
import { connect } from "./target.js";

export const mcpUsage = `  mcp inspect <url> [--server <name>] [--environment <id>] [--sse] [--tenant <name>] [--json]
                                      list a remote MCP server's tools, with Environment <id>'s
                                      credential for <url> (none without it): model names, schema
                                      sizes, renames, or that it needs a person's sign-in (the
                                      Runtime calls no tool)`;

const INSPECT_USAGE =
  "nylorun tenant mcp inspect <url> [--server <name>] [--environment <id>] [--sse] [--tenant <name>] [--json]";

/** Where a credential for an MCP server goes since protocol 11. */
const SECRET_HINT =
  "write it as a bearer or headers secret of an Environment (client.environments.secrets.put of @nylorun/agents, or Studio)";

/** What `--vault` says since protocol 11. */
export const MCP_VAULT_REMOVED =
  "--vault was removed in protocol 11: a credential is a secret of an Environment, in its own vault. Pass --environment <id> to send that Environment's credential for the URL.";

/** What the removed `connect` subcommand says since protocol 10. */
export const MCP_CONNECT_REMOVED =
  `The connect subcommand of nylorun mcp was removed with MCP OAuth (protocol 10): ${SECRET_HINT.replace("write it", "write the server's key")}, or reach a server that needs a person's sign-in through a gateway (a secret with via). See its tools with nylorun tenant mcp inspect <url> --environment <id>.`;

/** The preview takes up to 15 s in the Runtime; the hop gets a margin. */
const PREVIEW_TIMEOUT_MS = 30_000;
const DESCRIPTION_CHARS = 60;

const usageError = (message: string) => new CliError(message, 2);

async function inspect(deps: StackDeps, args: readonly string[]): Promise<number> {
  if (args.some((arg) => arg === "--vault" || arg.startsWith("--vault=")))
    throw usageError(MCP_VAULT_REMOVED);
  const flags = parseStackFlags(
    args,
    { booleans: ["--json", "--sse"], values: ["--server", "--environment", "--tenant"] },
    INSPECT_USAGE,
  );
  if (flags.rest.length !== 1) throw usageError(`Usage: ${INSPECT_USAGE}`);
  const url = flags.rest[0]!;
  const name = flags.values.get("--server");
  const environmentId = flags.values.get("--environment");
  const tenant = flags.values.get("--tenant");
  const api = await connect(deps, "management", tenant);
  if (!api.managementKey)
    throw new CliError(`No management key for ${api.label}: set NYLORUN_MANAGEMENT_KEY.`, 1);
  const response = await deps.fetch(`${api.url}/v1/tenant/mcp/preview`, {
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
      ...(environmentId === undefined ? {} : { environmentId }),
    }),
    redirect: "error",
    signal: AbortSignal.timeout(PREVIEW_TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.status === 404 && body.code === "not_found")
    throw new CliError(
      `${api.label} runs a Runtime without MCP previews. Update it.`,
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
  for (const line of previewLines(preview, environmentId)) deps.out(line);
  return 0;
}

/** A preview as a person reads it: the server, a table of tools, the renames, or the sign-in hint. */
export function previewLines(preview: McpPreview, environmentId?: string): string[] {
  const credential = preview.credentialSent
    ? `with Environment ${environmentId ?? "(unnamed)"}'s credential`
    : environmentId === undefined
      ? "with no credential (pass --environment <id> to send an Environment's)"
      : `with no credential (Environment ${environmentId} holds none for this URL)`;
  if (preview.authRequired) {
    const metadata = preview.authRequired.resourceMetadata;
    const servers = Array.isArray(metadata?.authorization_servers)
      ? (metadata.authorization_servers as unknown[]).filter((item) => typeof item === "string")
      : [];
    return [
      preview.credentialSent
        ? `The MCP server at ${preview.url} answered 401: it rejected Environment ${environmentId ?? "(unnamed)"}'s credential.`
        : `The MCP server at ${preview.url} answered 401: it needs a credential.`,
      ...(servers.length > 0
        ? [`It signs people in with ${servers.join(", ")} (${preview.authRequired.resourceMetadataUrl}).`]
        : []),
      `Nylorun holds no OAuth client: ${SECRET_HINT.replace("write it", "write the server's API key")},`,
      "and pass --environment <id>; or reach it through a gateway that keeps each person's sign-in",
      "(a secret with via and an identity header).",
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

/** `nylorun tenant mcp <inspect|connect> ...` */
export async function mcpCommand(deps: StackDeps, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "inspect") return inspect(deps, rest);
  if (sub === "connect") throw usageError(MCP_CONNECT_REMOVED);
  throw usageError(`Usage:\n${mcpUsage}`);
}
