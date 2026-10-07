import type { CapabilityDeclaration } from "../types/middleware.js";
import type { ApprovalMode, ManifestSchemaVersion, McpServerManifest } from "../types/manifest.js";
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
 * the key and, when given, must equal it. Nylorun accepts remote servers only:
 * `streamable-http` and `sse` (see https://agent-plugins.org/plugin-authors/mcp-servers).
 *
 * ```ts
 * Agent({ id: "assistant" }).mcp({
 *   github: { type: "streamable-http", url: "https://mcp.example.com/github" },
 * })
 * ```
 *
 * `tools` sets tools by the server's own names, with `"*"` for the rest: an allowlist, approval
 * per tool, deferral per tool (R2b C9, C10). `deferred` defers every tool of the server. Either
 * makes the manifest v6.
 *
 * ```ts
 * Agent({ id: "assistant" }).mcp({
 *   github: {
 *     type: "streamable-http",
 *     url: "https://api.githubcopilot.com/mcp/",
 *     tools: {
 *       "*": { enabled: false },
 *       search_issues: { enabled: true },
 *       create_issue: { enabled: true, approval: "always" },
 *     },
 *   },
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
    if (!isMcpServer(server)) {
      throw new McpError(
        "mcp.invalid-server",
        `MCP server '${key}' is not a valid streamable-http or sse declaration` +
          (isRecord(server) && (server.tools !== undefined || server.deferred !== undefined)
            ? ": deferred is a boolean, and tools maps tool names to { enabled?, approval?, deferred? }"
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
  /** Undefined: nothing sets it, and the Runtime decides (R2b C10, automatic deferral). */
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

/** True when the server sets `tools` or `deferred`, which need manifest v6 (R2b C9, Q19). */
export function usesMcpToolSettings(server: McpServerManifest): boolean {
  return server.tools !== undefined || server.deferred !== undefined;
}

/** Why a manifest v5 with this server is refused (R2b C9, Q19). */
export function mcpToolSettingsVersionIssue(serverName: string): string {
  return `MCP server '${serverName}' sets tools or deferred, which need manifestSchemaVersion 6. Rebuild the agent with the current SDK`;
}

/**
 * The manifest version a definition with these capabilities needs: 6 when an MCP server sets
 * `tools` or `deferred`, else 5, so a manifest that uses neither keeps its hash (Q19).
 */
export function manifestVersionFor(
  capabilities: readonly { readonly mcpServers?: Readonly<Record<string, McpServerManifest>> }[]
): ManifestSchemaVersion {
  return capabilities.some((capability) =>
    Object.values(capability.mcpServers ?? {}).some(usesMcpToolSettings)
  )
    ? 6
    : 5;
}

function freezeServer(server: McpServerManifest): McpServerManifest {
  return Object.freeze({
    name: server.name,
    type: server.type,
    url: server.url,
    ...(server.headers === undefined
      ? {}
      : { headers: Object.freeze({ ...server.headers }) }),
    ...(server.approval === undefined ? {} : { approval: server.approval }),
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
                  ...(settings.approval === undefined ? {} : { approval: settings.approval }),
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
      (value.approval === undefined || isApprovalMode(value.approval)) &&
      (value.deferred === undefined || typeof value.deferred === "boolean") &&
      (value.tools === undefined || isToolSettingsMap(value.tools))
    );
  return false;
}

const isApprovalMode = (value: unknown) => (APPROVAL_MODES as readonly unknown[]).includes(value);

function isToolSettingsMap(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([name, settings]) =>
      name.length > 0 &&
      isRecord(settings) &&
      Object.keys(settings).every((key) => key === "enabled" || key === "approval" || key === "deferred") &&
      (settings.enabled === undefined || typeof settings.enabled === "boolean") &&
      (settings.approval === undefined || isApprovalMode(settings.approval)) &&
      (settings.deferred === undefined || typeof settings.deferred === "boolean")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
