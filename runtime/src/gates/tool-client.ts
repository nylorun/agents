/**
 * The loop's client of the Tool Gate in the gates service (F4.1, `tool-contract.ts`): remote
 * MCP servers opened and called through the gate, which holds their connections and
 * credentials, and Action deliveries POSTed by the gate. Over `node:http`, like the model gate's
 * client (`http-client.ts`): a call answers only when it has finished.
 *
 * Failures keep the meaning they had in the loop's own process:
 * - An MCP request that fails, at the server or on the hop, throws, so the pool reports a
 *   diagnostic and `resolveEffect` marks a call `uncertain`, as before.
 * - A delivery never throws. A hop that failed before the request was sent is `not_sent`
 *   (the deliverer sends it again, even a tool); one that failed after is `lost`.
 *
 * Credentials (F5): a session's MCP requests and keyed cancels carry its run token, read per
 * request from the advance's grant, and leave the session out of the body: the gate takes it
 * from the token. Deliveries, pings, and MCP requests made outside a run (closing a pooled
 * connection after the advance ended) carry core's credential, `NYLORUN_GATES_TOKEN`, and name
 * the session in the body.
 */
import { randomUUID } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LiveConnection, McpClient, McpToolPage } from "../mcp/connect.js";
import type { McpServerRef } from "../mcp/pool.js";
import type { OutboundResult } from "../tenant/outbound.js";
import { TENANT_HEADER } from "./contract.js";
import { GATE_CLIENT_TIMEOUT_MS } from "./http-client.js";
import {
  DELIVERIES_PATH,
  MCP_CLOSE_PATH,
  MCP_CONNECT_PATH,
  MCP_LIST_PATH,
  TOOL_CALLS_PATH,
  type DeliveryAnswer,
  type McpAnswer,
  type McpGateError,
  type ToolCallBody,
} from "./tool-contract.js";
import type { DeliveryRequest, ToolGate } from "./tool-gate.js";
import type { RunTokens } from "../tenant/run-grants.js";

/** How long a close or a cancel may take; neither changes an outcome. */
const SHORT_TIMEOUT_MS = 2_000;

/** Extra silence allowed on a delivery beyond the endpoint's own timeout. */
const DELIVERY_SLACK_MS = 30_000;

