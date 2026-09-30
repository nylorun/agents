/**
 * Action endpoints for runtime tests (design: Action endpoints). Two shapes:
 *
 * - `startEndpoint`: a raw `node:http` endpoint that records every delivery and answers it
 *   as the test says (inline with an outcome, `202`, or not at all). A test that plays the
 *   agent by hand answers a `202` later through `delivery.result(...)`, which posts
 *   `/v1/actions/:id/result` with the delivery token.
 * - `serveAgents`: the SDK's `createActionHandler` on a local server, registered for the
 *   given agents (it saves their definitions first), so their own tool code runs.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { OUTCOME_HEADER, SIGNATURE_HEADER } from "@nylorun/core/compatibility";
import type { Action } from "@nylorun/core/contracts";
import { createActionHandler, type AgentsClient, type BuiltWorkflow } from "@nylorun/agents";

type AgentSource = Parameters<typeof createActionHandler>[0]["agents"][number];

/** How the endpoint answers one delivery. `"hang"` keeps the request open. */
export type EndpointAnswer =
  | { status: number; headers?: Record<string, string>; body?: unknown }
  | "hang";

/** A tagged outcome answer (`Nylorun-Outcome: 1`): the Action's outcome as it is. */
export const outcome = (value: unknown): EndpointAnswer => ({
  status: 200,
  headers: { [OUTCOME_HEADER]: "1" },
  body: { value },
});

/** A completed tool's outcome, answered inline. */
export const completed = (output: unknown): EndpointAnswer =>
  outcome({ kind: "completed", output });

/** `202`: the endpoint works in the background and posts the outcome later. */
export const accepted: EndpointAnswer = { status: 202 };

export interface Delivery {
  action: Action;
  /** The delivery token (`Nylorun-Signature`), good for this Action's callbacks. */
  token: string;
  sandbox: boolean;
  body: string;
  request: IncomingMessage;
  /**
   * Posts the Action's outcome (`POST /v1/actions/:id/result` with `{ value }`) for a
   * delivery answered `202`.
   */
  result(value: unknown): Promise<{ status: number; body: any }>;
  /** `POST /v1/actions/:id/heartbeat` with the delivery token. */
  heartbeat(): Promise<{ status: number; body: any }>;
  /** `POST /v1/actions/:id/sandbox/:tool` with the delivery token. */
  sandboxTool(tool: string, input: unknown): Promise<{ status: number; body: any }>;
}

export interface TestEndpoint {
  url: string;
  port: number;
  server: Server;
  /** Every Action delivery received, in order (pings are not listed). */
  deliveries: Delivery[];
  /** Waits for the first delivery that matches (received already or later), and returns it. */
  next(match?: (delivery: Delivery) => boolean, timeoutMs?: number): Promise<Delivery>;
  close(): Promise<void>;
}

export interface StartEndpointOptions {
  /** The Runtime the deliveries come from, for the `Delivery` callbacks. */
  runtime: { url: string; tenantId?: string };
  /** Answers each Action delivery. Default: `202`. */
  answer?: (delivery: Delivery) => EndpointAnswer | Promise<EndpointAnswer>;
  port?: number;
}

