import { AsyncLocalStorage } from "node:async_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerManifest } from "@nylorun/core/define";
import type { JsonObject } from "@nylorun/core/define";
import {
  MCP_TOOL_DEFAULTS,
  SERVER_INSTRUCTIONS_MAX_CHARS,
  mcpToolSettings,
  schemaFromJSON,
} from "@nylorun/core/define";
import { scrub, scrubValues } from "../redact.js";
import {
  guardedFetch,
  MAX_RESPONSE_BYTES,
  OutboundFailed,
  OutboundRefused,
  type OutboundPolicy,
} from "../tenant/outbound.js";
import { credentialSecrets } from "../vault/headers.js";
import type { AuthorizeResult } from "../vault/service.js";
import {
  normalizeToolName,
  type McpDiagnostic,
  type McpRenamedTool,
  type McpToolRecord,
} from "./snapshot.js";

/** How much of a failed answer's body the model sees. */
export const MCP_ERROR_BODY_CHARS = 2_000;

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
    readonly annotations?: Readonly<Record<string, unknown>>;
  }[];
  readonly nextCursor?: string;
}

/**
 * A `tools/call` answer: the raw `CallToolResult`, with each credential value sent for the call
 * that it echoes replaced by `[redacted]` (R2b C8).
 */
export interface McpCallAnswer {
  readonly result: Record<string, unknown>;
  /** How many values were replaced; absent when none. */
  readonly redacted?: number;
}

/**
 * What the pool needs of an MCP client: the SDK `Client` over a transport of this process
 * (`sdkClient`), or a client of the gates service that holds the real connection
 * (`gates/tool-client.ts`).
 */
export interface McpClient {
  listTools(params?: { cursor?: string }, options?: McpRequestOptions): Promise<McpToolPage>;
  /**
   * One `tools/call`; `callMcpTool` reads its answer. A call that failed at the transport or
   * the server rejects with `McpCallFailed`; any other rejection leaves its fate unknown.
   */
  callTool(
    params: { name: string; arguments: Record<string, unknown> },
    options?: McpCallOptions,
  ): Promise<McpCallAnswer>;
}

export interface LiveConnection {
  readonly client: McpClient;
  /** The server's instructions from `initialize`, cut (`serverInstructions`); absent when none. */
  readonly instructions?: string;
  /**
   * The server's `serverInfo` from `initialize` (name, version, title), without a credential
   * value sent; absent from a connection the gates service holds.
   */
  readonly serverInfo?: Readonly<Record<string, unknown>>;
  close(): Promise<void>;
}

/** What a failed tool call says to the model (`callMcpTool`). */
export type McpToolFailure = {
  readonly kind: "failed";
  readonly code: string;
  readonly message: string;
  /** True when calling again may work (R2b C7). */
  readonly retryable?: boolean;
  /** With `credential_rejected`: the server, and the scope of the vault whose credential was sent. */
  readonly server?: string;
  readonly vault?: "installation" | "user";
  /** How many credential values the message had in it, replaced (R2b C8). */
  readonly redacted?: number;
};

/** What a tool call came to (`callMcpTool`). */
export type McpToolOutcome =
  | { readonly kind: "completed"; readonly output: unknown; readonly redacted?: number }
  | McpToolFailure;

/**
 * How a tool call failed at the transport or the server (R2b C7), as the gate answers it:
 * - `mcp.unreachable`: never sent (address policy, DNS, refused connection, TLS, a connection
 *   that could not be opened). Calling again may work.
 * - `credential_rejected`: the server answered `401` (C1).
 * - `mcp.forbidden`: the server answered `403`.
 * - `mcp.error`: the server answered a JSON-RPC error; the message has its code.
 * - `mcp.status`: the server answered another HTTP error status, without a JSON-RPC error.
 * - `mcp.lost`: sent, and the answer was lost, so the tool may have run. The model sees it only
 *   for a tool the server marks read-only or idempotent (Q15); any other call is `uncertain`.
 * - `mcp.too-large`: the answer passed `MCP_RESULT_MAX_BYTES` (R2b C11), as an HTTP tool's
 *   answer is `http.too-large`. The tool ran; its answer was not kept.
 */
export type McpFailureCode =
  | "mcp.unreachable"
  | "credential_rejected"
  | "mcp.forbidden"
  | "mcp.error"
  | "mcp.status"
  | "mcp.lost"
  | "mcp.too-large";

