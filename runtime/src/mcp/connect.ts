import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerManifest } from "@nylorun/core/define";
import type { JsonObject } from "@nylorun/core/define";
import { schemaFromJSON } from "@nylorun/core/define";
import type { AuthorizeResult } from "../vault/service.js";
import {
  modelToolName,
  type McpDiagnostic,
  type McpToolRecord,
} from "./snapshot.js";
import { prepareStdioLaunch } from "./stdio.js";

/** Options of one MCP request. */
export interface McpRequestOptions {
  readonly signal?: AbortSignal;
}

/** Options of one tool call. */
export interface McpCallOptions extends McpRequestOptions {
  /**
   * The call's effect id. A gate runs a keyed call once and keeps its outcome, so a re-send
   * after a takeover joins it (F4.1). An in-process connection ignores it.
   */
  readonly key?: string;
}

/** A page of `tools/list`, as the MCP SDK returns it. */
export interface McpToolPage {
  readonly tools: readonly {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema?: unknown;
    readonly outputSchema?: unknown;
  }[];
  readonly nextCursor?: string;
}

/**
 * What the pool needs of an MCP client: the SDK `Client` over a transport of this process
 * (`sdkClient`), or a client of the gates service that holds the real connection
 * (`gates/tool-client.ts`).
 */
export interface McpClient {
  listTools(params?: { cursor?: string }, options?: McpRequestOptions): Promise<McpToolPage>;
  /** The raw `CallToolResult`; `callMcpTool` reads it. */
  callTool(
    params: { name: string; arguments: Record<string, unknown> },
    options?: McpCallOptions,
  ): Promise<Record<string, unknown>>;
}

export interface LiveConnection {
  readonly client: McpClient;
  close(): Promise<void>;
}

/** An SDK `Client` as an `McpClient`. */
export function sdkClient(client: Client): McpClient {
  return {
    listTools: (params, options) =>
      client.listTools(params, options?.signal ? { signal: options.signal } : undefined),
    callTool: (params, options) =>
      client.callTool(
        params,
        undefined,
        options?.signal ? { signal: options.signal } : undefined,
      ) as Promise<Record<string, unknown>>,
  };
}

export async function openMcpServer(input: {
  server: McpServerManifest;
  authorize?: (url: string) => Promise<AuthorizeResult>;
  pluginRoot?: string;
  pluginData: string;
  childEnv?: Readonly<Record<string, string>>;
}): Promise<LiveConnection> {
  if (input.server.type === "stdio") {
    const launch = prepareStdioLaunch(input.server, {
      pluginRoot: input.pluginRoot,
      pluginData: input.pluginData,
      childEnv: input.childEnv,
    });
    const transport = new StdioClientTransport({
      command: launch.command,
      args: [...launch.args],
      cwd: launch.cwd,
      // Full explicit env so HOME/TMPDIR from the Tenant override getDefaultEnvironment().
      env: { ...launch.env },
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => {});
    const client = createClient();
    await client.connect(transport);
    return { client: sdkClient(client), close: () => client.close() };
  }
  const authorize = input.authorize;
  if (!authorize) throw new Error("HTTP MCP server requires authorization");
  const initial = await authorize(input.server.url);
  if (initial.status === "refused") {
    const error = new Error(`MCP authorization refused: ${initial.reason}`);
    (error as Error & { credentialIds?: readonly string[] }).credentialIds =
      initial.credentialIds;
    throw error;
  }
  const fetchImpl = authorizedFetch(input.server, authorize);
  const url = new URL(input.server.url);
  const transport =
    input.server.type === "sse"
      ? new SSEClientTransport(url, { fetch: fetchImpl })
      : new StreamableHTTPClientTransport(url, { fetch: fetchImpl });
  const client = createClient();
  await client.connect(transport);
  return { client: sdkClient(client), close: () => client.close() };
}

export async function listMcpTools(
  client: McpClient,
  input: { capabilityId: string; serverName: string; taken: Set<string>; signal?: AbortSignal },
): Promise<{ tools: McpToolRecord[]; omitted: string[] }> {
  const tools: McpToolRecord[] = [];
  const omitted: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const listed = await client.listTools(
      cursor ? { cursor } : undefined,
      input.signal ? { signal: input.signal } : undefined,
    );
    for (const tool of listed.tools) {
      if (typeof tool.name !== "string" || tool.name.length === 0) continue;
      const name = modelToolName(input.serverName, tool.name);
      const inputSchema = usableSchema(tool.inputSchema);
      if (!inputSchema || input.taken.has(name)) {
        omitted.push(name);
        continue;
      }
      const outputSchema = tool.outputSchema
        ? usableSchema(tool.outputSchema)
        : undefined;
      input.taken.add(name);
      tools.push({
        capabilityId: input.capabilityId,
        serverName: input.serverName,
        serverToolName: tool.name,
        name,
        ...(typeof tool.description === "string" && tool.description.length > 0
          ? { description: tool.description }
          : {}),
        inputSchema,
        ...(outputSchema === undefined ? {} : { outputSchema }),
      });
    }
    cursor = listed.nextCursor;
    if (!cursor) break;
  }
  return { tools, omitted };
}

