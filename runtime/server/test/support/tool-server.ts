/**
 * The developer's service behind HTTP tools, for runtime tests: the Runtime runs no code of
 * the developer's during a session (track R2), so a test's tool code runs here and agents
 * reach it with `http()` tools. Each tool is one path (`/<name>`), answered by the test's
 * handler with JSON; every call is kept, with the identity headers the Runtime sent.
 */
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { http, type ToolDefinition } from "@nylorun/agents";

/** One request the Runtime made to a tool. */
export interface ToolCall {
  readonly name: string;
  readonly input: any;
  readonly headers: IncomingHttpHeaders;
}

/** A handler's answer other than `200` with its JSON result. */
export interface ToolReply {
  readonly status: number;
  readonly body?: unknown;
}
const REPLY = Symbol("reply");
/** Answers with `status` and `body` (JSON) instead of `200`. */
export const reply = (status: number, body?: unknown): ToolReply =>
  ({ [REPLY]: true, status, ...(body === undefined ? {} : { body }) }) as ToolReply;
/** Keeps the request open until the server closes. */
export const HANG = Symbol("hang");

export type ToolHandler = (input: any, call: ToolCall) => unknown;

export interface ToolServer {
  readonly server: Server;
  /** The URL of tool `name`. */
  url(name: string): string;
  /**
   * An `http()` tool for `name` at this server (`POST /<name>`); its handler must be one this
   * server was started with.
   */
  tool<I, O = undefined>(
    name: string,
    options: { input: I; output?: O; description?: string; approval?: "always" | "never"; timeoutMs?: number },
  ): ToolDefinition<any, any, any>;
  /** Every call, in order. */
  readonly calls: ToolCall[];
  /** The first call that matches (received already or later). */
  next(match?: (call: ToolCall) => boolean, timeoutMs?: number): Promise<ToolCall>;
  close(): Promise<void>;
}

/** Serves `handlers`, one per tool name, on a local port. */
export async function startToolServer(handlers: Record<string, ToolHandler>): Promise<ToolServer> {
  const calls: ToolCall[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString();
    const name = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname.slice(1));
    const handler = handlers[name];
    if (!handler) return void response.writeHead(404).end(`no tool ${name}`);
    const call: ToolCall = { name, input: text ? JSON.parse(text) : undefined, headers: request.headers };
    calls.push(call);
    try {
      const result = await handler(call.input, call);
      if (result === HANG) return;
      const answer =
        result && typeof result === "object" && REPLY in result
          ? (result as unknown as ToolReply)
          : { status: 200, body: result };
      response.writeHead(answer.status, { "content-type": "application/json" });
      response.end(answer.body === undefined ? "" : JSON.stringify(answer.body));
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain" }).end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const url = (name: string) => `${base}/${encodeURIComponent(name)}`;
  return {
    server,
    url,
    tool: (name, options) =>
      http({
        name,
        input: options.input as never,
        ...(options.output === undefined ? {} : { output: options.output as never }),
        ...(options.description === undefined ? {} : { description: options.description }),
        ...(options.approval === undefined ? {} : { approval: options.approval }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        url: url(name),
      }) as ToolDefinition<any, any, any>,
    calls,
    async next(match = () => true, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = calls.find(match);
        if (found) return found;
        if (Date.now() > deadline)
          throw new Error(`no matching tool call within ${timeoutMs}ms; received: ${calls.map((c) => c.name).join(", ")}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
