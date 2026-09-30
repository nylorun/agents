/**
 * The Action deliverer (design: Action endpoints §6, §7): sends a pending Action to its agent's
 * Action endpoint and records what comes back, run by `DurableExecution.deliver` one delivery
 * per Action at a time.
 *
 * 1. In one transaction, holding the session's lock: the Action must be `pending`, its turn
 *    active and its agent registered. Below the endpoint's `maxConcurrent`, it becomes
 *    `delivering`, its generation moves on, it gets a deadline, and `action.delivered` is
 *    written.
 * 2. Outside any transaction: the body is signed with a delivery token and POSTed.
 * 3. In a second transaction, only while the Action is still `delivering` at that generation:
 *    the answer becomes the outcome (`recordActionOutcome`, shared with executors), the
 *    Action goes back to `pending` to be tried again, or it is lost.
 *
 * Nothing sent (connection refused, unknown host, a refused address), `429`, `503` and a
 * version mismatch (`409`) are retried with backoff, whatever the kind. A delivery that may have
 * reached the endpoint but got no answer is lost: a tool becomes `uncertain`, a hook, `fn` or
 * `verify` is delivered again. So is a delivery whose deadline passes with no answer, which is
 * how a Worker that died mid-delivery is recovered (the sweep, `expireDeliveries`).
 */
import {
  OUTCOME_HEADER,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  SIGNATURE_HEADER,
} from "@nylorun/core/compatibility";
import {
  ActionOutcomeSchema,
  EndpointPingResponseSchema,
  type Action,
  type ActionOutcome,
  type EndpointPingResponse,
} from "@nylorun/core/contracts";
import type { DeliverResult } from "../execution/types.js";
import { sessionHasSandbox } from "../sandbox/share.js";
import type { EndpointRow, Tx } from "../store/types.js";
import { recordActionOutcome } from "./commands.js";
import { sandboxLookup, type Session, type TenantContext } from "./context.js";
import { mintDeliveryToken } from "./delivery-token.js";
import { fail } from "./http.js";
import { post, type OutboundResult } from "./outbound.js";

const DONE: DeliverResult = { status: "done" };
/** Extra time past the endpoint's timeout before an unanswered delivery counts as lost. */
const DEADLINE_GRACE_MS = 5_000;
/** How long a delivery token outlives the request it signs. */
const TOKEN_SLACK_SECONDS = 60;
/** How soon a delivery refused by a full endpoint is tried again. */
const BUSY_RETRY_MS = 1_000;
const BACKOFF_FIRST_MS = 250;
const BACKOFF_MAX_MS = 30_000;
/** The longest `Retry-After` honoured. */
const RETRY_AFTER_MAX_MS = 5 * 60_000;
/** One `action.delivery_failed` per Action per this long. */
const NOTICE_INTERVAL_MS = 10_000;

/**
 * Offers an Action that just became `pending`: to its endpoint when the agent has one, after the
 * transaction commits, and to executors otherwise.
 */
export async function offerAction(
  t: Tx,
  ctx: Pick<TenantContext, "deliver">,
  action: Pick<Action, "actionId" | "agentId">,
): Promise<void> {
  if (await t.getEndpoint(action.agentId))
    t.afterCommit(() => void ctx.deliver(action.actionId));
  else t.signalWork();
}

type Started =
  | { kind: "none" }
  | { kind: "busy" }
  | { kind: "deliver"; action: Action; endpoint: EndpointRow; sandbox: boolean };

