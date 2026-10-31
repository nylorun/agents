/**
 * A2A push notifications (profile v2 §3, Host feature `a2a-profile-v2`): a caller registers a
 * config for a task (inside `SendMessage`, or with `CreateTaskPushNotificationConfig`), and every
 * update of that task is POSTed to its URL, at least once, signed with Standard Webhooks.
 *
 * - **Configs** (`a2a_push_configs`) are stored per session, task and config id. Each reads the
 *   session's events from its own `nextSeq` on and follows one turn (`turnId`); a queued
 *   message's config follows its message until a turn takes it (`command.message` names it).
 * - **The translator** (`updatesOf` in `tasks.ts`, the one mapping from events to A2A updates)
 *   turns each event of the turn into `statusUpdate`s and `artifactUpdate`s. The pump writes each
 *   one as an outbox row of kind `push` and moves the config on, in one transaction under the
 *   configs' row locks, so an update is written once even when two processes pump the session.
 *   It runs when a commit on this process touches a session with a config, and at every Tenant
 *   sweep for every such session (`pumpPushes`), which covers commits made elsewhere.
 * - **Delivery** (`deliverPush`): the store hands a committed push row to the Tenant's `send`
 *   at once; one that fails is the sweep's, retried with backoff (Host tuning `a2a.pushRetry`)
 *   until it is `a2a.pushMaxAgeMs` (24 hours) old, then dropped: the change feed covers it. The
 *   body is one A2A `StreamResponse`; the headers are `Content-Type: application/json`,
 *   `X-A2A-Notification-Token` (the config's token), `Authorization` (its `authentication`),
 *   and Standard Webhooks' `webhook-id` (the row id, the same on every attempt),
 *   `webhook-timestamp` (unix seconds) and `webhook-signature` (`v1,<base64 HMAC-SHA256>` with
 *   the installation's `whsec_` secret, Runtime config `a2a.push.secret`, over
 *   `<id>.<timestamp>.<body>`).
 * - **Where pushes go**: through `guardedFetch` under the Host's delivery policy, except that a
 *   private, loopback or link-local address is refused unless its `host:port` (or `host:*`, any
 *   port) is in Runtime config `a2a.push.allowHosts`. File `url` parts the Runtime fetches follow the same rule.
 */
import type { LiveEvent } from "@nylorun/core/contracts";
import { signWebhook, webhookKeyOf } from "../../keys/webhooks.js";
import type { A2aPushConfigRow, OutboxPush, Tx } from "../../store/types.js";
import type { TenantContext } from "../../tenant/context.js";
import { guardedFetch, OutboundRefused, refusal, type OutboundPolicy } from "../../tenant/outbound.js";
import { traceKey } from "../../traces/key.js";
import { traceIdOf } from "../../traces/ids.js";
import { hostTuning } from "../../tuning.js";
import { ALL_EXTENSIONS, keepExtensions } from "./extensions.js";
import {
  a2aFail,
  type PushAuthentication,
  type PushConfigInput,
  type TaskPushNotificationConfig,
} from "./protocol.js";
import { ENDED, callerTraceId, updatesOf } from "./tasks.js";

/** The most push configs one task keeps. A constant of the profile, not a setting. */
export const MAX_PUSH_CONFIGS = 10;
/** Events one pump reads at a time. */
const PUMP_BATCH = 500;
/** Sessions one sweep pass pumps. */
const SWEEP_SESSIONS = 500;
/** The most of a receiver's answer read: it is not used. */
const ANSWER_BYTES = 64 * 1024;

/** Whether this Runtime serves push notifications: it has a secret to sign them with. */
export function pushEnabled(ctx: Pick<TenantContext, "config">): boolean {
  return ctx.config.a2a?.push?.secret !== undefined;
}

/** `host:port` of `url`, the way `a2a.push.allowHosts` names it. */
function hostPort(url: URL): string {
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return `${url.hostname.toLowerCase()}:${port}`;
}

/**
 * The address policy a push, or a fetched file `url` part, is sent under: the Host's delivery
 * policy, with private addresses refused unless `url`'s `host:port` is in `a2a.push.allowHosts`.
 */