/**
 * The largest `tools/call` answer the gate holds (R2b C11): 8 MiB, an HTTP tool's cap. Core
 * stores what does not fit a tool result as an artifact (`tenant/tool-results.ts`).
 */
export const MCP_RESULT_MAX_BYTES = MAX_RESPONSE_BYTES;

export interface McpCallFailure {
  readonly code: McpFailureCode;
  readonly message: string;
  /** The request reached the server, so it may have acted on it. */
  readonly sent: boolean;
  readonly retryable: boolean;
  /** With `credential_rejected`: the server, and the scope of the vault whose credential was sent. */
  readonly server?: string;
  readonly vault?: "installation" | "user";
  /** How many credential values the message had in it, replaced (R2b C8). */
  readonly redacted?: number;
}

/** A tool call that failed with a code the model can act on (R2b C7). */
export class McpCallFailed extends Error {
  constructor(readonly failure: McpCallFailure) {
    super(failure.message);
    this.name = "McpCallFailed";
  }

  get code(): McpFailureCode {
    return this.failure.code;
  }

  /** The failure the gate answered, as the class the loop's own call would have thrown. */
  static from(failure: McpCallFailure): McpCallFailed {
    return failure.code === "credential_rejected" && failure.server !== undefined
      ? new CredentialRejected(failure.server, failure.vault)
      : new McpCallFailed(failure);
  }

  /** The failed tool outcome the model sees. */
  outcome(): McpToolFailure {
    const failure = this.failure;
    return {
      kind: "failed",
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable,
      ...(failure.server === undefined ? {} : { server: failure.server }),
      ...(failure.vault === undefined ? {} : { vault: failure.vault }),
      ...(failure.redacted ? { redacted: failure.redacted } : {}),
    };
  }
}

/**
 * A request the server answered `401` (R2b C1): it rejected the vault's credential, or wanted one
 * and got none. Never retried, since nothing the gate holds changes between tries (Q4). A tool
 * call that meets it fails with `credential_rejected` for the model to see; at discovery it is the
 * server's `failed` diagnostic.
 */
export class CredentialRejected extends McpCallFailed {
  constructor(
    readonly server: string,
    /** The scope of the vault whose credential was sent; absent when none was. */
    readonly vault?: "installation" | "user",
    /**
     * The answer's `WWW-Authenticate`, which may name the server's protected-resource metadata
     * (RFC 9728 `resource_metadata`): a tool preview reads it (R2b C12). Never shown to the model.
     */
    readonly challenge?: string,
  ) {
    super({
      code: "credential_rejected",
      message:
        vault === undefined
          ? `The MCP server '${server}' answered HTTP 401: it needs a credential, and the session's vaults hold none for it`
          : `The MCP server '${server}' answered HTTP 401: it rejected the credential from the ${vault} vault`,
      sent: true,
      retryable: false,
      server,
      ...(vault === undefined ? {} : { vault }),
    });
    this.name = "CredentialRejected";
  }
}

/**
 * A request its connection can no longer make, refused before it reached a tool: the server
 * answered `404` to the connection's `Mcp-Session-Id` (the session is gone, MCP 2025-06-18
 * "Session Management"), or the credential's `via` now sends the server's requests elsewhere.
 * Whoever holds the connection drops it, opens it again and sends the call once more (R2b C7).
 * When that fails too, it is `mcp.unreachable`: nothing ran.
 */
export class McpConnectionStale extends McpCallFailed {
  constructor(server: string, reason: string) {
    super({
      code: "mcp.unreachable",
      message: `The MCP server '${server}' ${reason}, and the call was not sent`,
      sent: false,
      retryable: true,
    });
    this.name = "McpConnectionStale";
  }
}

/** A tool call that never reached its server: its connection could not be opened. */
export function unreachable(server: string, error: unknown): McpCallFailed {
  if (error instanceof McpCallFailed) return error;
  return unreachableFailure(server, error instanceof Error ? error.message : String(error));
}

/**
 * What one MCP operation sent (R2b C7, C8), kept for the requests the SDK makes under it: the
 * credential values, whether a request was sent in full, and for a tool call whether its answer
 * was lost on the way back.
 */
interface Tracker {
  readonly secrets: Set<string>;
  sent: boolean;
  /** Why the answer was lost after the request was sent. */
  lost?: string;
  /** A tool call's answer passed `MCP_RESULT_MAX_BYTES` (R2b C11). */
  tooLarge?: boolean;
  /** A tool call's: aborted when its answer is lost or too large, so the call ends now. */
  readonly calling?: AbortController;
  settled: boolean;
}