/** Delivers one Action (`WorkerHandlers.deliver`). Throws only on infrastructure errors. */
export async function deliverAction(
  ctx: TenantContext,
  actionId: string,
  signal: AbortSignal,
): Promise<DeliverResult> {
  const started = await ctx.store.tx(async (t): Promise<Started> => {
    const found = await t.get<Action>("actions", actionId);
    if (!found) return { kind: "none" };
    const s = await t.lockSession<Session>(found.sessionId);
    // Read again under the session lock.
    const action = await t.get<Action>("actions", actionId);
    if (!action || !s) return { kind: "none" };
    if (action.status === "delivering") {
      // In flight elsewhere, or answered with 202: its deadline settles it. Past the deadline
      // (a Worker died mid-delivery), it is lost now.
      if (Date.parse(action.deadlineAt ?? "") > Date.now()) return { kind: "none" };
      await loseAction(t, ctx, s, action, { redeliver: "after-commit" });
      return { kind: "none" };
    }
    if (
      action.status !== "pending" ||
      s.status === "cancelled" ||
      s.activeTurnId !== action.turnId
    )
      return { kind: "none" };
    const endpoint = await t.getEndpoint(action.agentId);
    // No endpoint: it waits, for an executor or for the next registration.
    if (!endpoint) return { kind: "none" };
    if ((await t.deliveringCount(action.agentId)) >= endpoint.maxConcurrent)
      return { kind: "busy" };
    action.status = "delivering";
    action.generation += 1;
    action.claimId = null;
    action.leaseExpiresAt = null;
    action.deadlineAt = new Date(
      Date.now() + endpoint.timeoutMs + DEADLINE_GRACE_MS,
    ).toISOString();
    await t.put("actions", actionId, action);
    await t.event(s.id, s.activeTurnId, "action.delivered", {
      actionId,
      generation: action.generation,
      ...(action.agent ? { agent: action.agent } : {}),
    });
    return {
      kind: "deliver",
      action: structuredClone(action),
      endpoint,
      sandbox: sessionHasSandbox(s, await sandboxLookup(t, s.sandboxOwnerId)),
    };
  });
  if (started.kind === "none") return DONE;
  if (started.kind === "busy") return { status: "retry", retryAfterMs: BUSY_RETRY_MS };

  const { action, endpoint } = started;
  const body = JSON.stringify({ type: "action", action, sandbox: started.sandbox });
  const minted = await mintDeliveryToken(ctx, {
    for: {
      kind: "action",
      actionId,
      agentId: action.agentId,
      generation: action.generation,
    },
    audience: endpoint.url,
    body,
    ttlSeconds: Math.ceil(endpoint.timeoutMs / 1000) + TOKEN_SLACK_SECONDS,
  });
  const cancel = new AbortController();
  const inFlight = track(ctx, action.sessionId, cancel);
  let result: OutboundResult;
  try {
    result = await post(
      endpoint.url,
      body,
      {
        [SIGNATURE_HEADER]: minted.token,
        [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
        "idempotency-key": actionId,
      },
      {
        policy: ctx.config.delivery ?? {},
        signal: AbortSignal.any([signal, cancel.signal, AbortSignal.timeout(endpoint.timeoutMs)]),
      },
    );
  } finally {
    inFlight();
  }
  // A cancel already made the Action `uncertain`; a Worker that stops leaves it to its deadline.
  if (cancel.signal.aborted || signal.aborted) return DONE;
  return settle(ctx, action, endpoint, result);
}

/** Registers a delivery under its session for `abortLocal`; the returned function removes it. */
function track(ctx: TenantContext, sessionId: string, controller: AbortController): () => void {
  let set = ctx.work.deliveries.get(sessionId);
  if (!set) ctx.work.deliveries.set(sessionId, (set = new Set()));
  set.add(controller);
  return () => {
    set!.delete(controller);
    if (set!.size === 0 && ctx.work.deliveries.get(sessionId) === set)
      ctx.work.deliveries.delete(sessionId);
  };
}

type Settlement =
  | { kind: "outcome"; outcome: ActionOutcome }
  | { kind: "accepted" }
  | { kind: "retry"; code: string; message: string; retryAfterMs?: number }
  | { kind: "lost"; code: string; message: string };

/** What an endpoint's answer means for the Action (design §5.2, §5.3). */
export function interpret(action: Action, result: OutboundResult): Settlement {
  if (result.kind === "not_sent")
    return { kind: "retry", code: "endpoint.unreachable", message: result.message };
  if (result.kind === "lost")
    return { kind: "lost", code: "endpoint.no-answer", message: result.message };
  if (result.kind === "too_large")
    return rejected("endpoint.answer-too-large", "The endpoint's answer was too large");
  const { status, headers, body } = result;
  if (status === 202) return { kind: "accepted" };
  if (status === 429 || status === 503)
    return {
      kind: "retry",
      code: status === 429 ? "endpoint.busy" : "endpoint.unavailable",
      message: messageOf(body) ?? `The endpoint answered ${status}`,
      ...retryAfter(headers["retry-after"]),
    };
  if (status === 409)
    return {
      kind: "retry",
      code: "endpoint.version-mismatch",
      message: messageOf(body) ?? "The endpoint serves another version of the definition",
    };
  if (status >= 500)
    return { kind: "lost", code: "endpoint.failed", message: messageOf(body) ?? `The endpoint answered ${status}` };
  if (status !== 200)
    return rejected("endpoint.rejected", messageOf(body) ?? `The endpoint answered ${status}`);
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    return rejected("endpoint.invalid-answer", "The endpoint's answer is not JSON");
  }
  if (headers[OUTCOME_HEADER.toLowerCase()] === "1") {
    const parsed = ActionOutcomeSchema.safeParse(value);
    return parsed.success
      ? { kind: "outcome", outcome: parsed.data }
      : rejected("endpoint.invalid-answer", "The endpoint's answer is not an Action outcome");
  }
  // A plain answer: a tool's output, or what an `fn` or `verify` returned.
  if (action.kind === "tool")
    return { kind: "outcome", outcome: { value: { kind: "completed", output: value } } };
  if (action.kind === "fn" || action.kind === "verify")
    return { kind: "outcome", outcome: { value } };
  return rejected(
    "endpoint.invalid-answer",
    `A ${action.kind} needs a tagged answer (${OUTCOME_HEADER}: 1)`,
  );
}

