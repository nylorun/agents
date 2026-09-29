/**
 * An A2A endpoint over the Tenant's agents, as a web-standard `Request` → `Response` handler
 * (gateway mode). The host authenticates each partner (`subject`); the handler forwards the
 * partner's JSON-RPC request to the Runtime as that subject, and the Runtime speaks A2A (Host
 * feature `a2a-endpoint`). It parses no A2A message and sends no header the partner chose
 * except `A2A-Version` and `A2A-Extensions`, so a partner can never name a subject or scopes.
 * The Agent Card comes from the Runtime, with this endpoint's URL and the host's provider and
 * security schemes added.
 */
import type { BuiltWorkflow } from "@nylorun/core/define";
import { createClient, type AgentSource, type AgentsClient } from "../client.js";
import { IncompatibleRuntimeError, RuntimeError } from "../http.js";

/** The Host feature the handler forwards to. */
const REQUIRED_FEATURE = "a2a-endpoint";
/** A2A callers run tasks in their own sessions; nothing else. */
const SCOPES = ["sessions:own"] as const;
const CARD_PATH = [".well-known", "agent-card.json"] as const;

/** A partner as the host authenticated it: its subject, and optionally fewer agents. */
export interface A2aCaller {
  /** Owner of the partner's tasks, e.g. `a2a:acme`. Keep it stable for a partner. */
  subject: string;
  /** Agents this partner may use, among the handler's `agents`. Default: all of them. */
  agents?: readonly string[];
}

/** What the published Agent Card adds to the Runtime's: who serves it and how to authenticate. */
export interface A2aCardOptions {
  provider?: { organization: string; url: string };
  documentationUrl?: string;
  iconUrl?: string;
  /** A2A `securitySchemes`, e.g. `{ partnerKey: { apiKeySecurityScheme: { location: "header", name: "X-Partner-Key" } } }`. */
  securitySchemes?: Record<string, unknown>;
  /** A2A `securityRequirements`, e.g. `[{ schemes: { partnerKey: { list: [] } } }]`. */
  securityRequirements?: readonly unknown[];
}

export interface A2aHandlerOptions {
  /** Agents this endpoint serves: built agents, workflows or their ids. Nothing else is reachable. */
  agents: readonly (AgentSource | BuiltWorkflow | string)[];
  /**
   * The partner the request is from, authenticated by the host. `undefined` answers `401`;
   * there is no anonymous mode. Not called for the Agent Card, which is public.
   */
  subject(
    request: Request
  ): string | A2aCaller | undefined | Promise<string | A2aCaller | undefined>;
  /** Where `fetch` is mounted, e.g. `/a2a`. Default `/`. */
  basePath?: string;
  /**
   * The public URL of `basePath` as partners reach it, e.g. `https://api.example.com/a2a`.
   * Default: the origin of each card request. Set it behind a proxy.
   */
  publicUrl?: string;
  /** Application client. Default: `createClient()`, from the environment or the Project link. */
  client?: AgentsClient | Promise<AgentsClient>;
  card?: A2aCardOptions;
}

export interface A2aHandler {
  /** One entry point that routes by method and path under `basePath`. Bound. */
  readonly fetch: (request: Request) => Promise<Response>;
  /** `POST {basePath}/{agent}`: one A2A JSON-RPC request, forwarded. */
  call(request: Request, agentId: string): Promise<Response>;
  /** `GET {basePath}/{agent}/.well-known/agent-card.json`: the agent's card. */
  card(request: Request, agentId: string): Promise<Response>;
}

class Problem extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly headers: Readonly<Record<string, string>> = {}
  ) {
    super(message);
  }
}

function problem(failure: Problem): Response {
  return Response.json(
    { error: failure.message, ...(failure.code ? { code: failure.code } : {}) },
    { status: failure.status, headers: failure.headers }
  );
}

function problemOf(error: unknown): Problem {
  if (error instanceof Problem) return error;
  if (error instanceof IncompatibleRuntimeError)
    return new Problem(502, error.message, "runtime_incompatible");
  if (error instanceof RuntimeError && error.status === 404)
    return new Problem(404, "Not found");
  return new Problem(502, "The agent service failed", "runtime_error");
}