/** The operation a request of the transport's fetch belongs to. */
const tracking = new AsyncLocalStorage<Tracker>();

function tracked<T>(call: boolean, run: (tracker: Tracker) => Promise<T>): Promise<T> {
  const tracker: Tracker = {
    secrets: new Set(),
    sent: false,
    settled: false,
    ...(call ? { calling: new AbortController() } : {}),
  };
  return tracking.run(tracker, () => run(tracker));
}

/**
 * An SDK `Client` as an `McpClient`. Its answers and failures carry no credential value sent
 * with them (R2b C8), and a failed call is an `McpCallFailed` (C7).
 */
export function sdkClient(client: Client, serverName: string): McpClient {
  return {
    listTools: (params, options) =>
      tracked(false, async (tracker) => {
        try {
          const page = await client.listTools(params, options?.signal ? { signal: options.signal } : undefined);
          return scrubbed(page, tracker) as McpToolPage;
        } catch (error) {
          throw scrubError(error, tracker);
        }
      }),
    callTool: (params, options) =>
      tracked(true, async (tracker) => {
        const lost = tracker.calling!.signal;
        try {
          const result = (await client.callTool(params, undefined, {
            signal: options?.signal ? AbortSignal.any([options.signal, lost]) : lost,
          })) as Record<string, unknown>;
          // An answer the stream did not count (an `sse` server answers on its event stream).
          if (Buffer.byteLength(JSON.stringify(result)) > MCP_RESULT_MAX_BYTES)
            throw tooLargeFailure(serverName);
          const answer = scrubValues(result, [...tracker.secrets]);
          return { result: answer.value, ...(answer.redacted > 0 ? { redacted: answer.redacted } : {}) };
        } catch (error) {
          // A cancel or a shutdown: the caller decides what it means.
          if (options?.signal?.aborted) throw error;
          throw scrubError(failureOf(serverName, error, tracker), tracker);
        } finally {
          tracker.settled = true;
        }
      }),
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
  /** Ends `initialize` (a tool preview's timeout, R2b C12). */
  signal?: AbortSignal;
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
  const { instructions, serverInfo } = await tracked(false, async (tracker) => {
    try {
      await client.connect(transport, input.signal ? { signal: input.signal } : undefined);
    } catch (error) {
      // Nothing holds a connection that never opened: end whatever its transport started.
      void client.close().catch(() => undefined);
      throw scrubError(error, tracker);
    }
    const info = client.getServerVersion();
    return {
      instructions: serverInstructions(client.getInstructions(), [...tracker.secrets]),
      serverInfo: info ? (scrubbed({ ...info }, tracker) as Record<string, unknown>) : undefined,
    };
  });
  return {
    client: sdkClient(client, input.server.name),
    ...(instructions === undefined ? {} : { instructions }),
    ...(serverInfo === undefined ? {} : { serverInfo }),
    close: () => client.close(),
  };
}

/**
 * What a server's `initialize` said to do with its tools, for the note on its deferred tools
 * (R2b C10): cut to `SERVER_INSTRUCTIONS_MAX_CHARS`, without a credential value sent (C8).
 */
export function serverInstructions(text: unknown, secrets: readonly string[]): string | undefined {
  if (typeof text !== "string" || text.trim().length === 0) return undefined;
  return scrubValues(text.trim().slice(0, SERVER_INSTRUCTIONS_MAX_CHARS), secrets).value;
}

/**
 * Lists a server's tools under the names the model knows them by (R2b C6): `server__tool` where
 * that is a name every provider accepts, else `normalizeToolName`'s, listed in `renamed`. A name
 * taken by a declared tool or an earlier server's tool omits the tool; a renamed tool that
 * collides gets the hash suffix first.
 */
export async function listMcpTools(
  client: McpClient,
  input: {
    capabilityId: string;
    serverName: string;
    taken: Set<string>;
    signal?: AbortSignal;
    /**
     * The server's declaration: a tool its `tools` settings disable is left out before it takes
     * a name (R2b C9), and a key that names no listed tool is in `unknownTools`.
     */
    server?: McpServerManifest;
  },
): Promise<{
  tools: McpToolRecord[];
  omitted: string[];
  renamed: McpRenamedTool[];
  disabled: number;
  unknownTools: string[];
}> {
  const listed: McpToolPage["tools"][number][] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const answer = await client.listTools(
      cursor ? { cursor } : undefined,
      input.signal ? { signal: input.signal } : undefined,
    );
    listed.push(...answer.tools);
    cursor = answer.nextCursor;
    if (!cursor) break;
  }
  const server = input.server;
  const listedNames = new Set(listed.map((tool) => tool.name));
  // Servers change their lists, so a key naming no tool is a diagnostic, not a failure.
  const unknownTools = Object.keys(server?.tools ?? {}).filter(
    (key) => key !== MCP_TOOL_DEFAULTS && !listedNames.has(key),
  );
  let disabled = 0;
  const omitted: string[] = [];
  const candidates: { tool: McpToolPage["tools"][number]; inputSchema: JsonObject }[] = [];
  for (const tool of listed) {
    if (typeof tool.name !== "string" || tool.name.length === 0) continue;
    if (server && !mcpToolSettings(server, tool.name).enabled) {
      disabled += 1;
      continue;
    }
    const inputSchema = usableSchema(tool.inputSchema);
    if (inputSchema) candidates.push({ tool, inputSchema });
    else omitted.push(normalizeToolName(input.serverName, tool.name));
  }
  // Names that need no change first, so a renamed tool never takes the name of another of the
  // server's tools.
  const names = new Map<(typeof candidates)[number], string>();
  const renamed: McpRenamedTool[] = [];
  for (const candidate of candidates) {
    const name = normalizeToolName(input.serverName, candidate.tool.name);
    if (name !== `${input.serverName}__${candidate.tool.name}`) continue;
    if (input.taken.has(name)) omitted.push(name);
    else {
      input.taken.add(name);
      names.set(candidate, name);
    }
  }
  for (const candidate of candidates) {
    const raw = `${input.serverName}__${candidate.tool.name}`;
    let name = normalizeToolName(input.serverName, candidate.tool.name);
    if (name === raw) continue;
    if (input.taken.has(name))
      name = normalizeToolName(input.serverName, candidate.tool.name, { suffixed: true });
    if (input.taken.has(name)) {
      omitted.push(name);
      continue;
    }
    input.taken.add(name);
    names.set(candidate, name);
    renamed.push({ serverToolName: candidate.tool.name, name });
  }
  const tools: McpToolRecord[] = [];
  for (const candidate of candidates) {
    const name = names.get(candidate);
    if (name === undefined) continue;
    const { tool, inputSchema } = candidate;
    const outputSchema = tool.outputSchema ? usableSchema(tool.outputSchema) : undefined;
    const annotations = retryHints(tool.annotations);
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
      ...(annotations === undefined ? {} : { annotations }),
    });
  }
  return { tools, omitted, renamed, disabled, unknownTools };
}