function rejected(code: string, message: string): Settlement {
  return { kind: "outcome", outcome: { value: { kind: "failed", code, message } } };
}

function messageOf(body: Buffer): string | undefined {
  try {
    const parsed = JSON.parse(body.toString("utf8")) as { message?: unknown };
    return typeof parsed.message === "string" ? parsed.message : undefined;
  } catch {
    const text = body.toString("utf8").trim();
    return text ? text.slice(0, 500) : undefined;
  }
}

function retryAfter(header: string | string[] | undefined): { retryAfterMs?: number } {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return {};
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? { retryAfterMs: Math.min(ms, RETRY_AFTER_MAX_MS) } : {};
}

/** Records the answer, in a transaction that still finds the Action at this delivery. */
async function settle(
  ctx: TenantContext,
  delivered: Action,
  endpoint: EndpointRow,
  result: OutboundResult,
): Promise<DeliverResult> {
  const settlement = interpret(delivered, result);
  const at = new Date().toISOString();
  return ctx.store.tx(async (t) => {
    const s = await t.lockSession<Session>(delivered.sessionId);
    const action = await t.get<Action>("actions", delivered.actionId);
    // A cancel, a deadline or another delivery settled it first.
    if (
      !s ||
      !action ||
      action.status !== "delivering" ||
      action.generation !== delivered.generation
    )
      return DONE;
    switch (settlement.kind) {
      case "outcome": {
        await t.recordEndpointHealth(endpoint.agentId, { kind: "success", at });
        if (s.status === "cancelled" || s.activeTurnId !== action.turnId) return DONE;
        await recordActionOutcome(t, ctx, s, action, settlement.outcome);
        await t.put("sessions", s.id, s);
        return DONE;
      }
      case "accepted": {
        // The endpoint answers later (`POST /v1/actions/:id/result`) and heartbeats meanwhile.
        await t.recordEndpointHealth(endpoint.agentId, { kind: "success", at });
        action.deadlineAt = new Date(Date.now() + (ctx.config.leaseMs ?? 30_000)).toISOString();
        await t.put("actions", action.actionId, action);
        return DONE;
      }
      case "retry": {
        await t.recordEndpointHealth(endpoint.agentId, {
          kind: "failure",
          at,
          code: settlement.code,
          message: settlement.message,
        });
        action.status = "pending";
        action.deadlineAt = null;
        await t.put("actions", action.actionId, action);
        const retryAfterMs = settlement.retryAfterMs ?? (await backoff(t, endpoint.agentId));
        await notice(t, ctx, s, action, settlement, retryAfterMs);
        return { status: "retry", retryAfterMs };
      }
      case "lost": {
        await t.recordEndpointHealth(endpoint.agentId, {
          kind: "failure",
          at,
          code: settlement.code,
          message: settlement.message,
        });
        const again = await loseAction(t, ctx, s, action, { redeliver: "retry" });
        if (!again) return DONE;
        const retryAfterMs = await backoff(t, endpoint.agentId);
        await notice(t, ctx, s, action, settlement, retryAfterMs);
        return { status: "retry", retryAfterMs };
      }
    }
  });
}

