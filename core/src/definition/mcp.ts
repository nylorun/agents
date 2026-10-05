import type { CapabilityDeclaration } from "../types/middleware.js";
import type { McpServerManifest } from "../types/manifest.js";
import { APPROVAL_MODES } from "./http-tool.js";

type WithOptionalName<T> = T extends { readonly name: string }
  ? Omit<T, "name"> & { readonly name?: string }
  : never;

/** An MCP server as written by an author: `name` defaults to the server's key. */
export type McpServerSpec = WithOptionalName<McpServerManifest>;

export interface McpOptions {
  /** Capability id. Defaults to `"mcp"`. */
  readonly id?: string;
}

export interface McpCapability extends CapabilityDeclaration {
  readonly mcpServers: Readonly<Record<string, McpServerManifest>>;
}

export class McpError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "McpError";
    this.code = code;
  }
}

/**
 * Declare MCP servers as one capability.
 *
 * Prefer `Agent(...).mcp({ ... })`. Each key names a server; its `name` defaults to
 * the key and, when given, must equal it. Supported transports are `stdio`,
 * `streamable-http`, and `sse` (see https://agent-plugins.org/plugin-authors/mcp-servers).
 *
 * ```ts
 * Agent({ id: "assistant" }).mcp({
 *   github: { type: "streamable-http", url: "https://mcp.example.com/github" },
 * })
 * ```
 */
export function mcp(
  servers: Readonly<Record<string, McpServerSpec>>,
  options: McpOptions = {}
): McpCapability {
  const id = options.id ?? "mcp";
  return { id, mcpServers: normalizeMcpServers(servers, "mcp()") };
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
    if (!isMcpServer(server)) {
      throw new McpError(
        "mcp.invalid-server",
        `MCP server '${key}' is not a valid stdio, streamable-http, or sse declaration`
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

function freezeServer(server: McpServerManifest): McpServerManifest {
  if (server.type === "stdio") {
    return Object.freeze({
      name: server.name,
      type: "stdio" as const,
      command: server.command,
      ...(server.args === undefined ? {} : { args: Object.freeze([...server.args]) }),
      ...(server.env === undefined
        ? {}
        : { env: Object.freeze({ ...server.env }) }),
      ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
    });
  }
  return Object.freeze({
    name: server.name,
    type: server.type,
    url: server.url,
    ...(server.headers === undefined
      ? {}
      : { headers: Object.freeze({ ...server.headers }) }),
    ...(server.approval === undefined ? {} : { approval: server.approval }),
  });
}

function isMcpServer(value: unknown): value is McpServerManifest {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name)
    return false;
  if (value.type === "stdio")
    return typeof value.command === "string" && value.command.length > 0;
  if (value.type === "streamable-http" || value.type === "sse")
    return (
      typeof value.url === "string" &&
      value.url.length > 0 &&
      (value.approval === undefined || (APPROVAL_MODES as readonly unknown[]).includes(value.approval))
    );
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
