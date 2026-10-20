import { AsyncLocalStorage } from "node:async_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerManifest } from "@nylorun/core/define";
import type { JsonObject } from "@nylorun/core/define";
import { MCP_TOOL_DEFAULTS, mcpToolSettings } from "@nylorun/core/define";
import { scrub, scrubValues } from "../redact.js";
import {
  guardedFetch,
  OutboundFailed,
  OutboundRefused,
  type OutboundPolicy,
} from "../tenant/outbound.js";
import { credentialSecrets } from "../vault/headers.js";
import type { AuthorizeResult } from "../vault/service.js";
import { gatewayAuthFailure } from "./gateway-outcomes.js";
import type { McpDiagnostic, McpToolRecord } from "./snapshot.js";
import { hostTuning } from "../tuning.js";


/** Options of one MCP request. */
export interface McpRequestOptions {
  readonly signal?: AbortSignal;
}

/** Options of one tool call. */
export interface McpCallOptions extends McpRequestOptions {
  /**
   * The call's effect id. A gate keeps a keyed call's outcome, so a re-send after a takeover
   * joins it (F4.1), and the server gets it in `_meta` (R5.5).
   */
  readonly key?: string;
  /**
   * The call's span context (R7.4), sent as the `traceparent` header on the call's requests where
   * this process holds the connection. A client of the gates service leaves it out: the gate reads
   * it from the call's journal row.
   */
  readonly traceparent?: string;
  /**
   * How much of a failed call's answer its error quotes: the Tenant's Runtime limit
   * `errorExcerptChars`, read for the call. Default the connection's (`openMcpServer`).
   */
  readonly errorExcerptChars?: number;
  /**
   * The largest answer kept, in bytes: the Tenant's Runtime limit `toolAnswerBytes` (R2b C11).
   * A larger one is `mcp.too-large`. Required where this process holds the connection; a client
   * of the gates service leaves it out, since the gate reads the limit itself.
   */
  readonly maxResultBytes?: number;
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
  /** What the server, or a gateway in front of it, says besides the tools (MCP `_meta`). */
  readonly _meta?: Readonly<Record<string, unknown>>;
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
  /** The server's instructions from `initialize`, scrubbed (`serverInstructions`); absent when none. */
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
  /** With `credential_rejected`: the server. */
  readonly server?: string;
  /** With `credential_rejected` of the workload token: the gateway that refused it (#496). */
  readonly gateway?: string;
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
 * - `credential_rejected`: the server answered `401` (C1), or the gateway of a credential's `via`
 *   reported that the server behind it did (#495).
 * - `mcp.forbidden`: the server answered `403`.
 * - `mcp.error`: the server answered a JSON-RPC error; the message has its code.
 * - `mcp.status`: the server answered another HTTP error status, without a JSON-RPC error.
 * - `mcp.lost`: sent, and the answer was lost, so the tool may have run. The model sees it, and
 *   decides whether to call again (R5; it replaced R2b's read-only and idempotent exception).
 * - `mcp.too-large`: the answer passed the Tenant's Runtime limit `toolAnswerBytes` (R2b C11),
 *   as an HTTP tool's answer is `http.too-large`. The tool ran; its answer was not kept.
 */
export type McpFailureCode =
  | "mcp.unreachable"
  | "credential_rejected"
  | "mcp.forbidden"
  | "mcp.error"
  | "mcp.status"
  | "mcp.lost"
  | "mcp.too-large";

export interface McpCallFailure {
  readonly code: McpFailureCode;
  readonly message: string;
  /** The request reached the server, so it may have acted on it. */
  readonly sent: boolean;
  readonly retryable: boolean;
  /** With `credential_rejected`: the server. */
  readonly server?: string;
  /** With `credential_rejected` of the workload token: the gateway that refused it (#496). */
  readonly gateway?: string;
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
      ? new CredentialRejected(failure.server, !failure.message.includes("holds none"), undefined, failure.gateway)
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
      ...(failure.gateway === undefined ? {} : { gateway: failure.gateway }),
      ...(failure.redacted ? { redacted: failure.redacted } : {}),
    };
  }
}

/**
 * A request the server answered `401` (R2b C1): it rejected the vault's credential, or wanted one
 * and got none. Through a credential's `via`, also a gateway's answer reporting that the server
 * behind it did (`gateway-outcomes.ts`, #495). Never retried, since nothing the gate holds changes between tries (Q4). A tool
 * call that meets it fails with `credential_rejected` for the model to see; at discovery it is the
 * server's `failed` diagnostic.
 */
export class CredentialRejected extends McpCallFailed {
  constructor(
    readonly server: string,
    /** Whether a credential of the session's Agent was sent. */
    readonly sent: boolean,
    /**
     * The answer's `WWW-Authenticate`, which may name the server's protected-resource metadata
     * (RFC 9728 `resource_metadata`): a tool preview reads it (R2b C12). Never shown to the model.
     */
    readonly challenge?: string,
    /** The gateway at `via` that refused the Runtime's workload token (#496): an expired or unrotated token. */
    readonly gateway?: string,
  ) {
    super({
      code: "credential_rejected",
      message: gateway
        ? `The gateway ${gateway} answered HTTP 401 for the MCP server '${server}': it rejected the Runtime's workload token`
        : sent
          ? `The MCP server '${server}' answered HTTP 401: it rejected the credential from the session's Agent`
          : `The MCP server '${server}' answered HTTP 401: it needs a credential, and the session's Agent holds none for it`,
      sent: true,
      retryable: false,
      server,
      ...(gateway === undefined ? {} : { gateway }),
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

/**
 * A tool call that never reached its server: its connection could not be opened. Where the
 * opening reached the server, `chars` is how much of what it said the error quotes (the Tenant's
 * `errorExcerptChars`); without it, the message is this process's own and stays whole.
 */
export function unreachable(server: string, error: unknown, chars?: number): McpCallFailed {
  if (error instanceof McpCallFailed) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return unreachableFailure(server, detail, chars ?? detail.length);
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
  /** A tool call's largest answer (`McpCallOptions.maxResultBytes`). */
  readonly maxResultBytes?: number;
  /** A tool call's answer passed `maxResultBytes` (R2b C11). */
  tooLarge?: boolean;
  /** A tool call's: aborted when its answer is lost or too large, so the call ends now. */
  readonly calling?: AbortController;
  /** A tool call's span context (R7.4), sent as `traceparent` on its requests. */
  readonly traceparent?: string;
  /** How much of a failed answer an error quotes (`errorExcerptChars`). */
  readonly errorChars: number;
  settled: boolean;
}

/** The operation a request of the transport's fetch belongs to. */
const tracking = new AsyncLocalStorage<Tracker>();

function tracked<T>(
  call: boolean,
  run: (tracker: Tracker) => Promise<T>,
  options: {
    readonly errorChars: number;
    readonly traceparent?: string | undefined;
    readonly maxResultBytes?: number | undefined;
  },
): Promise<T> {
  const { traceparent, maxResultBytes, errorChars } = options;
  const tracker: Tracker = {
    secrets: new Set(),
    sent: false,
    settled: false,
    errorChars,
    ...(call ? { calling: new AbortController() } : {}),
    ...(traceparent ? { traceparent } : {}),
    ...(maxResultBytes === undefined ? {} : { maxResultBytes }),
  };
  return tracking.run(tracker, () => run(tracker));
}

/**
 * Where a `tools/call` carries its key (R5.5): MCP has no standard key field, and `_meta` is the
 * spec's place for extra request data. The key is the call's effect id, the same on every send,
 * so a server that reads it can run the call once.
 */
export const IDEMPOTENCY_META_KEY = "nylorun/idempotency-key";

/** How a connection reaches its server through a gateway: the credential's routing. */
export interface GatewayRouting {
  /** Where the server's requests go (the credential's `via`). */
  readonly via: string;
  /** What the gateway puts before each tool name it lists (the credential's `toolPrefix`, #494). */
  readonly toolPrefix?: string;
}

/**
 * Where a `tools/list` page names the tools a gateway listed without the credential's
 * `toolPrefix` (#494): kept under their listed names, for discovery's diagnostic.
 */
export const UNPREFIXED_TOOLS_META_KEY = "nylorun/unprefixed-tools";

/**
 * An SDK `Client` as an `McpClient`. Its answers and failures carry no credential value sent
 * with them (R2b C8), and a failed call is an `McpCallFailed` (C7). A keyed call sends its key in
 * `_meta` (R5.5). Through a `gateway`, an answer that reports the server refused the credential
 * is `CredentialRejected`, as a `401` is (#495), and a gateway's `toolPrefix` is taken off the
 * tools it lists and put back on the calls (#494): everything after this client names the
 * server's own tools.
 */
export function sdkClient(
  client: Client,
  serverName: string,
  errorChars: number,
  gateway?: GatewayRouting,
): McpClient {
  const prefix = gateway?.toolPrefix;
  // The gateway may name the server by the prefix's stem (LiteLLM's `github-` for `github`).
  const keys = prefix === undefined ? [serverName] : [serverName, prefix.replace(/[^A-Za-z0-9]+$/, "")];
  const rejected = (answer: unknown) => gateway !== undefined && gatewayAuthFailure(answer, keys);
  // The name the gateway listed for each tool, by the server's own name, and the names it listed
  // without the prefix: a call sends the tool's name as the gateway listed it.
  const listedAs = new Map<string, string>();
  const unprefixed = new Set<string>();
  const listedName = (name: string) =>
    prefix === undefined || unprefixed.has(name) ? name : (listedAs.get(name) ?? `${prefix}${name}`);
  const stripped = (page: McpToolPage): McpToolPage => {
    if (prefix === undefined) return page;
    const missing: string[] = [];
    const tools = page.tools.map((tool) => {
      if (typeof tool.name === "string" && tool.name.startsWith(prefix) && tool.name.length > prefix.length) {
        const name = tool.name.slice(prefix.length);
        listedAs.set(name, tool.name);
        return { ...tool, name };
      }
      if (typeof tool.name === "string") {
        unprefixed.add(tool.name);
        missing.push(tool.name);
      }
      return tool;
    });
    return {
      ...page,
      tools,
      ...(missing.length === 0 ? {} : { _meta: { ...page._meta, [UNPREFIXED_TOOLS_META_KEY]: missing } }),
    };
  };
  return {
    listTools: (params, options) =>
      tracked(false, async (tracker) => {
        try {
          const page = await client.listTools(params, options?.signal ? { signal: options.signal } : undefined);
          if (rejected(page)) throw new CredentialRejected(serverName, true);
          return stripped(scrubbed(page, tracker) as McpToolPage);
        } catch (error) {
          throw scrubError(error, tracker);
        }
      }, { errorChars }),
    callTool: (params, options) => {
      const maxResultBytes = options?.maxResultBytes;
      if (maxResultBytes === undefined)
        return Promise.reject(new Error("A tool call on a connection this process holds needs maxResultBytes"));
      return tracked(true, async (tracker) => {
        const lost = tracker.calling!.signal;
        try {
          const named = { ...params, name: listedName(params.name) };
          const keyed =
            options?.key === undefined
              ? named
              : { ...named, _meta: { [IDEMPOTENCY_META_KEY]: options.key } };
          const result = (await client.callTool(keyed, undefined, {
            signal: options?.signal ? AbortSignal.any([options.signal, lost]) : lost,
          })) as Record<string, unknown>;
          // An answer the stream did not count (an `sse` server answers on its event stream).
          if (Buffer.byteLength(JSON.stringify(result)) > maxResultBytes)
            throw tooLargeFailure(serverName, maxResultBytes);
          if (result.isError === true && rejected(result)) throw new CredentialRejected(serverName, true);
          const answer = scrubValues(result, [...tracker.secrets]);
          return { result: answer.value, ...(answer.redacted > 0 ? { redacted: answer.redacted } : {}) };
        } catch (error) {
          // A cancel or a shutdown: the caller decides what it means.
          if (options?.signal?.aborted) throw error;
          throw scrubError(failureOf(serverName, error, tracker), tracker);
        } finally {
          tracker.settled = true;
        }
      }, { traceparent: options?.traceparent, maxResultBytes, errorChars: options?.errorExcerptChars ?? errorChars });
    },
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
  /**
   * How much of a failed answer an error quotes: the Tenant's Runtime limit `errorExcerptChars`
   * when the connection opens; a call may pass the one in force then.
   */
  errorExcerptChars: number;
}): Promise<LiveConnection> {
  const errorChars = input.errorExcerptChars;
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
  const fetchImpl = authorizedFetch(input.server, url, authorize, input.policy ?? {}, errorChars);
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
  }, { errorChars });
  const gateway: GatewayRouting | undefined =
    initial.status === "authorized" && initial.via !== undefined
      ? { via: initial.via, ...(initial.toolPrefix === undefined ? {} : { toolPrefix: initial.toolPrefix }) }
      : undefined;
  return {
    client: sdkClient(client, input.server.name, errorChars, gateway),
    ...(instructions === undefined ? {} : { instructions }),
    ...(serverInfo === undefined ? {} : { serverInfo }),
    close: () => client.close(),
  };
}

/**
 * What a server's `initialize` said to do with its tools, as it said it, without a credential
 * value sent (C8). The harness decides how much of it the model reads.
 */
export function serverInstructions(text: unknown, secrets: readonly string[]): string | undefined {
  if (typeof text !== "string" || text.trim().length === 0) return undefined;
  return scrubValues(text.trim(), secrets).value;
}

/**
 * Lists a server's tools as it names them (protocol 15): every tool whose input schema is a JSON
 * object, the ones its `tools` settings disable included, since a turn's manifest decides
 * `enabled` (`mcpFactsOf`). The harness names them for the model. A tool with no input schema
 * object is in `omitted`; `disabled` counts the tools the declaration's settings disable, and
 * `unknownTools` the settings' keys that name no listed tool.
 */
export async function listMcpTools(
  client: McpClient,
  input: {
    serverName: string;
    signal?: AbortSignal;
    /** The server's declaration, whose `tools` settings the diagnostics count against. */
    server?: McpServerManifest;
  },
): Promise<{
  tools: McpToolRecord[];
  omitted: string[];
  disabled: number;
  unknownTools: string[];
  /** The tools a gateway listed without the credential's `toolPrefix`, as it named them (#494). */
  unprefixed: string[];
}> {
  const listed: McpToolPage["tools"][number][] = [];
  const unprefixed: string[] = [];
  let cursor: string | undefined;
  const pages = hostTuning().harness.mcpListPages;
  for (let page = 0; page < pages; page += 1) {
    const answer = await client.listTools(
      cursor ? { cursor } : undefined,
      input.signal ? { signal: input.signal } : undefined,
    );
    listed.push(...answer.tools);
    const missing = answer._meta?.[UNPREFIXED_TOOLS_META_KEY];
    if (Array.isArray(missing)) unprefixed.push(...missing.filter((name): name is string => typeof name === "string"));
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
  const tools: McpToolRecord[] = [];
  const seen = new Set<string>();
  for (const tool of listed) {
    if (typeof tool.name !== "string" || tool.name.length === 0 || seen.has(tool.name)) continue;
    seen.add(tool.name);
    if (server && !mcpToolSettings(server, tool.name).enabled) disabled += 1;
    const inputSchema = jsonObjectOf(tool.inputSchema);
    if (!inputSchema) {
      omitted.push(tool.name);
      continue;
    }
    const outputSchema = jsonObjectOf(tool.outputSchema);
    const annotations = jsonObjectOf(tool.annotations);
    tools.push({
      name: tool.name,
      ...(typeof tool.description === "string" && tool.description.length > 0
        ? { description: tool.description }
        : {}),
      inputSchema,
      ...(outputSchema === undefined ? {} : { outputSchema }),
      ...(annotations === undefined || Object.keys(annotations).length === 0 ? {} : { annotations }),
    });
  }
  return { tools, omitted, disabled, unknownTools, unprefixed };
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
  options: McpCallOptions = {},
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
        ...(options.traceparent === undefined ? {} : { traceparent: options.traceparent }),
        ...(options.maxResultBytes === undefined ? {} : { maxResultBytes: options.maxResultBytes }),
      },
    );
  } catch (error) {
    if (!(error instanceof McpCallFailed)) throw error;
    // The connection's to handle: its holder opens it again and sends the call once more.
    if (error instanceof McpConnectionStale) throw error;
    // The model sees it, `mcp.lost` included: sent, then lost, so the tool may have run (R5).
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
  // Text alone is the text. With an image, audio or a resource in it, every part stays, and the
  // harness stores the bytes as artifacts before it reports the outcome (R2b C11).
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
    serverName,
    outcome: "failed",
    message: unauthorized
      ? "MCP server returned 401"
      : error instanceof Error
        ? error.message.slice(0, hostTuning().harness.mcpDiagnosticChars)
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
  errorChars: number,
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
    // The tool call's span (R7.4): per request, so a pooled connection carries each call's own.
    if (tracker?.traceparent) headers.set("traceparent", tracker.traceparent);
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
        result.status === "authorized",
        response.headers.get("www-authenticate") ?? undefined,
        result.status === "authorized" && result.workload ? endpoint.origin : undefined,
      );
    }
    // The server ended the connection's session: the tool never saw the request.
    if (post && response.status === 404 && headers.has("mcp-session-id")) {
      await response.body?.cancel().catch(() => undefined);
      throw new McpConnectionStale(server.name, "ended the connection's session (HTTP 404)");
    }
    // A GET's error status (405: no event stream) is the SDK's to read.
    if (post && !response.ok) {
      const chars = tracker?.errorChars ?? errorChars;
      throw statusFailure(server.name, response.status, await bodyText(response, chars), chars);
    }
    return tracker?.calling && post && response.body ? watched(response, tracker) : response;
  };
}

