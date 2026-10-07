import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerManifest } from "@nylorun/core/define";
import type { JsonObject } from "@nylorun/core/define";
import { schemaFromJSON } from "@nylorun/core/define";
import { guardedFetch, type OutboundPolicy } from "../tenant/outbound.js";
import type { AuthorizeResult } from "../vault/service.js";
import {
  modelToolName,
  type McpDiagnostic,
  type McpToolRecord,
} from "./snapshot.js";

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

/** What a failed tool call says to the model (`callMcpTool`). */
export type McpToolFailure = {
  readonly kind: "failed";
  readonly code: string;
  readonly message: string;
  /** With `credential_rejected`: the server, and the scope of the vault whose credential was sent. */
  readonly server?: string;
  readonly vault?: "installation" | "user";
};

/**
 * A request the server answered `401` (R2b C1): it rejected the vault's credential, or wanted one
 * and got none. Never retried, since nothing the gate holds changes between tries (Q4). A tool
 * call that meets it fails with `code` for the model to see; at discovery it is the server's
 * `failed` diagnostic.
 */
export class CredentialRejected extends Error {
  readonly code = "credential_rejected";

  constructor(
    readonly server: string,
    /** The scope of the vault whose credential was sent; absent when none was. */
    readonly vault?: "installation" | "user",
  ) {
    super(
      vault === undefined
        ? `The MCP server '${server}' answered HTTP 401: it needs a credential, and the session's vaults hold none for it`
        : `The MCP server '${server}' answered HTTP 401: it rejected the credential from the ${vault} vault`,
    );
    this.name = "CredentialRejected";
  }

  /** The failed tool outcome the model sees. */
  outcome(): McpToolFailure {
    return {
      kind: "failed",
      code: this.code,
      message: this.message,
      server: this.server,
      ...(this.vault === undefined ? {} : { vault: this.vault }),
    };
  }
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
  authorize: (url: string) => Promise<AuthorizeResult>;
  /**
   * How a remote server is reached: the Host's address policy for developer URLs
   * (`TenantConfig.delivery`), so `localhost` means the Docker host in the local stack and a
   * Host that refuses private addresses refuses them here too. Default: no limits.
   */
  policy?: OutboundPolicy;
}): Promise<LiveConnection> {
  const authorize = input.authorize;
  const initial = await authorize(input.server.url);
  if (initial.status === "refused") {
    const error = new Error(`MCP authorization refused: ${initial.reason}`);
    (error as Error & { credentialIds?: readonly string[] }).credentialIds =
      initial.credentialIds;
    throw error;
  }
  // A credential with `via` sends the server's requests there (R2b C2); the manifest's URL still
  // names the server for its credential, its tools and its diagnostics.
  const url = new URL(endpointOf(input.server, initial));
  const fetchImpl = authorizedFetch(input.server, url, authorize, input.policy ?? {});
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
): Promise<{ kind: "completed"; output: unknown } | McpToolFailure> {
  let result: Record<string, unknown>;
  try {
    result = await client.callTool(
      {
        name: serverToolName,
        arguments:
          args && typeof args === "object" && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : {},
      },
      options,
    );
  } catch (error) {
    // The server answered, so the outcome is known: the model sees it, not an uncertain call.
    if (error instanceof CredentialRejected) return error.outcome();
    throw error;
  }
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
    error instanceof CredentialRejected ||
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

/** Where `server`'s requests go: the credential's `via`, else the URL the manifest names. */
function endpointOf(server: McpServerManifest, result: AuthorizeResult): string {
  return result.status === "authorized" && result.via !== undefined ? result.via : server.url;
}

/**
 * The transport's fetch: each request to `endpoint`'s origin carries the credential read for it
 * now. A `401` answer is `CredentialRejected`.
 */
function authorizedFetch(
  server: McpServerManifest,
  endpoint: URL,
  authorize: (url: string) => Promise<AuthorizeResult>,
  policy: OutboundPolicy,
): (url: string | URL, init?: RequestInit) => Promise<Response> {
  const send = guardedFetch(policy, { stream: true });
  return async (url, init) => {
    const target = typeof url === "string" ? url : url.href;
    if (!sameOrigin(target, endpoint.href))
      throw new Error("MCP request origin does not match the declared server");
    const result = await authorize(server.url);
    if (result.status === "refused") {
      const error = new Error(`MCP authorization refused: ${result.reason}`);
      (error as Error & { credentialIds?: readonly string[] }).credentialIds =
        result.credentialIds;
      throw error;
    }
    // A credential whose `via` changed since the connection opened: never send it elsewhere.
    if (!sameOrigin(endpointOf(server, result), endpoint.href))
      throw new Error("The MCP server's credential now sends it elsewhere; the connection must reopen");
    const headers = new Headers();
    for (const [key, value] of Object.entries(server.headers ?? {}))
      headers.set(key, value);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    // Credential headers, the identity header included, replace manifest headers of the same name.
    if (result.status === "authorized")
      for (const [key, value] of Object.entries(result.headers)) headers.set(key, value);
    // No redirects, and the address checked on what is connected to (`tenant/outbound.ts`).
    const response = await send(target, { ...init, headers });
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      throw new CredentialRejected(
        server.name,
        result.status === "authorized" ? result.vault : undefined,
      );
    }
    return response;
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