export async function callMcpTool(
  client: McpClient,
  serverToolName: string,
  args: unknown,
  options: McpCallOptions = {},
): Promise<{ kind: "completed"; output: unknown } | { kind: "failed"; code: string; message: string }> {
  const result = await client.callTool(
    {
      name: serverToolName,
      arguments:
        args && typeof args === "object" && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : {},
    },
    options,
  );
  if ("isError" in result && result.isError) {
    return {
      kind: "failed",
      code: "mcp.tool",
      message: textContent(result.content) || "MCP tool failed",
    };
  }
  if ("structuredContent" in result && result.structuredContent !== undefined)
    return { kind: "completed", output: result.structuredContent };
  const text = "content" in result ? textContent(result.content) : undefined;
  if (text !== undefined) return { kind: "completed", output: text };
  return {
    kind: "completed",
    output: "content" in result ? result.content : result,
  };
}

export function diagnosticFromError(
  capabilityId: string,
  serverName: string,
  error: unknown,
): McpDiagnostic {
  const credentialIds =
    error && typeof error === "object" && "credentialIds" in error
      ? (error as { credentialIds?: readonly string[] }).credentialIds
      : undefined;
  const refused =
    error instanceof Error && error.message.startsWith("MCP authorization refused");
  if (refused) {
    return {
      capabilityId,
      serverName,
      outcome: "refused",
      message: error.message,
      ...(credentialIds === undefined ? {} : { credentialIds }),
    };
  }
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: number }).code
      : undefined;
  const unauthorized =
    code === 401 ||
    (error instanceof Error && /\b401\b/.test(error.message));
  return {
    capabilityId,
    serverName,
    outcome: "failed",
    message: unauthorized
      ? "MCP server returned 401"
      : error instanceof Error
        ? error.message.slice(0, 500)
        : "MCP server connection failed",
  };
}

function createClient(): Client {
  return new Client(
    { name: "nylorun-runtime", version: "0.6.0" },
    { capabilities: {} },
  );
}

function authorizedFetch(
  server: Extract<McpServerManifest, { type: "streamable-http" | "sse" }>,
  authorize: (url: string) => Promise<AuthorizeResult>,
): (url: string | URL, init?: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const target = typeof url === "string" ? url : url.href;
    if (!sameOrigin(target, server.url))
      throw new Error("MCP request origin does not match the declared server");
    const result = await authorize(server.url);
    if (result.status === "refused") {
      const error = new Error(`MCP authorization refused: ${result.reason}`);
      (error as Error & { credentialIds?: readonly string[] }).credentialIds =
        result.credentialIds;
      throw error;
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(server.headers ?? {}))
      headers.set(key, value);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    if (result.status === "authorized")
      for (const [key, value] of Object.entries(result.headers)) headers.set(key, value);
    return fetch(target, { ...init, headers, redirect: "error" });
  };
}

function sameOrigin(requestUrl: string, serverUrl: string): boolean {
  try {
    return new URL(requestUrl).origin === new URL(serverUrl).origin;
  } catch {
    return false;
  }
}

function usableSchema(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const schema = JSON.parse(JSON.stringify(value)) as JsonObject;
  try {
    schemaFromJSON(schema);
  } catch {
    return undefined;
  }
  return schema;
}

function textContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter(
      (part): part is { type: "text"; text: string } =>
        !!part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text);
  return text.length === 0 ? undefined : text.join("\n");
}
