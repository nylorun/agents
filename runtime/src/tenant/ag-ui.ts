/**
 * The Runtime's AG-UI endpoint (Host feature `ag-ui-endpoint`): the Tenant's agents served to
 * AG-UI clients, for a person named by a subject token (a browser or app) or by subject headers
 * (an app server's `createAgUiHandler`, which forwards here). One implementation for both, so
 * a thread is the same session whichever way it is reached.
 *
 * Routes, under `/v1/ag-ui/agents/:agent`:
 * - `POST` — run: a `RunAgentInput` in, the run's events out as server-sent events;
 * - `GET …/threads/:thread/messages` — the thread's messages as AG-UI `Message[]`;
 * - `GET …/threads/:thread/events` — the rest of a run after a dropped connection
 *   (`Last-Event-ID` or `?cursor=`, optional `?runId=`);
 * - `POST …/threads/:thread/cancel` — cancel the running turn.
 *
 * Each thread maps to one session per subject, agent and thread. The message id is the
 * idempotency key, approvals become interrupts resumed through `resume`, and the last AG-UI
 * event made from each Runtime event carries its cursor as the SSE id. A run's session is
 * created on its first run with the options in `forwardedProps.nylorun.session` and never
 * changed afterwards. A stream opened with a subject token ends at the token's expiry or
 * revocation with `CUSTOM nylorun.stream_closed`, and the client reattaches with a new token.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  EventType,
  type BaseEvent,
  type Message,
  type RunAgentInput,
} from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import {
  PutSessionRequestSchema,
  type LiveEvent,
} from "@nylorun/core/contracts";
import { messagesFromEvents } from "../ag-ui/history.js";
import { sessionIdFor } from "../ag-ui/session-id.js";
import { SSE_CONTENT_TYPE, SSE_HEARTBEAT, sseFrame } from "../ag-ui/sse.js";
import { RunTranslator } from "../ag-ui/translate.js";
import { accessOf } from "./auth.js";
import { command } from "./commands.js";
import { loadSession, sessionOf, type AuthScope, type TenantContext } from "./context.js";
import { fail, HttpError, readBody } from "./http.js";
import {
  observeSession,
  readHistory,
  StreamClosed,
  type StreamHolder,
} from "./live.js";
import { putSession, sessionView } from "./sessions.js";
import { mayUseAgent } from "./tokens.js";

const HEARTBEAT_MS = 15_000;
const TERMINAL = new Set([
  "turn.completed",
  "turn.paused",
  "turn.failed",
  "turn.cancelled",
]);

type Json = (value: unknown, status?: number) => void;

/** The person a request acts for: a subject token's subject, or `Nylorun-Subject`. */
function personOf(scope: AuthScope): string {
  if (scope.kind === "token" || scope.kind === "subject") return scope.subject;
  return fail(
    400,
    "AG-UI runs act for a person: send a subject token, or Nylorun-Subject with the application key",
    { code: "invalid_request" }
  );
}

function holderOf(scope: AuthScope): StreamHolder | undefined {
  return scope.kind === "token"
    ? { subject: scope.subject, epoch: scope.epoch, expiresAt: scope.expiresAt }
    : undefined;
}

/** A refusal a client can act on, streamed as `RUN_ERROR` rather than an HTTP error. */
function runError(error: HttpError): BaseEvent {
  const code =
    error.status === 409
      ? "session_busy"
      : (error.rejection.code ?? "request_rejected");
  const message =
    error.status === 409
      ? "The agent is busy or waiting for an answer to an open interrupt"
      : error.message;
  return { type: EventType.RUN_ERROR, message, code } as BaseEvent;
}

/** The trailing user message: the Runtime keeps the transcript, AG-UI resends all of it. */
function lastUserMessage(messages: readonly Message[]): { id: string; text: string } {
  const last = messages.at(-1);
  if (!last || last.role !== "user")
    return fail(400, "The run's last message must be a user message");
  const text =
    typeof last.content === "string"
      ? last.content
      : last.content
          .filter((part) => part.type === "text")
          .map((part) => (part as { text: string }).text)
          .join("\n");
  if (!text.trim()) return fail(400, "The user message has no text");
  return { id: last.id, text };
}