/**
 * One tool call and what it came to. Rejects with `McpConnectionStale` when the connection must
 * be opened again (the caller retries once), and with any error that leaves the call's fate
 * unknown.
 */
export async function callMcpTool(
  client: McpClient,
  serverToolName: string,
  args: unknown,
  options: McpCallOptions & {
    /**
     * The tool is read-only or idempotent (`McpToolRecord.annotations`): a call whose answer was
     * lost after it was sent is `mcp.lost` to the model. Otherwise it is left uncertain (Q15).
     */
    readonly retrySafe?: boolean;
  } = {},
): Promise<McpToolOutcome> {
  let answer: McpCallAnswer;
  try {
    answer = await client.callTool(
      {
        name: serverToolName,
        arguments:
          args && typeof args === "object" && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : {},
      },
      {
        ...(options.key === undefined ? {} : { key: options.key }),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
  } catch (error) {
    if (!(error instanceof McpCallFailed)) throw error;
    // The connection's to handle: its holder opens it again and sends the call once more.
    if (error instanceof McpConnectionStale) throw error;
    // Sent, then lost: the tool may have run. Calling it again is the model's choice only for a
    // tool the server says is safe to repeat; any other waits for an operator.
    if (error.code === "mcp.lost" && !options.retrySafe) throw new Error(error.message);
    // Otherwise the outcome is known: the model sees it.
    return error.outcome();
  }
  const { result } = answer;
  const redacted = answer.redacted ? { redacted: answer.redacted } : {};
  if ("isError" in result && result.isError) {
    return {
      kind: "failed",
      code: "mcp.tool",
      message: textContent(result.content) || "MCP tool failed",
      ...redacted,
    };
  }
  if ("structuredContent" in result && result.structuredContent !== undefined)
    return { kind: "completed", output: result.structuredContent, ...redacted };
  // Text alone is the text. With an image, audio or a resource in it, every part stays, and core
  // stores the bytes as artifacts before anything records them (R2b C11, `tenant/tool-results.ts`).
  const text =
    "content" in result && onlyText(result.content) ? textContent(result.content) : undefined;
  if (text !== undefined) return { kind: "completed", output: text, ...redacted };
  return {
    kind: "completed",
    output: "content" in result ? result.content : result,
    ...redacted,
  };
}

function onlyText(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.every(
      (part) => !!part && typeof part === "object" && (part as { type?: unknown }).type === "text",
    )
  );
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
      ? (error as { code?: unknown }).code
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
 * now. A `401` answer is `CredentialRejected`, and a POST's other error statuses are
 * `McpCallFailed`. Under a tracked operation it records the credential values it sends, whether
 * a POST was sent, and a tool call's answer lost after it was.
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
      throw new McpConnectionStale(server.name, "is now reached at another address (its credential's via changed)");
    const headers = new Headers();
    for (const [key, value] of Object.entries(server.headers ?? {}))
      headers.set(key, value);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    // Credential headers, the identity header included, replace manifest headers of the same name.
    if (result.status === "authorized")
      for (const [key, value] of Object.entries(result.headers)) headers.set(key, value);
    const tracker = tracking.getStore();
    if (tracker && result.status === "authorized")
      for (const secret of credentialSecrets(result.headers, result.identity)) tracker.secrets.add(secret);
    const post = (init?.method ?? "GET").toUpperCase() === "POST";
    let response: Response;
    try {
      // No redirects, and the address checked on what is connected to (`tenant/outbound.ts`).
      response = await send(target, { ...init, headers });
    } catch (error) {
      if (tracker && post && error instanceof OutboundFailed && error.sent) tracker.sent = true;
      throw error;
    }
    if (tracker && post) tracker.sent = true;
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      throw new CredentialRejected(
        server.name,
        result.status === "authorized" ? result.vault : undefined,
        response.headers.get("www-authenticate") ?? undefined,
      );
    }
    // The server ended the connection's session: the tool never saw the request.
    if (post && response.status === 404 && headers.has("mcp-session-id")) {
      await response.body?.cancel().catch(() => undefined);
      throw new McpConnectionStale(server.name, "ended the connection's session (HTTP 404)");
    }
    // A GET's error status (405: no event stream) is the SDK's to read.
    if (post && !response.ok) throw statusFailure(server.name, response.status, await bodyText(response));
    return tracker?.calling && post && response.body ? watched(response, tracker) : response;
  };
}

