import type { ApprovalMode, McpServerManifest } from "../types/manifest.js";
import { APPROVAL_REMOVED } from "./approval.js";

type WithOptionalName<T> = T extends { readonly name: string }
  ? Omit<T, "name"> & { readonly name?: string }
  : never;

/** An MCP server as written by an author: `name` defaults to the server's key. */
export type McpServerSpec = WithOptionalName<McpServerManifest>;

export class McpError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "McpError";
    this.code = code;
  }
}

/** Why a `stdio` MCP server is refused: the one message the builder, plugins and manifests give. */
export function stdioMcpRefusal(name: string): string {
  return `MCP server '${name}' uses stdio; Nylorun accepts remote MCP servers only (streamable-http or sse). Run the server behind an HTTP transport and declare its URL.`;
}

/** Validate a map of MCP servers and fill each `name` from its key. */
export function normalizeMcpServers(
  servers: Readonly<Record<string, McpServerSpec>>,
  caller = "mcp()"
): Readonly<Record<string, McpServerManifest>> {
  if (!isRecord(servers)) {
    throw new McpError(
      "mcp.invalid",
      `${caller} expects a non-empty map of MCP servers`
    );
  }
  const entries = Object.entries(servers);
  if (entries.length === 0) {
    throw new McpError(
      "mcp.empty",
      `${caller} requires at least one MCP server`
    );
  }
  const mcpServers: Record<string, McpServerManifest> = {};
  for (const [key, spec] of entries) {
    const server = isRecord(spec) && spec.name === undefined ? { ...spec, name: key } : spec;
    if (isRecord(server) && (server.type as string) === "stdio")
      throw new McpError("mcp.stdio", stdioMcpRefusal(key));
    if (isRecord(server) && setsApproval(server))
      throw new McpError("mcp.approval-removed", `MCP server '${key}': ${APPROVAL_REMOVED}`);
    if (!isMcpServer(server)) {
      throw new McpError(
        "mcp.invalid-server",
        `MCP server '${key}' is not a valid streamable-http or sse declaration` +
          (isRecord(server) && (server.tools !== undefined || server.deferred !== undefined)
            ? ": deferred is a boolean, and tools maps tool names to { enabled?, deferred? }"
            : "")
      );
    }
    if (server.name !== key) {
      throw new McpError(
        "mcp.name-mismatch",
        `MCP server key '${key}' must equal the server name '${server.name}'`
      );
    }
    mcpServers[key] = freezeServer(server);
  }
  return Object.freeze(mcpServers);
}

/** The key of an MCP server's `tools` map that sets every tool without an entry (R2b C9). */
export const MCP_TOOL_DEFAULTS = "*";

/** A tool's settings once resolved (R2b C9): its entry, then `"*"`, then the server, then the default. */
export interface ResolvedMcpToolSettings {
  readonly enabled: boolean;
  readonly approval: ApprovalMode;
  /** Undefined: nothing sets it, and the harness decides (R2b C10, automatic deferral). */
  readonly deferred?: boolean;
}

/**
 * The settings of the server's tool named `serverToolName` (its own name, before C6 renaming):
 * from the tool's entry in `tools`, then the `"*"` entry, then the server, then the default
 * (enabled, approval `never`, deferral automatic).
 */
export function mcpToolSettings(
  server: McpServerManifest,
  serverToolName: string
): ResolvedMcpToolSettings {
  const own = Object.hasOwn(server.tools ?? {}, serverToolName)
    ? server.tools![serverToolName]
    : undefined;
  const defaults = server.tools?.[MCP_TOOL_DEFAULTS];
  const deferred = own?.deferred ?? defaults?.deferred ?? server.deferred;
  return {
    enabled: own?.enabled ?? defaults?.enabled ?? true,
    approval: own?.approval ?? defaults?.approval ?? server.approval ?? "never",
    ...(deferred === undefined ? {} : { deferred }),
  };
}

function freezeServer(server: McpServerManifest): McpServerManifest {
  return Object.freeze({
    name: server.name,
    type: server.type,
    url: server.url,
    ...(server.headers === undefined
      ? {}
      : { headers: Object.freeze({ ...server.headers }) }),
    ...(server.deferred === undefined ? {} : { deferred: server.deferred }),
    ...(server.tools === undefined
      ? {}
      : {
          tools: Object.freeze(
            Object.fromEntries(
              Object.entries(server.tools).map(([name, settings]) => [
                name,
                Object.freeze({
                  ...(settings.enabled === undefined ? {} : { enabled: settings.enabled }),
                  ...(settings.deferred === undefined ? {} : { deferred: settings.deferred }),
                }),
              ])
            )
          ),
        }),
  });
}

function isMcpServer(value: unknown): value is McpServerManifest {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name)
    return false;
  if (value.type === "streamable-http" || value.type === "sse")
    return (
      typeof value.url === "string" &&
      value.url.length > 0 &&
      (value.deferred === undefined || typeof value.deferred === "boolean") &&
      (value.tools === undefined || isToolSettingsMap(value.tools))
    );
  return false;
}

/** A server, or one of its tools' settings, that sets `approval` (removed in R5 step 2). */
function setsApproval(server: Record<string, unknown>): boolean {
  if (server.approval !== undefined) return true;
  return isRecord(server.tools) && Object.values(server.tools).some((settings) => isRecord(settings) && settings.approval !== undefined);
}

function isToolSettingsMap(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([name, settings]) =>
      name.length > 0 &&
      isRecord(settings) &&
      Object.keys(settings).every((key) => key === "enabled" || key === "deferred") &&
      (settings.enabled === undefined || typeof settings.enabled === "boolean") &&
      (settings.deferred === undefined || typeof settings.deferred === "boolean")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