/** `forwardedProps.nylorun.session`: the options a thread's session is created with. */
function sessionOptions(
  input: RunAgentInput,
  scope: AuthScope
): { info?: Record<string, unknown>; vaultIds?: string[]; credentialSelections?: unknown[] } {
  const raw = (input.forwardedProps as { nylorun?: { session?: unknown } } | undefined)
    ?.nylorun?.session;
  if (raw === undefined) return {};
  const parsed = PutSessionRequestSchema.pick({
    info: true,
    vaultIds: true,
    credentialSelections: true,
  })
    .strict()
    .safeParse(raw);
  if (!parsed.success)
    return fail(400, "forwardedProps.nylorun.session is invalid", {
      code: "invalid_request",
    });
  // Agent code may trust `info`: only an app server sets it.
  if (scope.kind === "token" && parsed.data.info !== undefined)
    return fail(403, "A subject token cannot set session info", {
      code: "scope_required",
    });
  return parsed.data as ReturnType<typeof sessionOptions>;
}

async function accepted(
  ctx: TenantContext,
  id: string,
  body: Parameters<typeof command>[2],
  scope: AuthScope
): Promise<string | null> {
  const result = (await command(ctx, id, body, scope)) as { cursor?: string | null };
  return result?.cursor ?? null;
}

async function submit(
  ctx: TenantContext,
  id: string,
  input: RunAgentInput,
  scope: AuthScope
): Promise<string | null> {
  if (input.resume?.length) {
    // The interaction's kind is on the session's pending view, not in its id.
    const view = (await ctx.store.tx(async (t) =>
      sessionView(t, await sessionOf(t, id, accessOf(scope)))
    )) as { waits?: unknown };
    const waits = Array.isArray(view.waits) ? view.waits : [];
    let cursor: string | null = null;
    for (const entry of input.resume) {
      const wait = waits.find(
        (w) =>
          (w as { interaction?: { id?: string } })?.interaction?.id ===
          entry.interruptId
      ) as { interaction?: { kind?: string } } | undefined;
      const key = `${input.runId}:${entry.interruptId}`;
      const payload = entry.payload as { approved?: unknown } | boolean | undefined;
      const base = { requestId: randomUUID(), idempotencyKey: key };
      const next =
        (wait?.interaction?.kind ?? "approval") === "approval"
          ? await accepted(
              ctx,
              id,
              {
                ...base,
                type: "approve",
                interactionId: entry.interruptId,
                approved:
                  entry.status === "resolved" &&
                  (payload === true ||
                    (typeof payload === "object" && payload?.approved === true)),
              },
              scope
            )
          : entry.status === "cancelled"
            ? await accepted(
                ctx,
                id,
                { ...base, type: "cancel", reason: "interrupt cancelled" },
                scope
              )
            : await accepted(
                ctx,
                id,
                {
                  ...base,
                  type: "respond",
                  interactionId: entry.interruptId,
                  value: (entry.payload ?? null) as never,
                },
                scope
              );
      cursor ??= next;
    }
    return cursor;
  }
  const message = lastUserMessage(input.messages);
  // The AG-UI message id is the idempotency key: a retried run replays the same turn, and
  // history gives the message back its client id.
  return accepted(
    ctx,
    id,
    {
      type: "message",
      requestId: randomUUID(),
      idempotencyKey: message.id,
      content: message.text,
    },
    scope
  );
}

/**
 * Streams translated events until the run ends. Closing the connection stops the read, never
 * the turn.
 */