/** Error statuses after which the same request may work. */
const RETRYABLE_STATUSES = new Set([408, 429, 502, 503, 504]);

/** A POST the server answered with an error status: its JSON-RPC error, or the status. */
function statusFailure(server: string, status: number, body: string): McpCallFailed {
  const rpc = rpcErrorOf(body);
  if (status !== 403 && rpc) return rpcFailure(server, `MCP error ${rpc.code}: ${rpc.message}`);
  const text = body.length > MCP_ERROR_BODY_CHARS ? `${body.slice(0, MCP_ERROR_BODY_CHARS)}…` : body;
  return new McpCallFailed({
    code: status === 403 ? "mcp.forbidden" : "mcp.status",
    message: `The MCP server '${server}' answered HTTP ${status}${text ? `: ${text}` : ""}`,
    sent: true,
    retryable: RETRYABLE_STATUSES.has(status),
  });
}

function rpcFailure(server: string, message: string): McpCallFailed {
  return new McpCallFailed({
    code: "mcp.error",
    message: `The MCP server '${server}' answered an error: ${message.slice(0, MCP_ERROR_BODY_CHARS)}`,
    sent: true,
    retryable: false,
  });
}

function unreachableFailure(server: string, detail: string): McpCallFailed {
  return new McpCallFailed({
    code: "mcp.unreachable",
    message: `The MCP server '${server}' could not be reached, and the call was not sent: ${detail.slice(0, MCP_ERROR_BODY_CHARS)}`,
    sent: false,
    retryable: true,
  });
}

function lostFailure(server: string, detail: string): McpCallFailed {
  return new McpCallFailed({
    code: "mcp.lost",
    message: `The connection to the MCP server '${server}' was lost after the call was sent, so it may have run: ${detail.slice(0, MCP_ERROR_BODY_CHARS)}`,
    sent: true,
    retryable: true,
  });
}