function normalizeBase(basePath = "/"): string {
  const trimmed = basePath.replace(/\/+$/, "");
  return trimmed === "" ? "" : trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function createA2aHandler(options: A2aHandlerOptions): A2aHandler {
  const allowed = new Set(
    options.agents.map((agent) => (typeof agent === "string" ? agent : agent.id))
  );
  const base = normalizeBase(options.basePath);
  const publicUrl = options.publicUrl?.replace(/\/+$/, "");
  if (publicUrl !== undefined && !/^https?:\/\//.test(publicUrl))
    throw new TypeError("createA2aHandler: publicUrl must be an http(s) URL");
  let ready: Promise<AgentsClient> | undefined;

  /** The client, once the Runtime is known to serve A2A. Retries after a failure. */
  function connected(): Promise<AgentsClient> {
    ready ??= (async () => {
      const client = await (options.client ?? createClient());
      const features = await client.hostFeatures();
      if (!features.includes(REQUIRED_FEATURE))
        throw new Problem(
          502,
          `The Runtime does not support ${REQUIRED_FEATURE}; upgrade the stack (nylorun up).`,
          "runtime_feature_missing"
        );
      return client;
    })();
    ready.catch(() => {
      ready = undefined;
    });
    return ready;
  }

  const runtimePath = (agentId: string) => `/v1/a2a/agents/${encodeURIComponent(agentId)}`;

  async function callerOf(request: Request, agentId: string): Promise<string> {
    const found = await options.subject(request);
    if (!found) throw new Problem(401, "Authentication required");
    const caller = typeof found === "string" ? { subject: found } : found;
    // An agent this partner may not use is the same 404 as one that does not exist.
    if (caller.agents !== undefined && !caller.agents.includes(agentId))
      throw new Problem(404, "Not found");
    return caller.subject;
  }

  async function call(request: Request, agentId: string): Promise<Response> {
    try {
      if (!allowed.has(agentId)) throw new Problem(404, "Not found");
      const subject = await callerOf(request, agentId);
      const client = await connected();
      let runtime: AgentsClient;
      try {
        runtime = client.as(subject, { scopes: SCOPES });
      } catch (error) {
        // The host's `subject` returned something the Runtime cannot name (see `as`).
        throw new Problem(500, (error as Error).message, "subject_invalid");
      }
      const headers: Record<string, string> = {};
      const version =
        request.headers.get("a2a-version") ??
        new URL(request.url).searchParams.get("A2A-Version");
      if (version !== null) headers["A2A-Version"] = version;
      const extensions = request.headers.get("a2a-extensions");
      if (extensions !== null) headers["A2A-Extensions"] = extensions;
      const response = await runtime.transport.forward(runtimePath(agentId), {
        method: "POST",
        body: await request.text(),
        headers,
        signal: request.signal,
      });
      if (response.ok)
        return new Response(response.body, {
          status: response.status,
          headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
        });
      await response.body?.cancel().catch(() => {});
      if (response.status === 404) throw new Problem(404, "Not found");
      if (response.status === 429)
        throw new Problem(429, "Too many requests", "limit_exceeded", {
          ...(response.headers.get("retry-after")
            ? { "retry-after": response.headers.get("retry-after")! }
            : {}),
        });
      if (response.status === 503)
        throw new Problem(503, "The agent service is unavailable", "runtime_unavailable");
      throw new Problem(502, "The agent service failed", "runtime_error");
    } catch (error) {
      return problem(problemOf(error));
    }
  }

  async function card(request: Request, agentId: string): Promise<Response> {
    try {
      if (!allowed.has(agentId)) throw new Problem(404, "Not found");
      const client = await connected();
      const template = await client.transport.json<Record<string, unknown>>(
        `${runtimePath(agentId)}/card`
      );
      const root = publicUrl ?? `${new URL(request.url).origin}${base}`;
      const extra = options.card ?? {};
      return Response.json(
        {
          ...template,
          supportedInterfaces: [
            {
              url: `${root}/${encodeURIComponent(agentId)}`,
              protocolBinding: "JSONRPC",
              protocolVersion: "1.0",
            },
          ],
          ...(extra.provider ? { provider: extra.provider } : {}),
          ...(extra.documentationUrl ? { documentationUrl: extra.documentationUrl } : {}),
          ...(extra.iconUrl ? { iconUrl: extra.iconUrl } : {}),
          ...(extra.securitySchemes ? { securitySchemes: extra.securitySchemes } : {}),
          ...(extra.securityRequirements
            ? { securityRequirements: extra.securityRequirements }
            : {}),
        },
        { headers: { "cache-control": "public, max-age=300" } }
      );
    } catch (error) {
      return problem(problemOf(error));
    }
  }

  async function route(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path !== base && !path.startsWith(`${base}/`))
      return problem(new Problem(404, "Not found"));
    let segments: string[];
    try {
      segments = path
        .slice(base.length)
        .split("/")
        .slice(1)
        .map((segment) => decodeURIComponent(segment));
    } catch {
      return problem(new Problem(404, "Not found"));
    }
    if (segments.some((segment) => segment === "")) return problem(new Problem(404, "Not found"));
    const [agentId, ...rest] = segments;
    if (!agentId || !allowed.has(agentId)) return problem(new Problem(404, "Not found"));
    const method = request.method.toUpperCase();
    const only = (allow: string, handle: () => Promise<Response>) =>
      method === allow
        ? handle()
        : Promise.resolve(
            problem(new Problem(405, "Method not allowed", undefined, { allow }))
          );
    if (rest.length === 0) return only("POST", () => call(request, agentId));
    if (rest.length === 2 && rest[0] === CARD_PATH[0] && rest[1] === CARD_PATH[1])
      return only("GET", () => card(request, agentId));
    return problem(new Problem(404, "Not found"));
  }

  return { fetch: route, call, card };
}