/** Error statuses after which the same request may work. */
const RETRYABLE_STATUSES = new Set([408, 429, 502, 503, 504]);

/** A POST the server answered with an error status: its JSON-RPC error, or the status. */
function statusFailure(server: string, status: number, body: string, chars: number): McpCallFailed {
  const rpc = rpcErrorOf(body);
  if (status !== 403 && rpc) return rpcFailure(server, `MCP error ${rpc.code}: ${rpc.message}`, chars);
  const text = body.length > chars ? `${body.slice(0, chars)}…` : body;
  return new McpCallFailed({
    code: status === 403 ? "mcp.forbidden" : "mcp.status",
    message: `The MCP server '${server}' answered HTTP ${status}${text ? `: ${text}` : ""}`,
    sent: true,
    retryable: RETRYABLE_STATUSES.has(status),
  });
}

function rpcFailure(server: string, message: string, chars: number): McpCallFailed {
  return new McpCallFailed({
    code: "mcp.error",
    message: `The MCP server '${server}' answered an error: ${message.slice(0, chars)}`,
    sent: true,
    retryable: false,
  });
}

function unreachableFailure(server: string, detail: string, chars: number): McpCallFailed {
  return new McpCallFailed({
    code: "mcp.unreachable",
    message: `The MCP server '${server}' could not be reached, and the call was not sent: ${detail.slice(0, chars)}`,
    sent: false,
    retryable: true,
  });
}