export function pushPolicy(ctx: Pick<TenantContext, "config">, target: string): OutboundPolicy {
  const url = new URL(target);
  const hosts = ctx.config.a2a?.push?.allowHosts ?? [];
  const allowed = hosts.includes(hostPort(url)) || hosts.includes(`${url.hostname.toLowerCase()}:*`);
  return { ...(ctx.config.delivery ?? {}), privateAddresses: allowed ? "allow" : "refuse" };
}

/** Why the Runtime will not send to `target`, checked before a config is stored; else undefined. */
export function pushRefusal(ctx: Pick<TenantContext, "config">, target: string): string | undefined {
  return refusal(new URL(target), pushPolicy(ctx, target));
}

/** A config as A2A answers it. */
export function configView(row: A2aPushConfigRow): TaskPushNotificationConfig {
  return {
    id: row.configId,
    taskId: row.taskId,
    url: row.url,
    ...(row.token ? { token: row.token } : {}),
    ...(row.authentication ? { authentication: row.authentication as PushAuthentication } : {}),
  };
}

/** Where a config starts: the turn it follows and the first event it reads. */
export interface PushStart {
  readonly sessionId: string;
  readonly contextId: string;
  readonly taskId: string;
  /** The turn, or a queued message's id until a turn takes it. */
  readonly turnId: string;
  readonly nextSeq: number;
  readonly traceId?: string;
  /** The task already ended: the config is stored, and nothing is pushed. */
  readonly done?: boolean;
  readonly baseUrl: string;
  /** The extensions the caller activated; none named means all of them. */
  readonly extensions: ReadonlySet<string>;
}

/**
 * Stores `config` for a task (replacing one with its id), in `t`; the pump sends its updates.
 * A URL the Runtime will not call is `InvalidParamsError`; past `MAX_PUSH_CONFIGS` too.
 */
export async function savePushConfig(
  ctx: Pick<TenantContext, "config">,
  t: Tx,
  start: PushStart,
  config: PushConfigInput,
  configId: string
): Promise<TaskPushNotificationConfig> {
  if (!pushEnabled(ctx))
    a2aFail("pushNotSupported", "Push notifications are not configured on this Runtime (a2a.push.secret)");
  const refused = pushRefusal(ctx, config.url);
  if (refused) a2aFail("invalidParams", `The push URL is refused: ${refused}`, {}, "url");
  const existing = await t.pushConfigs(start.sessionId, start.taskId);
  if (existing.length >= MAX_PUSH_CONFIGS && !existing.some((row) => row.configId === configId))
    a2aFail("invalidParams", `A task keeps at most ${MAX_PUSH_CONFIGS} push configs`, {}, "id");
  const row = {
    sessionId: start.sessionId,
    taskId: start.taskId,
    configId,
    contextId: start.contextId,
    turnId: start.turnId,
    url: config.url,
    token: config.token ?? null,
    authentication: config.authentication ?? null,
    baseUrl: start.baseUrl,
    extensions: [...(start.extensions.size === 0 ? ALL_EXTENSIONS : start.extensions)],
    traceId: start.traceId ?? null,
    nextSeq: start.nextSeq,
    doneAt: start.done ? new Date() : null,
  };
  await t.putPushConfig(row);
  return configView({ ...row, createdAt: new Date(), doneAt: row.doneAt });
}

// ---------------------------------------------------------------------------
// The pump

interface PumpState {
  /** Sessions with a config still following its task, as last read. */
  active: Set<string>;
  pumping: Map<string, Promise<void>>;
  again: Set<string>;
  listening: boolean;
}

const states = new WeakMap<TenantContext, PumpState>();

function stateOf(ctx: TenantContext): PumpState {
  let state = states.get(ctx);
  if (!state) {
    state = { active: new Set(), pumping: new Map(), again: new Set(), listening: false };
    states.set(ctx, state);
  }
  return state;
}

/**
 * Pumps session `sessionId` on this process: at once, or again after the pump running now, so
 * one process never pumps a session twice at the same time. Never rejects.
 */
