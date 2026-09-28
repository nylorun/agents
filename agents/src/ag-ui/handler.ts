/**
 * An AG-UI endpoint over the Tenant's agents, as web-standard `Request` → `Response`
 * handlers. The host authenticates people (`subject`); the handler maps each AG-UI thread to
 * one session per subject, agent and thread, and streams the session's transcript events as
 * AG-UI events. It never trusts a session id from the client, and it calls the Runtime as the
 * subject (`client.as`), so the Runtime itself keeps one subject out of another's sessions.
 */
import { createHash, randomUUID } from "node:crypto";
import { EventType, type BaseEvent, type Message, type RunAgentInput } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import type { BuiltWorkflow } from "@nylorun/core/define";
import {
  parseSubjectHeaders,
  type LiveEvent,
  type SubjectScope,
} from "@nylorun/core/contracts";
import {
  createClient,
  type AgentSource,
  type AgentsClient,
  type SessionClient,
} from "../client.js";
import { IncompatibleRuntimeError, RuntimeError } from "../http.js";
import { messagesFromEvents } from "./history.js";
import { SSE_CONTENT_TYPE, SSE_HEARTBEAT, sseFrame } from "./sse.js";
import { RunTranslator } from "./translate.js";

const HEARTBEAT_MS = 15_000;
/** Host features the handler needs: the chat transcript, and acting for each subject. */
const REQUIRED_FEATURES = ["transcript-events", "subject-headers"] as const;
const DEFAULT_SCOPES: readonly SubjectScope[] = ["sessions:own"];
const TERMINAL = new Set([
  "turn.completed",
  "turn.paused",
  "turn.failed",
  "turn.cancelled",
]);

