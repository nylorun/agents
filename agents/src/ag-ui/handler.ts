/**
 * AG-UI for the Tenant's agents, served from the app's own server as web-standard
 * `Request` → `Response` handlers. The host signs people in (`subject`); the handler forwards
 * each request to the Runtime's AG-UI endpoint (Host feature `ag-ui-endpoint`) acting for that
 * person, so the Runtime keeps one person out of another's threads and does all the protocol
 * work. The browser never sees the Tenant key, the Runtime's URL or the Tenant id.
 *
 * The same threads are reachable directly from a browser with a subject token: each thread is
 * one session per subject, agent and thread on both paths.
 */
import { parseSubjectHeaders, type SubjectScope } from "@nylorun/core/contracts";
import type { BuiltWorkflow } from "@nylorun/core/define";
import {
  createClient,
  type AgentSource,
  type AgentsClient,
} from "../client.js";
import { IncompatibleRuntimeError } from "../http.js";

/** The Host feature the handler forwards to. */
const REQUIRED_FEATURES = ["ag-ui-endpoint"] as const;
const DEFAULT_SCOPES: readonly SubjectScope[] = ["sessions:own"];
/** Response headers passed back to the browser; nothing else of the Runtime's. */
const PASSED_HEADERS = ["content-type", "cache-control", "x-accel-buffering"];

/** Per-session parameters the host may add, such as the person's vault for MCP servers. */
export interface AgUiSessionOptions {
  /** Set when the thread's session is created, on its first run; later runs keep them. */
  info?: Record<string, unknown>;
  vaultIds?: readonly string[];
  credentialSelections?: Parameters<
    AgentsClient["createSession"]
  >[0]["credentialSelections"];
}

export interface AgUiHandlerOptions {
  /** Agents this endpoint may run: built agents, workflows or their ids. Nothing else is reachable. */
  agents: readonly (AgentSource | BuiltWorkflow | string)[];
  /** The signed-in person the request is for. `undefined` answers 401; there is no anonymous mode. */
  subject(request: Request): string | undefined | Promise<string | undefined>;
  /** Where `fetch` is mounted, e.g. `/api/agui`. Default `/`. */
  basePath?: string;
  /** Application client. Default: `createClient()`, from the environment or the Project link. */
  client?: AgentsClient | Promise<AgentsClient>;
  /**
   * What each subject may do through this endpoint. Default `["sessions:own"]`; add
   * `vaults:own` if `session()` attaches the person's vaults.
   */
  scopes?: readonly SubjectScope[];
  /** Optional per-session parameters, e.g. the person's vault for connected accounts. */
  session?(
    subject: string,
    agentId: string
  ): AgUiSessionOptions | Promise<AgUiSessionOptions>;
}

export interface AgUiHandler {
  /** One entry point that routes by method and path under `basePath`. Bound. */
  readonly fetch: (request: Request) => Promise<Response>;
  /** `POST`: an AG-UI `RunAgentInput` in, the run's events out as server-sent events. */
  run(request: Request, agentId: string): Promise<Response>;
  /** `GET`: the thread's messages as a plain AG-UI `Message[]`. */
  history(request: Request, agentId: string, threadId: string): Promise<Response>;
  /** `GET`: the rest of a run after a dropped connection, from `Last-Event-ID` or `?cursor=`. */
  reattach(request: Request, agentId: string, threadId: string): Promise<Response>;
  /** `POST`: cancels the thread's running turn. */
  cancel(request: Request, agentId: string, threadId: string): Promise<Response>;
}

class Problem extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message);
  }
}

function problem(status: number, message: string, code?: string): Response {
  return Response.json({ error: message, ...(code ? { code } : {}) }, { status });
}

/** The Runtime's refusal, as the browser may see it: no Runtime details. */
function refusal(status: number): Problem {
  if (status === 404) return new Problem(404, "Not found");
  if (status === 400)
    return new Problem(400, "The request was rejected", "invalid_request");
  if (status === 409)
    return new Problem(
      409,
      "The agent is busy or waiting for an answer to an open interrupt",
      "session_busy"
    );
  return new Problem(502, "The agent service failed", "runtime_error");
}

function problemOf(error: unknown): Problem {
  if (error instanceof Problem) return error;
  if (error instanceof IncompatibleRuntimeError)
    return new Problem(502, error.message, "runtime_incompatible");
  return new Problem(502, "The agent service failed", "runtime_error");
}