function tooLargeFailure(server: string): McpCallFailed {
  return new McpCallFailed({
    code: "mcp.too-large",
    message: `The MCP server '${server}' answered more than ${MCP_RESULT_MAX_BYTES} bytes, the most a tool result may hold, so the answer was not kept`,
    sent: true,
    retryable: false,
  });
}

/** What a tool call's failure means (R2b C7). */
function failureOf(server: string, error: unknown, tracker: Tracker): McpCallFailed {
  if (error instanceof McpCallFailed) return error;
  if (tracker.tooLarge) return tooLargeFailure(server);
  const detail = error instanceof Error ? error.message : String(error);
  if (tracker.lost !== undefined) return lostFailure(server, tracker.lost);
  if (error instanceof OutboundRefused) return unreachableFailure(server, detail);
  if (error instanceof OutboundFailed)
    return error.sent ? lostFailure(server, detail) : unreachableFailure(server, detail);
  if (error instanceof McpError) {
    // Sent, and no answer came in time.
    if (error.code === ErrorCode.RequestTimeout) return lostFailure(server, detail);
    if (error.code === ErrorCode.ConnectionClosed)
      return tracker.sent ? lostFailure(server, detail) : unreachableFailure(server, detail);
    return rpcFailure(server, detail);
  }
  // An answer that could not be read leaves the call's fate unknown, as a lost one does.
  return tracker.sent ? lostFailure(server, detail) : unreachableFailure(server, detail);
}

/** `value` with the operation's credential values replaced (R2b C8). */
function scrubbed(value: unknown, tracker: Tracker): unknown {
  return tracker.secrets.size === 0 ? value : scrub(value, [...tracker.secrets], { valuesOnly: true });
}

/** `error` with no credential value in its message (R2b C8). */
function scrubError(error: unknown, tracker: Tracker): unknown {
  if (tracker.secrets.size === 0) return error;
  if (error instanceof McpCallFailed) {
    const message = scrubValues(error.failure.message, [...tracker.secrets]);
    if (message.redacted === 0) return error;
    return new McpCallFailed({
      ...error.failure,
      message: message.value,
      redacted: (error.failure.redacted ?? 0) + message.redacted,
    });
  }
  if (error instanceof Error) error.message = scrubbed(error.message, tracker) as string;
  return error;
}

/**
 * A tool call's answer whose body reports its loss (R2b C7): a stream that breaks after the
 * request was sent ends the call as lost, now, instead of at the SDK's request timeout. One that
 * passes `MCP_RESULT_MAX_BYTES` ends it as `mcp.too-large` (C11), before more of it is read.
 */
function watched(response: Response, tracker: Tracker): Response {
  const source = response.body!.getReader();
  let received = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await source.read();
      } catch (error) {
        if (!tracker.settled && tracker.lost === undefined && !tracker.tooLarge) {
          tracker.lost = error instanceof Error ? error.message : String(error);
          tracker.calling?.abort(new Error(tracker.lost));
        }
        controller.error(error);
        return;
      }
      if (next.done) return controller.close();
      received += next.value.byteLength;
      if (received > MCP_RESULT_MAX_BYTES) {
        tracker.tooLarge = true;
        const error = new Error(`The answer passed ${MCP_RESULT_MAX_BYTES} bytes`);
        tracker.calling?.abort(error);
        controller.error(error);
        void source.cancel(error).catch(() => undefined);
        return;
      }
      controller.enqueue(next.value);
    },
    cancel: (reason) => source.cancel(reason),
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** The start of an error answer's body. */
async function bodyText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < 4 * MCP_ERROR_BODY_CHARS) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      size += next.value.byteLength;
    }
  } catch {
    // What arrived is enough to say why.
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

/** A JSON-RPC error answer's code and message. */
function rpcErrorOf(body: string): { code: number; message: string } | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown; message?: unknown } };
    const error = parsed?.error;
    if (error && typeof error.code === "number" && typeof error.message === "string")
      return { code: error.code, message: error.message };
  } catch {
    // Not JSON: an HTTP error status.
  }
  return undefined;
}

/** The hints that calling a tool again is safe, when the server gives any. */
function retryHints(
  annotations: Readonly<Record<string, unknown>> | undefined,
): McpToolRecord["annotations"] | undefined {
  const readOnly = annotations?.readOnlyHint === true;
  const idempotent = annotations?.idempotentHint === true;
  if (!readOnly && !idempotent) return undefined;
  return { ...(readOnly ? { readOnlyHint: true } : {}), ...(idempotent ? { idempotentHint: true } : {}) };
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