/** Backoff from the endpoint's consecutive failures: 250 ms doubling to 30 s. */
async function backoff(t: Tx, agentId: string): Promise<number> {
  const failures = (await t.getEndpoint(agentId))?.consecutiveFailures ?? 1;
  return Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.max(0, Math.min(failures - 1, 16)));
}

/** `action.delivery_failed`, at most once per Action per `NOTICE_INTERVAL_MS` on this process. */
async function notice(
  t: Tx,
  ctx: TenantContext,
  s: Session,
  action: Action,
  settlement: { code: string; message: string },
  retryInMs: number,
): Promise<void> {
  const last = ctx.work.deliveryNotices.get(action.actionId) ?? 0;
  if (Date.now() - last < NOTICE_INTERVAL_MS) return;
  ctx.work.deliveryNotices.set(action.actionId, Date.now());
  if (s.status === "cancelled" || s.activeTurnId !== action.turnId) return;
  await t.event(s.id, s.activeTurnId, "action.delivery_failed", {
    actionId: action.actionId,
    generation: action.generation,
    reason: settlement.code,
    message: settlement.message,
    retryInMs,
  });
}

/**
 * A delivery that may have reached the endpoint got no answer. A tool becomes `uncertain`, with
 * its effect and its session, as a lost executor claim does (`sweep.ts` `expireClaims`). A hook,
 * `fn` or `verify` is pure or repeat-safe and goes back to `pending`: delivered again right away
 * (`after-commit`) or by the caller's retry (`retry`). Returns true when it will be delivered again.
 */
export async function loseAction(
  t: Tx,
  ctx: Pick<TenantContext, "deliver">,
  s: Session,
  action: Action,
  options: { redeliver: "after-commit" | "retry" },
): Promise<boolean> {
  if (action.kind === "hook" || action.kind === "fn" || action.kind === "verify") {
    action.status = "pending";
    action.deadlineAt = null;
    await t.put("actions", action.actionId, action);
    if (options.redeliver === "after-commit")
      t.afterCommit(() => void ctx.deliver(action.actionId));
    return options.redeliver === "retry";
  }
  action.status = "uncertain";
  action.deadlineAt = null;
  await t.put("actions", action.actionId, action);
  const effect = await t.get("effects", action.actionId);
  if (effect) {
    effect.status = "uncertain";
    await t.put("effects", action.actionId, effect);
  }
  if (s.status !== "cancelled" && s.activeTurnId === action.turnId) {
    s.status = "uncertain";
    await t.put("sessions", s.id, s);
    await t.event(s.id, s.activeTurnId, "action.uncertain", {
      actionId: action.actionId,
      ...(action.agent ? { agent: action.agent } : {}),
    });
  }
  return false;
}