/** A raw endpoint that records each delivery; see the module comment. */
export async function startEndpoint(options: StartEndpointOptions): Promise<TestEndpoint> {
  const deliveries: Delivery[] = [];
  const waiters = new Set<() => void>();
  const callback = async (path: string, token: string, body?: unknown) => {
    const response = await fetch(`${options.runtime.url}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body: (await response.json().catch(() => undefined)) as any,
    };
  };
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => {
      void (async () => {
        const parsed = JSON.parse(text) as
          | { type: "action"; action: Action; sandbox: boolean }
          | { type: "ping"; agentId: string };
        if (parsed.type === "ping") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ agentId: parsed.agentId, implementationVersion: "dev" }));
          return;
        }
        const token = String(request.headers[SIGNATURE_HEADER.toLowerCase()]);
        const id = encodeURIComponent(parsed.action.actionId);
        const delivery: Delivery = {
          action: parsed.action,
          token,
          sandbox: parsed.sandbox,
          body: text,
          request,
          result: (value) => callback(`/v1/actions/${id}/result`, token, { value }),
          heartbeat: () => callback(`/v1/actions/${id}/heartbeat`, token),
          sandboxTool: (tool, input) =>
            callback(`/v1/actions/${id}/sandbox/${encodeURIComponent(tool)}`, token, input),
        };
        deliveries.push(delivery);
        for (const wake of waiters) wake();
        const answer = options.answer ? await options.answer(delivery) : accepted;
        if (answer === "hang") return;
        response.writeHead(answer.status, {
          "content-type": "application/json",
          ...answer.headers,
        });
        response.end(answer.body === undefined ? "" : JSON.stringify(answer.body));
      })().catch((error) => {
        response.writeHead(500).end(String(error));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/actions`,
    port,
    server,
    deliveries,
    async next(match = () => true, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = deliveries.find(match);
        if (found) return found;
        const left = deadline - Date.now();
        if (left <= 0)
          throw new Error(
            `no matching delivery within ${timeoutMs}ms; received: ${JSON.stringify(
              deliveries.map((d) => ({ kind: d.action.kind, actionId: d.action.actionId })),
            )}`,
          );
        await new Promise<void>((resolve) => {
          const wake = () => {
            clearTimeout(timer);
            waiters.delete(wake);
            resolve();
          };
          const timer = setTimeout(wake, Math.min(left, 250));
          waiters.add(wake);
        });
      }
    },
    close: () => closeServer(server),
  };
}

/** Registers `url` as the Action endpoint of each agent (`PUT /v1/endpoints`). */
export async function registerEndpoint(
  runtime: { url: string; headers(key?: string): Record<string, string> },
  agentIds: string | readonly string[],
  url: string,
  extra: { implementationVersion?: string; manifestHash?: string; timeoutMs?: number; maxConcurrent?: number } = {},
): Promise<void> {
  const { implementationVersion = "dev", ...rest } = extra;
  const response = await fetch(`${runtime.url}/v1/endpoints`, {
    method: "PUT",
    headers: runtime.headers(),
    body: JSON.stringify({
      endpoints: [agentIds].flat().map((agentId) => ({ agentId, url, implementationVersion, ...rest })),
    }),
  });
  if (!response.ok)
    throw new Error(`Failed to register endpoints: ${response.status} ${await response.text()}`);
}

export interface ServedAgents {
  /** Settles once the endpoint listens and the agents are saved and registered. */
  readonly ready: Promise<void>;
  /** The endpoint's URL, once `ready`. */
  readonly url: string;
  close(): Promise<void>;
}

export interface ServeAgentsOptions {
  agents: readonly (AgentSource | BuiltWorkflow)[];
  /** The application client that saves and registers the agents. */
  application: AgentsClient;
  implementationVersion?: string;
  /** Skip saving the definitions (they are saved already). */
  saveDefinitions?: boolean;
  /** Registered with each endpoint: how long one inline delivery may take. */
  timeoutMs?: number;
  /** Registered with each endpoint: in-flight deliveries per agent. */
  maxConcurrent?: number;
  onError?: (error: unknown) => void;
}

/**
 * Serves agents with the SDK's `createActionHandler` on a local server and registers it,
 * as an application does: the counterpart of the removed `connectAgents`.
 */
export function serveAgents(options: ServeAgentsOptions): ServedAgents {
  const server = createServer();
  let url = "";
  const ready = (async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/actions`;
    const handler = createActionHandler({
      agents: options.agents,
      client: options.application,
      url,
      ...(options.implementationVersion === undefined
        ? {}
        : { implementationVersion: options.implementationVersion }),
      ...(options.onError ? { onError: options.onError } : {}),
    });
    server.on("request", handler.node);
    await handler.register({
      url,
      ...(options.saveDefinitions === undefined ? {} : { saveDefinitions: options.saveDefinitions }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.maxConcurrent === undefined ? {} : { maxConcurrent: options.maxConcurrent }),
    });
  })();
  void ready.catch(() => {});
  return {
    ready,
    get url() {
      return url;
    },
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