export interface HttpToolGateOptions {
  /** The gates service, e.g. `http://gateway:4100` (`NYLORUN_GATES_URL`). */
  readonly url: string;
  /** `NYLORUN_GATES_TOKEN`: core's credential, for deliveries and MCP requests outside a run. */
  readonly token: string;
  /** The run token of each session an advance of this process owns. Without it, core's only. */
  readonly runTokens?: RunTokens;
  /** Sent as `Nylorun-Tenant`; the gate checks it against its database's Tenant. */
  readonly tenantId?: string;
  /** How long an MCP request may stay silent. Default `GATE_CLIENT_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/** A request body and, for a session's run, its run token in place of core's credential. */
interface Scoped<B> {
  readonly body: B;
  readonly bearer?: string;
}

/** What one request to the gate came to. */
type Exchange =
  | { kind: "answer"; status: number; text: string }
  /** Nothing reached the gate: the request was not fully sent. */
  | { kind: "unreachable"; message: string }
  /** The request was sent, and the answer never came. */
  | { kind: "lost"; message: string }
  | { kind: "aborted"; sent: boolean; reason: unknown };

export function httpToolGate(options: HttpToolGateOptions): ToolGate {
  const where = new URL(options.url).origin;
  const timeoutMs = options.timeoutMs ?? GATE_CLIENT_TIMEOUT_MS;

  function exchange(
    path: string,
    body: unknown,
    request: { signal?: AbortSignal; idempotencyKey?: string; timeoutMs: number; bearer?: string },
  ): Promise<Exchange> {
    const url = new URL(path, options.url);
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), "utf8");
    const signal = request.signal;
    return new Promise<Exchange>((resolve) => {
      if (signal?.aborted) return resolve({ kind: "aborted", sent: false, reason: signal.reason });
      let settled = false;
      let sent = false;
      let responded = false;
      let timedOut = false;
      const settle = (result: Exchange) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = () => {
        settle({ kind: "aborted", sent, reason: signal!.reason });
        outgoing.destroy();
      };
      const failed = (error?: Error) =>
        settle(
          sent
            ? {
                kind: "lost",
                message: timedOut
                  ? `Tool gate at ${where} sent nothing for ${Math.round(request.timeoutMs / 1000)} s`
                  : `Tool gate connection lost${error ? ` (${error.message})` : ""}`,
              }
            : { kind: "unreachable", message: `Tool gate unreachable at ${where}${error ? ` (${error.message})` : ""}` },
        );
      const outgoing = send(
        url,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${request.bearer ?? options.token}`,
            "content-type": "application/json",
            "content-length": payload.byteLength,
            ...(options.tenantId ? { [TENANT_HEADER]: options.tenantId } : {}),
            ...(request.idempotencyKey ? { "idempotency-key": request.idempotencyKey } : {}),
          },
          timeout: request.timeoutMs,
        },
        (response) => {
          responded = true;
          readBody(response).then(
            (text) => settle({ kind: "answer", status: response.statusCode ?? 0, text }),
            (error: Error) => failed(error),
          );
        },
      );
      outgoing.on("socket", (socket) => socket.setKeepAlive(true, 30_000));
      outgoing.on("finish", () => {
        sent = true;
      });
      outgoing.on("timeout", () => {
        timedOut = true;
        outgoing.destroy();
      });
      outgoing.on("error", (error) => {
        if (!signal?.aborted) failed(error);
      });
      outgoing.on("close", () => {
        if (!signal?.aborted && !responded) failed();
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      outgoing.end(payload);
    });
  }

  /**
   * The body and credential of a request for `server`'s session: its run token and no session
   * in the body while an advance holds a grant, core's credential and the session otherwise.
   */
  function scoped<B>(server: McpServerRef, body: (server: McpServerRef) => B): Scoped<B> {
    const token = options.runTokens?.token(server.sessionId);
    if (!token) return { body: body({ ...server }) };
    const { sessionId: _, ...unnamed } = server;
    return { body: body(unnamed as McpServerRef), bearer: token };
  }

  /** The result of an MCP request, or a throw the pool and `resolveEffect` read as before. */
  async function mcp<T>(
    path: string,
    scope: Scoped<unknown>,
    request: { signal?: AbortSignal; idempotencyKey?: string },
  ): Promise<T> {
    const result = await exchange(path, scope.body, {
      ...request,
      timeoutMs,
      ...(scope.bearer ? { bearer: scope.bearer } : {}),
    });
    if (result.kind === "aborted") throw result.reason ?? new Error("aborted");
    if (result.kind !== "answer") throw new Error(result.message);
    const parsed = parse(result.text) as McpAnswer<T> | { error?: { message?: string } } | undefined;
    if (result.status !== 200 || !parsed || !("ok" in parsed))
      throw new Error(gateRefusal(result.status, parsed));
    if (parsed.ok) return parsed.result;
    throw mcpError(parsed.error);
  }

  async function fireAndForget(path: string, scope: Scoped<unknown>): Promise<void> {
    await exchange(path, scope.body, {
      timeoutMs: SHORT_TIMEOUT_MS,
      ...(scope.bearer ? { bearer: scope.bearer } : {}),
    });
  }

  return {
    recovers: true,

    async openMcp(server: McpServerRef): Promise<LiveConnection> {
      // The credential is read per request: the connection outlives the advance that opened it.
      await mcp<null>(MCP_CONNECT_PATH, scoped(server, (named) => ({ server: named })), {});
      const client: McpClient = {
        listTools: (params, request) =>
          mcp<McpToolPage>(
            MCP_LIST_PATH,
            scoped(server, (named) => ({
              server: named,
              ...(params?.cursor ? { cursor: params.cursor } : {}),
            })),
            request?.signal ? { signal: request.signal } : {},
          ),
        callTool: (params, request) =>
          mcp<Record<string, unknown>>(
            TOOL_CALLS_PATH,
            scoped(
              server,
              (named): ToolCallBody => ({
                server: named,
                effectId: request?.key ?? randomUUID(),
                name: params.name,
                arguments: params.arguments,
              }),
            ),
            {
              ...(request?.signal ? { signal: request.signal } : {}),
              ...(request?.key ? { idempotencyKey: request.key } : {}),
            },
          ),
      };
      return {
        client,
        close: () => fireAndForget(MCP_CLOSE_PATH, scoped(server, (named) => ({ server: named }))),
      };
    },

    async cancel(request) {
      const token = options.runTokens?.token(request.sessionId);
      await fireAndForget(`${TOOL_CALLS_PATH}/${encodeURIComponent(request.effectId)}/cancel`, {
        body: undefined,
        ...(token ? { bearer: token } : {}),
      });
    },

    async post(delivery: DeliveryRequest, signal: AbortSignal): Promise<OutboundResult> {
      const result = await exchange(
        DELIVERIES_PATH,
        {
          url: delivery.url,
          body: delivery.body,
          headers: { ...delivery.headers },
          timeoutMs: delivery.timeoutMs,
        },
        { signal, timeoutMs: delivery.timeoutMs + DELIVERY_SLACK_MS },
      );
      if (result.kind === "aborted")
        return {
          kind: result.sent ? "lost" : "not_sent",
          code: "ABORTED",
          message: "The delivery was aborted",
        };
      if (result.kind === "unreachable")
        return { kind: "not_sent", code: "gateway.unreachable", message: result.message };
      if (result.kind === "lost") return { kind: "lost", code: "gateway.lost", message: result.message };
      const parsed = parse(result.text) as Partial<DeliveryAnswer> | undefined;
      if (result.status !== 200 || !parsed?.result)
        // The gate refused the request before sending anything.
        return { kind: "not_sent", code: "gateway.refused", message: gateRefusal(result.status, parsed) };
      const wire = parsed.result;
      if (wire.kind !== "response") return wire;
      return {
        kind: "response",
        status: wire.status,
        headers: wire.headers,
        body: Buffer.from(wire.body, "base64"),
      };
    },
  };
}

/** An MCP failure the gate reported, as the loop's own MCP code would have thrown it. */
function mcpError(error: McpGateError): Error {
  const thrown = new Error(
    error.uncertain ? `${error.message} (the call may have run; it is not sent again)` : error.message,
  ) as Error & { code?: number; credentialIds?: readonly string[] };
  if (error.code !== undefined) thrown.code = error.code;
  if (error.credentialIds !== undefined) thrown.credentialIds = error.credentialIds;
  return thrown;
}

function gateRefusal(status: number, parsed: unknown): string {
  const message = (parsed as { error?: { message?: unknown } } | undefined)?.error?.message;
  if (status === 401)
    return `The tool gate refused the credential${typeof message === "string" ? `: ${message}` : ""}`;
  return `Tool gate answered ${status}${typeof message === "string" ? `: ${message}` : ""}`;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function readBody(response: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("end", () => {
      if (response.complete) resolve(Buffer.concat(chunks).toString("utf8"));
      else reject(new Error("response ended early"));
    });
    response.on("error", reject);
    response.on("aborted", () => reject(new Error("response aborted")));
  });
}