export function kickPushes(ctx: TenantContext, sessionId: string): Promise<void> {
  const state = stateOf(ctx);
  listen(ctx, state);
  state.active.add(sessionId);
  const running = state.pumping.get(sessionId);
  if (running) {
    state.again.add(sessionId);
    return running;
  }
  const run = (async () => {
    do {
      state.again.delete(sessionId);
      if (ctx.closing || ctx.closed) return;
      try {
        await pumpSession(ctx, sessionId);
      } catch (error) {
        ctx.config.logger.warn("a2a push pump failed; the sweep tries again", {
          sessionId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } while (state.again.has(sessionId));
  })().finally(() => state.pumping.delete(sessionId));
  state.pumping.set(sessionId, run);
  return run;
}

/** A commit on this process that wrote events of a session with a config pumps it. */
function listen(ctx: TenantContext, state: PumpState): void {
  if (state.listening) return;
  state.listening = true;
  ctx.store.onCommit(({ events }) => {
    const sessions = new Set(events.map((event) => event.sessionId));
    for (const sessionId of sessions) if (state.active.has(sessionId)) void kickPushes(ctx, sessionId);
  });
}

/**
 * Translates the events of session `sessionId` its configs have not read into push rows: reads
 * the record from the lowest `nextSeq`, then, under the configs' locks, writes each config's
 * updates and moves it on. A config stored behind what was read waits for the next pump.
 */
export async function pumpSession(ctx: TenantContext, sessionId: string): Promise<void> {
  for (;;) {
    const configs = await ctx.store.tx((t) => t.activePushConfigs(sessionId));
    if (configs.length === 0) {
      stateOf(ctx).active.delete(sessionId);
      return;
    }
    const from = Math.min(...configs.map((config) => config.nextSeq));
    const rows = await ctx.store.record().readRange(ctx.store.tenantId, sessionId, from, from + PUMP_BATCH);
    if (rows.length === 0) {
      // A deleted session's configs follow nothing any more.
      await ctx.store.tx(async (t) => {
        if (await t.get("sessions", sessionId)) return;
        for (const config of configs) await t.deletePushConfig(sessionId, config.taskId, config.configId);
      });
      return;
    }
    const events = rows.map((row) => row.body as LiveEvent);
    const key = configs.some((config) => config.traceId === null) ? await traceKey(ctx.store) : undefined;
    await ctx.store.tx(async (t) => {
      for (const config of await t.activePushConfigs(sessionId, { lock: true })) {
        if (config.nextSeq < from) continue;
        let { turnId, traceId } = config;
        let next = config.nextSeq;
        let done = false;
        for (const event of events) {
          if (event.seq < config.nextSeq) continue;
          next = event.seq + 1;
          const payload = (event.payload ?? {}) as { queuedMessageId?: unknown };
          // A queued message's task follows the turn that takes it.
          if (event.type === "command.message" && event.turnId && payload.queuedMessageId === turnId)
            turnId = event.turnId;
          if (event.turnId !== turnId) continue;
          if (event.type === "command.message" && traceId === null)
            traceId =
              callerTraceId([event]) ??
              (key ? traceIdOf(key, ctx.store.tenantId, sessionId, turnId) : null);
          const view = {
            contextId: config.contextId,
            taskId: config.taskId,
            baseUrl: config.baseUrl,
            ...(traceId ? { traceId } : {}),
          };
          const active = new Set(config.extensions as string[]);
          for (const update of updatesOf(event, view))
            await t.enqueuePush({
              sessionId,
              taskId: config.taskId,
              configId: config.configId,
              body: JSON.stringify(keepExtensions(update, active)),
            });
          if (ENDED.has(event.type)) {
            done = true;
            break;
          }
        }
        if (next !== config.nextSeq || done || turnId !== config.turnId || traceId !== config.traceId)
          await t.advancePushConfig(
            { sessionId, taskId: config.taskId, configId: config.configId },
            { turnId, nextSeq: next, traceId, done }
          );
      }
    });
    if (rows.length < PUMP_BATCH) return;
  }
}

/**
 * The Tenant sweep's push step: pumps every session with a config still following its task
 * (commits on other processes reach them here), and deletes configs done longer than the Host
 * tuning's `a2a.pushConfigRetentionMs`.
 */
export async function pumpPushes(ctx: TenantContext): Promise<void> {
  const state = stateOf(ctx);
  listen(ctx, state);
  const sessions = await ctx.store.tx((t) => t.pushSessions(SWEEP_SESSIONS));
  state.active = new Set([...sessions, ...state.pumping.keys()]);
  for (const sessionId of sessions) {
    if (ctx.closing || ctx.closed) return;
    await kickPushes(ctx, sessionId);
  }
  const before = new Date(Date.now() - hostTuning().a2a.pushConfigRetentionMs);
  await ctx.store.tx((t) => t.prunePushConfigs(before));
}

// ---------------------------------------------------------------------------
// Delivery

/** A push the receiver did not take: the sweep sends it again. */
export class PushFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushFailed";
  }
}

/** The headers of one push attempt: Standard Webhooks, the config's token and authentication. */
export function pushHeaders(
  secret: string,
  push: Pick<OutboxPush, "id" | "body">,
  config: { token?: string | null; authentication?: unknown },
  now = Date.now()
): Record<string, string> {
  const timestamp = String(Math.floor(now / 1000));
  const key = webhookKeyOf(secret);
  try {
    const signature = signWebhook(key, push.id, timestamp, Buffer.from(push.body, "utf8"));
    const authentication = config.authentication as PushAuthentication | null | undefined;
    return {
      "content-type": "application/json",
      "webhook-id": push.id,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`,
      ...(config.token ? { "x-a2a-notification-token": config.token } : {}),
      ...(authentication ? { authorization: `${authentication.scheme} ${authentication.credentials}` } : {}),
    };
  } finally {
    key.fill(0);
  }
}

/**
 * Sends one push row (the Tenant's `send` for outbox kind `push`). Resolves `true` once it is
 * done with: delivered (2xx), its config deleted, the receiver gone (`410`), or its URL refused
 * by policy. Rejects with `PushFailed` (or the network's error) when it should be sent again.
 */
export async function deliverPush(ctx: TenantContext, push: OutboxPush): Promise<boolean> {
  if (ctx.closing || ctx.closed) return false;
  const secret = ctx.config.a2a?.push?.secret;
  if (secret === undefined) throw new PushFailed("Push notifications are not configured (a2a.push.secret)");
  const config = await ctx.store.tx((t) => t.pushConfig(push.sessionId, push.taskId, push.configId));
  if (!config) return true;
  const send = guardedFetch(pushPolicy(ctx, config.url), {
    maxResponseBytes: ANSWER_BYTES,
    timeoutMs: hostTuning().a2a.pushTimeoutMs,
  });
  let status: number;
  try {
    const response = await send(config.url, {
      method: "POST",
      headers: pushHeaders(secret, push, config),
      body: push.body,
    });
    status = response.status;
  } catch (error) {
    if (error instanceof OutboundRefused) {
      ctx.config.logger.warn("a2a push dropped: its URL is refused", {
        sessionId: push.sessionId,
        taskId: push.taskId,
        message: error.message,
      });
      return true;
    }
    throw error;
  }
  if ((status >= 200 && status < 300) || status === 410) return true;
  throw new PushFailed(`The push receiver answered ${status}`);
}

/**
 * What the sweep does with a push that failed `attempts` times and was written at `createdAt`:
 * try again after the backoff, or drop it once it would be past `a2a.pushMaxAgeMs`.
 */
export function pushRetry(attempts: number, createdAt: string, now = Date.now()): { retryInMs: number } | "drop" {
  const { pushRetry: backoff, pushMaxAgeMs } = hostTuning().a2a;
  const retryInMs = Math.min(backoff.minMs * 2 ** Math.max(0, attempts - 1), backoff.maxMs);
  return now + retryInMs - Date.parse(createdAt) > pushMaxAgeMs ? "drop" : { retryInMs };
}