function normalizeBase(basePath = "/"): string {
  const trimmed = basePath.replace(/\/+$/, "");
  return trimmed === "" ? "" : trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

const segment = (value: string) => encodeURIComponent(value);

export function createAgUiHandler(options: AgUiHandlerOptions): AgUiHandler {
  const allowed = new Set(
    options.agents.map((agent) => (typeof agent === "string" ? agent : agent.id))
  );
  const base = normalizeBase(options.basePath);
  const scopes = options.scopes ?? DEFAULT_SCOPES;
  const checked = parseSubjectHeaders("probe", scopes.join(" "));
  if (!checked.ok) throw new TypeError(`createAgUiHandler: ${checked.message}`);
  let ready: Promise<AgentsClient> | undefined;

  /** The client, once the Runtime is known to serve AG-UI. Retries after a failure. */
  function connected(): Promise<AgentsClient> {
    ready ??= (async () => {
      const client = await (options.client ?? createClient());
      const features = await client.hostFeatures();
      const missing = REQUIRED_FEATURES.filter((f) => !features.includes(f));
      if (missing.length > 0)
        throw new Problem(
          502,
          `The Runtime does not support ${missing.join(", ")}; update the Runtime (npx nylorun@latest start).`,
          "runtime_feature_missing"
        );
      return client;
    })();
    ready.catch(() => {
      ready = undefined;
    });
    return ready;
  }

  async function subjectOf(request: Request): Promise<string> {
    const subject = await options.subject(request);
    if (!subject) throw new Problem(401, "Sign in required");
    return subject;
  }

  /** Forwards to the Runtime acting for `subject`, and passes the answer back. */
  async function forward(
    request: Request,
    subject: string,
    path: string,
    init: RequestInit
  ): Promise<Response> {
    const client = await connected();
    let person: AgentsClient;
    try {
      person = client.as(subject, { scopes });
    } catch (error) {
      // The host's `subject` returned something the Runtime cannot name (see `as`).
      throw new Problem(500, (error as Error).message, "subject_invalid");
    }
    const response = await person.transport.forward(`/v1/ag-ui/agents${path}`, {
      ...init,
      signal: request.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw refusal(response.status);
    }
    const headers = new Headers();
    for (const name of PASSED_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    return new Response(response.body, { status: response.status, headers });
  }

  async function run(request: Request, agentId: string): Promise<Response> {
    try {
      if (!allowed.has(agentId)) throw new Problem(404, "Not found");
      const subject = await subjectOf(request);
      const body = (await request.json().catch(() => undefined)) as
        | Record<string, unknown>
        | undefined;
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new Problem(400, "Invalid RunAgentInput", "invalid_request");
      // Only the host names the session's options; whatever the browser sent is replaced.
      const forwarded =
        body.forwardedProps && typeof body.forwardedProps === "object"
          ? { ...(body.forwardedProps as Record<string, unknown>) }
          : {};
      delete forwarded.nylorun;
      const extra = (await options.session?.(subject, agentId)) ?? {};
      if (Object.keys(extra).length > 0) forwarded.nylorun = { session: extra };
      return await forward(request, subject, `/${segment(agentId)}`, {
        method: "POST",
        headers: { accept: "text/event-stream" },
        body: JSON.stringify({ ...body, forwardedProps: forwarded }),
      });
    } catch (error) {
      const failure = problemOf(error);
      return problem(failure.status, failure.message, failure.code);
    }
  }

  async function thread(
    request: Request,
    agentId: string,
    threadId: string,
    action: "messages" | "events" | "cancel",
    init: RequestInit
  ): Promise<Response> {
    try {
      if (!allowed.has(agentId)) throw new Problem(404, "Not found");
      const subject = await subjectOf(request);
      const query = new URL(request.url).search;
      return await forward(
        request,
        subject,
        `/${segment(agentId)}/threads/${segment(threadId)}/${action}${query}`,
        init
      );
    } catch (error) {
      const failure = problemOf(error);
      return problem(failure.status, failure.message, failure.code);
    }
  }

  const history = (request: Request, agentId: string, threadId: string) =>
    thread(request, agentId, threadId, "messages", { method: "GET" });

  const reattach = (request: Request, agentId: string, threadId: string) => {
    const cursor = request.headers.get("last-event-id");
    return thread(request, agentId, threadId, "events", {
      method: "GET",
      headers: {
        accept: "text/event-stream",
        ...(cursor ? { "last-event-id": cursor } : {}),
      },
    });
  };

  const cancel = (request: Request, agentId: string, threadId: string) =>
    thread(request, agentId, threadId, "cancel", { method: "POST" });

  async function route(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path !== base && !path.startsWith(`${base}/`))
      return problem(404, "Not found");
    let segments: string[];
    try {
      segments = path
        .slice(base.length)
        .split("/")
        .slice(1)
        .map((part) => decodeURIComponent(part));
    } catch {
      return problem(404, "Not found");
    }
    if (segments.some((part) => part === "")) return problem(404, "Not found");
    const [agentId, threads, threadId, action] = segments;
    const method = request.method.toUpperCase();
    const operation = (
      allow: string,
      handle: () => Promise<Response>
    ): Promise<Response> | Response => {
      if (!agentId || !allowed.has(agentId)) return problem(404, "Not found");
      if (method !== allow)
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
          status: 405,
          headers: { allow, "content-type": "application/json" },
        });
      return handle();
    };
    if (segments.length === 1) return operation("POST", () => run(request, agentId!));
    if (segments.length === 4 && threads === "threads") {
      if (action === "messages")
        return operation("GET", () => history(request, agentId!, threadId!));
      if (action === "events")
        return operation("GET", () => reattach(request, agentId!, threadId!));
      if (action === "cancel")
        return operation("POST", () => cancel(request, agentId!, threadId!));
    }
    return problem(404, "Not found");
  }

  return { fetch: route, run, history, reattach, cancel };
}