/**
 * The sweep's part (design §7): deliveries whose deadline passed without an answer are lost,
 * and pending Actions of agents with an endpoint are sent again, in case a send was lost
 * between a commit and the execution. Returns how many deliveries it settled.
 */
export async function sweepDeliveries(ctx: TenantContext, now = new Date()): Promise<number> {
  let settled = 0;
  for (const expired of await ctx.store.tx((t) => t.expiredDeliveries(now, 100))) {
    const changed = await ctx.store.tx(async (t) => {
      const s = await t.lockSession<Session>(expired.sessionId);
      const action = await t.get<Action>("actions", expired.actionId);
      if (
        !s ||
        !action ||
        action.status !== "delivering" ||
        Date.parse(action.deadlineAt ?? "") > now.getTime()
      )
        return false;
      await loseAction(t, ctx, s, action, { redeliver: "after-commit" });
      return true;
    });
    if (changed) settled += 1;
  }
  for (const pending of await ctx.store.tx((t) => t.pendingActionsWithEndpoint(100)))
    await ctx.deliver(pending.actionId);
  return settled;
}

/**
 * `POST /v1/endpoints/:agentId/ping`: a signed ping through the endpoint, so a wrong URL, a
 * tunnel that is down or a handler serving other definitions shows up before the first turn.
 */
export async function pingEndpoint(
  ctx: TenantContext,
  agentId: string,
): Promise<EndpointPingResponse> {
  const endpoint =
    (await ctx.store.tx((t) => t.getEndpoint(agentId))) ?? fail(404, "Endpoint not found");
  const body = JSON.stringify({
    type: "ping",
    agentId,
    ...(endpoint.manifestHash === undefined ? {} : { manifestHash: endpoint.manifestHash }),
  });
  const minted = await mintDeliveryToken(ctx, {
    for: { kind: "ping", agentId },
    audience: endpoint.url,
    body,
    ttlSeconds: TOKEN_SLACK_SECONDS,
  });
  const result = await post(
    endpoint.url,
    body,
    { [SIGNATURE_HEADER]: minted.token, [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) },
    {
      policy: ctx.config.delivery ?? {},
      signal: AbortSignal.timeout(Math.min(endpoint.timeoutMs, 10_000)),
    },
  );
  const at = new Date().toISOString();
  const refuse = async (code: string, message: string): Promise<never> => {
    await ctx.store.tx((t) =>
      t.recordEndpointHealth(agentId, { kind: "failure", at, code, message }),
    );
    return fail(502, `The endpoint did not answer the ping: ${message}`);
  };
  if (result.kind !== "response")
    return refuse(
      "endpoint.unreachable",
      result.kind === "too_large" ? "The answer was too large" : result.message,
    );
  if (result.status !== 200)
    return refuse("endpoint.rejected", messageOf(result.body) ?? `The endpoint answered ${result.status}`);
  let answer: EndpointPingResponse;
  try {
    answer = EndpointPingResponseSchema.parse(JSON.parse(result.body.toString("utf8")));
  } catch {
    return refuse("endpoint.invalid-answer", "The endpoint's answer is not a ping answer");
  }
  if (answer.agentId !== agentId)
    return refuse("endpoint.invalid-answer", `The endpoint answered for '${answer.agentId}'`);
  await ctx.store.tx(async (t) => {
    await t.recordEndpointHealth(agentId, { kind: "success", at });
    await t.recordEndpointHealth(agentId, {
      kind: "served",
      implementationVersion: answer.implementationVersion,
      ...(answer.manifestHash === undefined ? {} : { manifestHash: answer.manifestHash }),
    });
  });
  return answer;
}