async function stream(
  response: ServerResponse,
  translator: RunTranslator,
  source: ((signal: AbortSignal) => AsyncIterable<LiveEvent>) | undefined,
  preface: readonly BaseEvent[] = []
): Promise<void> {
  const reading = new AbortController();
  response.on("close", () => reading.abort());
  response.writeHead(200, {
    "content-type": SSE_CONTENT_TYPE,
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();
  const write = (text: string) => {
    if (!response.writableEnded && !response.write(text)) response.destroy();
  };
  const heartbeat = setInterval(() => write(SSE_HEARTBEAT), HEARTBEAT_MS);
  heartbeat.unref();
  try {
    write(sseFrame(translator.started()));
    for (const event of preface) write(sseFrame(event));
    if (source)
      for await (const event of source(reading.signal)) {
        const step = translator.translate(event);
        step.events.forEach((out, index) =>
          write(sseFrame(out, index === step.events.length - 1 ? event.cursor : undefined))
        );
        if (step.finished || reading.signal.aborted) break;
      }
  } catch (error) {
    if (!reading.signal.aborted) {
      if (error instanceof StreamClosed)
        write(
          sseFrame(
            {
              type: EventType.CUSTOM,
              name: "nylorun.stream_closed",
              value: { reason: error.reason },
            } as BaseEvent,
            error.cursor
          )
        );
      else
        write(
          sseFrame(
            error instanceof HttpError
              ? runError(error)
              : ({
                  type: EventType.RUN_ERROR,
                  message: "The agent service failed",
                  code: "runtime_error",
                } as BaseEvent)
          )
        );
    }
  } finally {
    clearInterval(heartbeat);
    reading.abort();
    response.end();
  }
}

async function* iterate<T>(items: readonly T[]): AsyncIterable<T> {
  yield* items;
}

/** Every event of a session from `cursor`, following history pages. */
async function historyFrom(
  ctx: TenantContext,
  id: string,
  cursor: string | undefined
): Promise<LiveEvent[]> {
  const items: LiveEvent[] = [];
  let from = cursor;
  for (;;) {
    const page = await readHistory(ctx, id, from, undefined);
    items.push(...page.items);
    if (!page.cursor || page.cursor === from || page.items.length === 0) break;
    from = page.cursor;
  }
  return items;
}

export async function dispatchAgUi(
  ctx: TenantContext,
  scope: AuthScope,
  method: string | undefined,
  path: readonly string[],
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
  json: Json
): Promise<void> {
  const [, , collection, agentId, threads, threadId, action] = path;
  if (collection !== "agents" || !agentId) return fail(404, "Route not found");
  const subject = personOf(scope);
  // An agent the token may not use is the 404 of a missing one.
  if (!mayUseAgent(scope, agentId)) return fail(404, "Not found");
  const access = accessOf(scope);

  if (path.length === 4 && method === "POST") {
    const parsed = RunAgentInputSchema.safeParse(await readBody(request));
    if (!parsed.success)
      return fail(400, "Invalid RunAgentInput", { code: "invalid_request" });
    const input = parsed.data as RunAgentInput;
    // Nylorun tools run in the Runtime or the app's executor; the browser runs none.
    if (input.tools?.length)
      return fail(400, "Frontend tools are not supported", { code: "invalid_request" });
    const id = sessionIdFor(subject, agentId, input.threadId);
    await putSession(
      ctx,
      id,
      {
        requestId: randomUUID(),
        agentId,
        ownerUserId: subject,
        ...sessionOptions(input, scope),
      } as never,
      access,
      { createOnly: true }
    );
    const translator = new RunTranslator(input.threadId, input.runId);
    let cursor: string | null;
    try {
      cursor = await submit(ctx, id, input, scope);
    } catch (error) {
      // A busy session or a limit is a run that could not start, not a transport failure.
      if (error instanceof HttpError && (error.status === 409 || error.status === 429))
        return stream(response, translator, undefined, [runError(error)]);
      throw error;
    }
    const holder = holderOf(scope);
    return stream(response, translator, (signal) =>
      observeSession(ctx, id, cursor ?? undefined, {
        signal,
        ...(holder ? { holder } : {}),
      })
    );
  }

  if (path.length !== 7 || threads !== "threads" || !threadId)
    return fail(404, "Route not found");
  const id = sessionIdFor(subject, agentId, threadId);

  if (action === "messages" && method === "GET") {
    try {
      await loadSession(ctx, id, access);
    } catch (error) {
      // A thread that never ran has no session yet.
      if (error instanceof HttpError && error.status === 404) return json([]);
      throw error;
    }
    return json(messagesFromEvents(await historyFrom(ctx, id, undefined)));
  }

  if (action === "events" && method === "GET") {
    const header = request.headers["last-event-id"];
    const cursor =
      (typeof header === "string" ? header : undefined) ??
      url.searchParams.get("cursor") ??
      fail(400, "Last-Event-ID or ?cursor= is required", { code: "invalid_request" });
    const session = await loadSession(ctx, id, access);
    const runId =
      url.searchParams.get("runId") ??
      session.activeTurnId ??
      session.lastTurnId ??
      randomUUID();
    const translator = new RunTranslator(threadId, runId, { reattached: true });
    if (session.activeTurnId) {
      const holder = holderOf(scope);
      return stream(response, translator, (signal) =>
        observeSession(ctx, id, cursor, { signal, ...(holder ? { holder } : {}) })
      );
    }
    // No turn is running: send what the client missed, if the run ended after the cursor.
    const missed = await historyFrom(ctx, id, cursor);
    if (!missed.some((event) => TERMINAL.has(event.type))) {
      response.writeHead(204);
      response.end();
      return;
    }
    return stream(response, translator, () => iterate(missed));
  }

  if (action === "cancel" && method === "POST") {
    await accepted(
      ctx,
      id,
      { type: "cancel", requestId: randomUUID(), idempotencyKey: `cancel:${randomUUID()}` },
      scope
    );
    response.writeHead(204);
    response.end();
    return;
  }
  return fail(404, "Route not found");
}