function lostFailure(server: string, detail: string, chars: number): McpCallFailed {
  return new McpCallFailed({
    code: "mcp.lost",
    message: `The connection to the MCP server '${server}' was lost after the call was sent, so it may have run: ${detail.slice(0, chars)}`,
    sent: true,
    retryable: true,
  });
}

function tooLargeFailure(server: string, maxResultBytes: number): McpCallFailed {
  return new McpCallFailed({
    code: "mcp.too-large",
    message: `The MCP server '${server}' answered more than ${maxResultBytes} bytes, the most a tool result may hold (the Runtime limit toolAnswerBytes), so the answer was not kept`,
    sent: true,
    retryable: false,
  });
}

/** What a tool call's failure means (R2b C7). */
function failureOf(server: string, error: unknown, tracker: Tracker): McpCallFailed {
  if (error instanceof McpCallFailed) return error;
  if (tracker.tooLarge) return tooLargeFailure(server, tracker.maxResultBytes ?? 0);
  const detail = error instanceof Error ? error.message : String(error);
  const chars = tracker.errorChars;
  if (tracker.lost !== undefined) return lostFailure(server, tracker.lost, chars);
  if (error instanceof OutboundRefused) return unreachableFailure(server, detail, chars);
  if (error instanceof OutboundFailed)
    return error.sent ? lostFailure(server, detail, chars) : unreachableFailure(server, detail, chars);
  if (error instanceof McpError) {
    // Sent, and no answer came in time.
    if (error.code === ErrorCode.RequestTimeout) return lostFailure(server, detail, chars);
    if (error.code === ErrorCode.ConnectionClosed)
      return tracker.sent ? lostFailure(server, detail, chars) : unreachableFailure(server, detail, chars);
    return rpcFailure(server, detail, chars);
  }
  // An answer that could not be read leaves the call's fate unknown, as a lost one does.
  return tracker.sent ? lostFailure(server, detail, chars) : unreachableFailure(server, detail, chars);
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
 * passes the call's `maxResultBytes` ends it as `mcp.too-large` (C11), before more of it is read.
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
      if (tracker.maxResultBytes !== undefined && received > tracker.maxResultBytes) {
        tracker.tooLarge = true;
        const error = new Error(`The answer passed ${tracker.maxResultBytes} bytes`);
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
async function bodyText(response: Response, chars: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    // A character takes at most 4 bytes of UTF-8: enough bytes for `chars` of them.
    while (size < 4 * chars) {
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

function sameOrigin(requestUrl: string, serverUrl: string): boolean {
  try {
    return new URL(requestUrl).origin === new URL(serverUrl).origin;
  } catch {
    return false;
  }
}

/** `value` as a JSON object (a copy), or undefined when it is not one. */
function jsonObjectOf(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return JSON.parse(JSON.stringify(value)) as JsonObject;
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