/** Per-session parameters the host may add, such as the person's vault for MCP servers. */
export interface AgUiSessionOptions {
  /** Part of the session's identity: keep it stable for a subject and agent, or runs get 409. */
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

function problemOf(error: unknown): Problem {
  if (error instanceof Problem) return error;
  if (error instanceof RuntimeError) {
    if (error.status === 404) return new Problem(404, "Not found");
    if (error.status === 409)
      return new Problem(
        409,
        "The agent is busy or waiting for an answer to an open interrupt",
        "session_busy"
      );
    return new Problem(502, "The agent service failed", "runtime_error");
  }
  if (error instanceof IncompatibleRuntimeError)
    return new Problem(502, error.message, "runtime_incompatible");
  return new Problem(500, "Internal error");
}

/** A session per subject, agent and thread; one subject can never name another's session. */
export function sessionIdFor(subject: string, agentId: string, threadId: string): string {
  return createHash("sha256")
    .update(`${subject}\u0000${agentId}\u0000${threadId}`)
    .digest("hex")
    .slice(0, 32);
}

/** The trailing user message: the Runtime keeps the transcript, AG-UI resends all of it. */
function lastUserMessage(messages: readonly Message[]): { id: string; text: string } {
  const last = messages.at(-1);
  if (!last || last.role !== "user")
    throw new Problem(400, "The run's last message must be a user message");
  const text =
    typeof last.content === "string"
      ? last.content
      : last.content
          .filter((part) => part.type === "text")
          .map((part) => (part as { text: string }).text)
          .join("\n");
  if (!text.trim()) throw new Problem(400, "The user message has no text");
  return { id: last.id, text };
}

function normalizeBase(basePath = "/"): string {
  const trimmed = basePath.replace(/\/+$/, "");
  return trimmed === "" ? "" : trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function createAgUiHandler(options: AgUiHandlerOptions): AgUiHandler {
  const allowed = new Set(
    options.agents.map((agent) => (typeof agent === "string" ? agent : agent.id))
  );
  const base = normalizeBase(options.basePath);
  const scopes = options.scopes ?? DEFAULT_SCOPES;
  const checked = parseSubjectHeaders("probe", scopes.join(" "));
  if (!checked.ok) throw new TypeError(`createAgUiHandler: ${checked.message}`);
  let ready: Promise<AgentsClient> | undefined;

  /** The client, once the Runtime is known to have every required feature. Retries after a failure. */
  function connected(): Promise<AgentsClient> {
    ready ??= (async () => {
      const client = await (options.client ?? createClient());
      const features = await client.hostFeatures();
      const missing = REQUIRED_FEATURES.filter((f) => !features.includes(f));
      if (missing.length > 0)
        throw new Problem(
          502,
          `The Runtime does not support ${missing.join(", ")}; upgrade the stack (nylorun up).`,
          "runtime_feature_missing"
        );
      return client;
    })();
    ready.catch(() => {
      ready = undefined;
    });
    return ready;
  }

  /** The client acting for `subject`: the Runtime limits it to the subject's own sessions. */
  async function clientFor(subject: string): Promise<AgentsClient> {
    const client = await connected();
    try {
      return client.as(subject, { scopes });
    } catch (error) {
      // The host's `subject` returned something the Runtime cannot name (see `as`).
      throw new Problem(500, (error as Error).message, "subject_invalid");
    }
  }

  async function subjectOf(request: Request): Promise<string> {
    const subject = await options.subject(request);
    if (!subject) throw new Problem(401, "Sign in required");
    return subject;
  }

  function assertAgent(agentId: string): void {
    if (!allowed.has(agentId)) throw new Problem(404, "Not found");
  }

  async function sessionFor(
    request: Request,
    agentId: string,
    threadId: string
  ): Promise<{ client: AgentsClient; subject: string; session: SessionClient }> {
    assertAgent(agentId);
    const subject = await subjectOf(request);
    const client = await clientFor(subject);
    return {
      client,
      subject,
      session: client.session(sessionIdFor(subject, agentId, threadId)),
    };
  }

  async function submit(
    session: SessionClient,
    input: RunAgentInput
  ): Promise<string | null> {
    if (input.resume?.length) {
      let cursor: string | null = null;
      // The interaction's kind is on the pending view, not in its id.
      const pending = await session.pending();
      const waits = Array.isArray(pending) ? pending : [];
      for (const entry of input.resume) {
        const wait = waits.find(
          (w) => (w as { interaction?: { id?: string } })?.interaction?.id === entry.interruptId
        ) as { interaction?: { kind?: string } } | undefined;
        const key = `${input.runId}:${entry.interruptId}`;
        const payload = entry.payload as { approved?: unknown } | boolean | undefined;
        const accepted =
          (wait?.interaction?.kind ?? "approval") === "approval"
            ? await session.approve(
                entry.interruptId,
                entry.status === "resolved" &&
                  (payload === true ||
                    (typeof payload === "object" && payload?.approved === true)),
                { idempotencyKey: key }
              )
            : entry.status === "cancelled"
            ? await session.cancel({ idempotencyKey: key, reason: "interrupt cancelled" })
            : await session.respond(entry.interruptId, (entry.payload ?? null) as never, {
                idempotencyKey: key,
              });
        cursor ??= accepted.cursor;
      }
      return cursor;
    }
    const message = lastUserMessage(input.messages);
    // The AG-UI message id is the idempotency key: a retried run replays the same turn,
    // and history gives the message back its client id.
    const accepted = await session.input(message.text, {
      idempotencyKey: message.id,
    });
    return accepted.cursor;
  }

  /** Streams translated events until the run ends. Closing the response stops the read only. */
  function stream(
    request: Request,
    translator: RunTranslator,
    source: ((signal: AbortSignal) => AsyncIterable<LiveEvent>) | undefined,
    preface: BaseEvent[] = []
  ): Response {
    const reading = new AbortController();
    request.signal.addEventListener("abort", () => reading.abort(), { once: true });
    const bytes = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const write = (text: string) => {
          try {
            controller.enqueue(bytes.encode(text));
          } catch {
            reading.abort();
          }
        };
        const heartbeat = setInterval(() => write(SSE_HEARTBEAT), HEARTBEAT_MS);
        try {
          write(sseFrame(translator.started()));
          for (const event of preface) write(sseFrame(event));
          if (source)
            for await (const event of source(reading.signal)) {
              const step = translator.translate(event);
              step.events.forEach((out, index) =>
                write(
                  sseFrame(out, index === step.events.length - 1 ? event.cursor : undefined)
                )
              );
              if (step.finished || reading.signal.aborted) break;
            }
        } catch (error) {
          if (!reading.signal.aborted) {
            const failure = problemOf(error);
            write(
              sseFrame({
                type: EventType.RUN_ERROR,
                message: failure.message,
                ...(failure.code ? { code: failure.code } : {}),
              } as BaseEvent)
            );
          }
        } finally {
          clearInterval(heartbeat);
          reading.abort();
          try {
            controller.close();
          } catch {
            /* the client is gone */
          }
        }
      },
      cancel() {
        reading.abort();
      },
    });
    return new Response(body, {
      headers: {
        "content-type": SSE_CONTENT_TYPE,
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    });
  }

  async function run(request: Request, agentId: string): Promise<Response> {
    try {
      assertAgent(agentId);
      const subject = await subjectOf(request);
      const parsed = RunAgentInputSchema.safeParse(
        await request.json().catch(() => undefined)
      );
      if (!parsed.success) throw new Problem(400, "Invalid RunAgentInput");
      const input = parsed.data as RunAgentInput;
      // Nylorun tools run in the Runtime or the app's executor; the browser runs none.
      if (input.tools?.length)
        throw new Problem(400, "Frontend tools are not supported");
      const client = await clientFor(subject);
      const extra = (await options.session?.(subject, agentId)) ?? {};
      const translator = new RunTranslator(input.threadId, input.runId);
      let session: SessionClient;
      try {
        // The host's parameters first: they never replace the session's identity.
        session = await client.createSession({
          ...extra,
          id: sessionIdFor(subject, agentId, input.threadId),
          agentId,
          ownerUserId: subject,
        });
      } catch (error) {
        if (error instanceof RuntimeError && error.status === 409)
          throw new Problem(
            409,
            "The thread's session was opened with other parameters",
            "session_conflict"
          );
        throw error;
      }
      let cursor: string | null;
      try {
        cursor = await submit(session, input);
      } catch (error) {
        const failure = problemOf(error);
        // A busy or paused session is a run that could not start, not a transport failure.
        if (failure.status !== 409) throw failure;
        return stream(request, translator, undefined, [
          {
            type: EventType.RUN_ERROR,
            message: failure.message,
            code: failure.code,
          } as BaseEvent,
        ]);
      }
      return stream(request, translator, (signal) =>
        session.observe({ ...(cursor ? { cursor } : {}), signal })
      );
    } catch (error) {
      const failure = problemOf(error);
      return problem(failure.status, failure.message, failure.code);
    }
  }

  async function history(
    request: Request,
    agentId: string,
    threadId: string
  ): Promise<Response> {
    try {
      const { session } = await sessionFor(request, agentId, threadId);
      const items: LiveEvent[] = [];
      let cursor: string | undefined;
      try {
        for (;;) {
          const page = await session.history({ ...(cursor ? { cursor } : {}) });
          items.push(...page.items);
          if (!page.cursor || page.cursor === cursor || page.items.length === 0) break;
          cursor = page.cursor;
        }
      } catch (error) {
        // A thread that never ran has no session yet.
        if (error instanceof RuntimeError && error.status === 404)
          return Response.json([]);
        throw error;
      }
      return Response.json(messagesFromEvents(items));
    } catch (error) {
      const failure = problemOf(error);
      return problem(failure.status, failure.message, failure.code);
    }
  }

  async function reattach(
    request: Request,
    agentId: string,
    threadId: string
  ): Promise<Response> {
    try {
      const { session } = await sessionFor(request, agentId, threadId);
      const url = new URL(request.url);
      const cursor =
        request.headers.get("last-event-id") ?? url.searchParams.get("cursor");
      if (!cursor) throw new Problem(400, "Last-Event-ID or ?cursor= is required");
      const view = await session.inspect();
      const runId =
        url.searchParams.get("runId") ??
        view.activeTurnId ??
        (typeof view.lastTurnId === "string" ? view.lastTurnId : randomUUID());
      const translator = new RunTranslator(threadId, runId, { reattached: true });
      if (view.activeTurnId)
        return stream(request, translator, (signal) =>
          session.observe({ cursor, signal })
        );
      // No turn is running: send what the client missed, if the run ended after the cursor.
      const missed: LiveEvent[] = [];
      let from = cursor;
      for (;;) {
        const page = await session.history({ cursor: from });
        missed.push(...page.items);
        if (!page.cursor || page.cursor === from || page.items.length === 0) break;
        from = page.cursor;
      }
      if (!missed.some((event) => TERMINAL.has(event.type)))
        return new Response(null, { status: 204 });
      return stream(request, translator, () => iterate(missed));
    } catch (error) {
      const failure = problemOf(error);
      return problem(failure.status, failure.message, failure.code);
    }
  }

  async function cancel(
    request: Request,
    agentId: string,
    threadId: string
  ): Promise<Response> {
    try {
      const { session } = await sessionFor(request, agentId, threadId);
      await session.cancel({ idempotencyKey: `cancel:${randomUUID()}` });
      return new Response(null, { status: 204 });
    } catch (error) {
      const failure = problemOf(error);
      return problem(failure.status, failure.message, failure.code);
    }
  }

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
        .map((segment) => decodeURIComponent(segment));
    } catch {
      return problem(404, "Not found");
    }
    if (segments.some((segment) => segment === "")) return problem(404, "Not found");
    const [agentId, threads, threadId, action] = segments;
    const method = request.method.toUpperCase();
    const operation = (
      allow: string,
      handle: () => Promise<Response>
    ): Promise<Response> | Response => {
      if (!agentId || !allowed.has(agentId)) return problem(404, "Not found");
      if (method !== allow)
        return new Response(
          JSON.stringify({ error: "Method not allowed" }),
          {
            status: 405,
            headers: { allow, "content-type": "application/json" },
          }
        );
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

async function* iterate<T>(items: readonly T[]): AsyncIterable<T> {
  yield* items;
}
