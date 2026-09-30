/**
 * Durable Session Execution on Restate (architecture §12.3).
 *
 * The only module that imports the Restate SDK. It serves four virtual
 * objects on the Worker endpoint, all named with `servicePrefix`:
 *
 * - `<prefix>NylorunSession`, key `<tenantId>:<sessionId>`. Its exclusive
 *   `advance` handler calls `WorkerHandlers.advance`. It makes no `ctx.run`,
 *   keeps no state and uses no awakeables: the only journal entry it can write
 *   is the delayed self-send after a `busy` result. Restate's one invocation
 *   per key at a time is the "one advance per key" guarantee.
 * - `<prefix>NylorunTenant`, key `<tenantId>`. `arm`, `sweep` and `disarm`
 *   keep one self-re-arming sweep chain per Tenant. The chain's generation is
 *   kept in the object's state, so arming is idempotent and a disarmed or
 *   replaced chain dies at its next link. The state is rebuildable: Workers
 *   re-arm every Tenant at startup (§14.8).
 * - `<prefix>NylorunTimer`, key `<tenantId>:<timer key>`. `set` records the
 *   latest time and sends a delayed `fire`; a `fire` for an older time is a
 *   no-op, which is how setting a key again replaces it.
 * - `<prefix>NylorunAction`, key `<tenantId>:<actionId>`. Its exclusive
 *   `deliver` handler calls `WorkerHandlers.deliver`. Like `advance`, it keeps
 *   no state and makes no `ctx.run`: its only journal entry is the delayed
 *   self-send after a `retry` result, so an endpoint that is down never spends
 *   the retry budget, which is for infrastructure errors.
 *
 * Wakes, deliveries, timers and sweep arming go through the ingress as one-way
 * sends, so an API node can call them without ever calling `start`.
 */
import { createServer, type Http2Server, type ServerHttp2Session } from "node:http2";
import * as restate from "@restatedev/restate-sdk";
import {
  WAKE_REASONS,
  parseSessionKey,
  sessionKey,
  type AdvanceResult,
  type DeliverResult,
  type DurableExecution,
  type StuckInvocation,
  type Wake,
  type WakeReason,
  type WorkerHandlers,
} from "../../execution/types.js";

const HOUR_MS = 60 * 60 * 1000;

export interface RestateTimeouts {
  /**
   * How long an invocation may run without journal progress before Restate
   * asks it to suspend. An advance makes no journal entries while it runs, so
   * this must exceed the longest segment. Default one hour.
   */
  inactivityMs?: number;
  /** How long after the inactivity timeout Restate aborts the attempt. Default one hour. */
  abortMs?: number;
}

/**
 * Retries of a handler that throws (an infrastructure error). After
 * `maxAttempts` the invocation is paused, never killed, and shows up in
 * `listStuckInvocations` until an operator resumes it.
 */
export interface RestateRetry {
  /** Default 100. */
  initialIntervalMs?: number;
  /** Default 30000. */
  maxIntervalMs?: number;
  /** Default 2. */
  exponentiationFactor?: number;
  /** Attempts, including the first, before pausing. Default 70. */
  maxAttempts?: number;
}

export interface RestateExecutionOptions {
  /** Restate ingress, e.g. `http://restate:8080`. */
  ingressUrl: string;
  /** Restate admin API, e.g. `http://restate:9070`. Needed by `start`. */
  adminUrl: string;
  /** Where `start` serves the Worker endpoint (HTTP/2 cleartext). */
  workerListen?: { host: string; port: number };
  /** The endpoint URL Restate calls, registered by `start`. */
  workerAdvertisedUrl?: string;
  /**
   * Prepended to every service name, so several Runtimes (or test runs) can
   * share one Restate server without taking each other's invocations.
   * Letters, digits and `_` only. Default "".
   */
  servicePrefix?: string;
  /**
   * Request identity public keys (`publickeyv1_...`). When given, the Worker
   * endpoint accepts only requests signed by a Restate server holding the
   * matching private key.
   */
  identityKeys?: string[];
  timeouts?: RestateTimeouts;
  retry?: RestateRetry;
  /** Delay between sweep passes of one Tenant. Default 5000. */
  sweepIntervalMs?: number;
  /**
   * How long wakes with a `dedupeKey` are remembered. Default and minimum
   * 24 hours (§12.3).
   */
  dedupeRetentionMs?: number;
  /**
   * Overwrite a deployment already registered at `workerAdvertisedUrl`, so a
   * restarted Worker with changed code takes effect. Default true, which suits
   * a stable URL on a developer machine. Rolling upgrades should advertise a
   * versioned URL instead (§14.6).
   */
  forceRegistration?: boolean;
  /** How long `start` keeps retrying registration while Restate comes up. Default 60000. */
  registrationTimeoutMs?: number;
  /** Replaces the SDK's console logging. */
  logger?: (level: string, message: string) => void;
}

/** A Restate invocation that needs an operator: paused, or retrying after failures. */
export type { StuckInvocation };

interface WakeInput {
  reason?: WakeReason;
}
interface SweepInput {
  generation: number;
}
interface SweepState {
  generation: number;
  /** When the chain last scheduled its next link (Restate's clock). */
  beatAt: number;
}
interface TimerInput {
  at: number;
}
type DeliverInput = Record<string, never>;

export function createRestateExecution(
  options: RestateExecutionOptions,
): RestateExecution {
  return new RestateExecution(options);
}

export class RestateExecution implements DurableExecution {
  private handlers?: WorkerHandlers;
  private stopping = false;
  private server?: Http2Server;
  private readonly sessions = new Set<ServerHttp2Session>();
  private readonly controllers = new Set<AbortController>();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly names: {
    session: string;
    tenant: string;
    timer: string;
    action: string;
  };
  private readonly ingressUrl: string;
  private readonly adminUrl: string;
  private readonly sweepIntervalMs: number;

  constructor(private readonly options: RestateExecutionOptions) {
    const prefix = options.servicePrefix ?? "";
    if (!/^[A-Za-z0-9_]*$/.test(prefix))
      throw new Error(`Invalid Restate service prefix: ${prefix}`);
    this.names = {
      session: `${prefix}NylorunSession`,
      tenant: `${prefix}NylorunTenant`,
      timer: `${prefix}NylorunTimer`,
      action: `${prefix}NylorunAction`,
    };
    this.ingressUrl = options.ingressUrl.replace(/\/+$/, "");
    this.adminUrl = options.adminUrl.replace(/\/+$/, "");
    this.sweepIntervalMs = options.sweepIntervalMs ?? 5000;
  }

  /** Service names this execution registers, for diagnostics and tests. */
  get serviceNames(): {
    session: string;
    tenant: string;
    timer: string;
    action: string;
  } {
    return { ...this.names };
  }

  async wake(tenantId: string, sessionId: string, wake: Wake): Promise<void> {
    if (!WAKE_REASONS.includes(wake.reason))
      throw new Error(`Unknown wake reason: ${String(wake.reason)}`);
    await this.send(
      this.names.session,
      sessionKey(tenantId, sessionId),
      "advance",
      { reason: wake.reason } satisfies WakeInput,
      wake.dedupeKey,
    );
  }

  async deliver(tenantId: string, actionId: string): Promise<void> {
    await this.send(
      this.names.action,
      sessionKey(tenantId, actionId),
      "deliver",
      {} satisfies DeliverInput,
    );
  }

  async timer(tenantId: string, key: string, at: Date): Promise<void> {
    await this.send(this.names.timer, sessionKey(tenantId, key), "set", {
      at: at.getTime(),
    } satisfies TimerInput);
  }

  async armSweep(tenantId: string): Promise<void> {
    await this.send(this.names.tenant, tenantKey(tenantId), "arm", {});
  }

  async disarmSweep(tenantId: string): Promise<void> {
    await this.send(this.names.tenant, tenantKey(tenantId), "disarm", {});
  }

  /**
   * Readiness: the admin API (`/health`), which `start` registers with, and the
   * ingress (`/restate/health`), which every wake, timer and sweep goes
   * through, both answer.
   */
  async probe(signal: AbortSignal): Promise<void> {
    await Promise.all(
      [`${this.adminUrl}/health`, `${this.ingressUrl}/restate/health`].map(
        async (url) => {
          const response = await fetch(url, { signal });
          await response.body?.cancel();
          if (!response.ok)
            throw new Error(`Restate health ${response.status} at ${url}`);
        },
      ),
    );
  }

  /** This Runtime's paused or backing-off invocations for `tenantId` (Tenant status). */
  stuckInvocations(tenantId: string): Promise<StuckInvocation[]> {
    return listStuckInvocations({
      adminUrl: this.adminUrl,
      servicePrefix: this.options.servicePrefix ?? "",
      tenantId,
    });
  }

  async start(handlers: WorkerHandlers): Promise<void> {
    if (this.handlers) throw new Error("DurableExecution already started");
    const { workerListen, workerAdvertisedUrl } = this.options;
    if (!workerListen || !workerAdvertisedUrl)
      throw new Error("Restate execution needs workerListen and workerAdvertisedUrl to start");
    this.handlers = handlers;
    this.stopping = false;
    const server = createServer(
      restate.createEndpointHandler({
        services: this.definitions(),
        ...(this.options.identityKeys?.length
          ? { identityKeys: this.options.identityKeys }
          : {}),
        ...(this.options.logger ? { logger: sdkLogger(this.options.logger) } : {}),
      }),
    );
    server.on("session", (session) => {
      this.sessions.add(session);
      session.once("close", () => this.sessions.delete(session));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(workerListen.port, workerListen.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    try {
      await this.register(workerAdvertisedUrl);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const controller of this.controllers)
      controller.abort(new Error("Worker stopping"));
    while (this.inflight.size > 0) await Promise.allSettled(this.inflight);
    this.handlers = undefined;
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    // Let Restate read the responses already written, then drop the
    // connections it keeps open so `close` can finish.
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const session of this.sessions) session.close();
    const timeout = setTimeout(() => {
      for (const session of this.sessions) session.destroy();
    }, 2000);
    await closed;
    clearTimeout(timeout);
  }

  private definitions() {
    const names = this.names;
    const serviceOptions = this.serviceOptions();

    const session = restate.object({
      name: names.session,
      handlers: {
        advance: async (ctx: restate.ObjectContext, _wake?: WakeInput) => {
          const { tenantId, sessionId } = parseSessionKey(ctx.key);
          const result = await this.runAborted<AdvanceResult>(
            ctx.request().attemptCompletedSignal,
            (handlers, signal) => handlers.advance(tenantId, sessionId, signal),
          );
          if (result.status === "busy")
            ctx
              .objectSendClient<SessionObject>({ name: names.session }, ctx.key)
              .advance(
                { reason: "recover" },
                restate.rpc.sendOpts({ delay: Math.max(0, result.retryAfterMs) }),
              );
        },
      },
      options: {
        ...serviceOptions,
        idempotencyRetention: Math.max(
          this.options.dedupeRetentionMs ?? 24 * HOUR_MS,
          24 * HOUR_MS,
        ),
      },
    });

    const tenant = restate.object({
      name: names.tenant,
      handlers: {
        arm: async (ctx: restate.ObjectContext) => {
          const now = await ctx.date.now();
          const state = await ctx.get<SweepState>("sweep");
          // An armed chain that beat recently is alive; a stale one was lost
          // (killed or purged invocation) and is replaced.
          if (state && now - state.beatAt < this.staleSweepMs()) return;
          const generation = (state?.generation ?? 0) + 1;
          ctx.set<SweepState>("sweep", { generation, beatAt: now });
          ctx
            .objectSendClient<TenantObject>({ name: names.tenant }, ctx.key)
            .sweep({ generation });
        },
        sweep: async (ctx: restate.ObjectContext, input: SweepInput) => {
          const state = await ctx.get<SweepState>("sweep");
          if (!state || state.generation !== input.generation) return;
          await this.runTracked((handlers) =>
            handlers.sweep(ctx.key),
          );
          ctx.set<SweepState>("sweep", {
            generation: input.generation,
            beatAt: await ctx.date.now(),
          });
          ctx
            .objectSendClient<TenantObject>({ name: names.tenant }, ctx.key)
            .sweep(
              { generation: input.generation },
              restate.rpc.sendOpts({ delay: this.sweepIntervalMs }),
            );
        },
        disarm: async (ctx: restate.ObjectContext) => {
          ctx.clear("sweep");
        },
      },
      options: serviceOptions,
    });

    const timer = restate.object({
      name: names.timer,
      handlers: {
        set: async (ctx: restate.ObjectContext, input: TimerInput) => {
          ctx.set<number>("at", input.at);
          const now = await ctx.date.now();
          ctx
            .objectSendClient<TimerObject>({ name: names.timer }, ctx.key)
            .fire(input, restate.rpc.sendOpts({ delay: Math.max(0, input.at - now) }));
        },
        fire: async (ctx: restate.ObjectContext, input: TimerInput) => {
          if ((await ctx.get<number>("at")) !== input.at) return;
          const { tenantId, sessionId: key } = parseSessionKey(ctx.key);
          await this.runTracked((handlers) => {
            if (!handlers.fire)
              throw new Error("WorkerHandlers.fire is required for timers");
            return handlers.fire(tenantId, key);
          });
          ctx.clear("at");
        },
      },
      options: serviceOptions,
    });

    const action = restate.object({
      name: names.action,
      handlers: {
        deliver: async (ctx: restate.ObjectContext, _input?: DeliverInput) => {
          const { tenantId, sessionId: actionId } = parseSessionKey(ctx.key);
          const result = await this.runAborted<DeliverResult>(
            ctx.request().attemptCompletedSignal,
            (handlers, signal) => {
              if (!handlers.deliver)
                throw new Error("WorkerHandlers.deliver is required for deliveries");
              return handlers.deliver(tenantId, actionId, signal);
            },
          );
          if (result.status === "retry")
            ctx
              .objectSendClient<ActionObject>({ name: names.action }, ctx.key)
              .deliver(
                {},
                restate.rpc.sendOpts({ delay: Math.max(0, result.retryAfterMs) }),
              );
        },
      },
      options: serviceOptions,
    });

    return [session, tenant, timer, action];
  }

  /**
   * Runs a Worker handler with a signal aborted by `stop` or by the end of the Restate
   * attempt (`advance` and `deliver`).
   */
  private async runAborted<T>(
    attemptDone: AbortSignal,
    fn: (handlers: WorkerHandlers, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const onAttemptDone = () =>
      controller.abort(new Error("Restate attempt ended"));
    if (attemptDone.aborted) onAttemptDone();
    else attemptDone.addEventListener("abort", onAttemptDone, { once: true });
    this.controllers.add(controller);
    try {
      return await this.runTracked((handlers) =>
        fn(handlers, controller.signal),
      );
    } finally {
      this.controllers.delete(controller);
      attemptDone.removeEventListener("abort", onAttemptDone);
    }
  }

  /** Runs a Worker handler so that `stop` waits for it. Refuses once stopping; Restate retries. */
  private runTracked<T>(
    fn: (handlers: WorkerHandlers) => Promise<T>,
  ): Promise<T> {
    const handlers = this.handlers;
    if (!handlers || this.stopping)
      return Promise.reject(new Error("Worker is stopping"));
    const run = fn(handlers);
    this.inflight.add(run);
    void run.then(
      () => this.inflight.delete(run),
      () => this.inflight.delete(run),
    );
    return run;
  }

  private staleSweepMs(): number {
    return Math.max(this.sweepIntervalMs * 3, 60_000);
  }

  private serviceOptions(): restate.ObjectOptions {
    const timeouts = this.options.timeouts ?? {};
    const retry = this.options.retry ?? {};
    return {
      inactivityTimeout: timeouts.inactivityMs ?? HOUR_MS,
      abortTimeout: timeouts.abortMs ?? HOUR_MS,
      retryPolicy: {
        initialInterval: retry.initialIntervalMs ?? 100,
        maxInterval: retry.maxIntervalMs ?? 30_000,
        exponentiationFactor: retry.exponentiationFactor ?? 2,
        maxAttempts: retry.maxAttempts ?? 70,
        onMaxAttempts: "pause",
      },
    };
  }

  /** One-way send through the ingress. Retries while the ingress is unreachable or overloaded. */
  private async send(
    service: string,
    key: string,
    handler: string,
    body: unknown,
    idempotencyKey?: string,
  ): Promise<void> {
    const url = `${this.ingressUrl}/${service}/${encodeURIComponent(key)}/${handler}/send`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (idempotencyKey !== undefined) headers["idempotency-key"] = idempotencyKey;
    await withRetry(`Restate send to ${service}/${handler}`, 10_000, async () => {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        await response.body?.cancel();
        return;
      }
      const text = await response.text().catch(() => "");
      const error = new Error(
        `Restate ingress ${response.status} for ${service}/${handler}: ${text}`,
      );
      // A just-registered service can take a moment to reach the ingress.
      throw response.status >= 500 || response.status === 404 || response.status === 429
        ? error
        : new PermanentError(error.message);
    });
  }

  /** Registers the Worker endpoint with the admin API, retrying until Restate is up. */
  private async register(uri: string): Promise<void> {
    const force = this.options.forceRegistration ?? true;
    await withRetry(
      "Restate deployment registration",
      this.options.registrationTimeoutMs ?? 60_000,
      async () => {
        const response = await fetch(`${this.adminUrl}/deployments`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ uri, force }),
          signal: AbortSignal.timeout(30_000),
        });
        if (response.ok) {
          await response.body?.cancel();
          return;
        }
        const text = await response.text().catch(() => "");
        const message = `Restate admin ${response.status} registering ${uri}: ${text}`;
        // Discovery failures (Restate cannot reach the endpoint yet) come back
        // as 4xx/5xx; keep trying until the deadline.
        throw new Error(message);
      },
    );
  }
}

// Handler maps for typed self-sends (the SDK types clients by handler map).
type SessionObject = { advance: (ctx: restate.ObjectContext, wake?: WakeInput) => Promise<void> };
type TenantObject = { sweep: (ctx: restate.ObjectContext, input: SweepInput) => Promise<void> };
type TimerObject = { fire: (ctx: restate.ObjectContext, input: TimerInput) => Promise<void> };
type ActionObject = {
  deliver: (ctx: restate.ObjectContext, input?: DeliverInput) => Promise<void>;
};

/**
 * Lists invocations of this Runtime's services that need an operator: paused
 * after exhausting retries, or backing off after a failure. Reads Restate's
 * SQL introspection (`POST /query` on the admin API).
 */
export async function listStuckInvocations(options: {
  adminUrl: string;
  servicePrefix?: string;
  tenantId?: string;
  limit?: number;
}): Promise<StuckInvocation[]> {
  const prefix = options.servicePrefix ?? "";
  if (!/^[A-Za-z0-9_]*$/.test(prefix))
    throw new Error(`Invalid Restate service prefix: ${prefix}`);
  const services = ["NylorunSession", "NylorunTenant", "NylorunTimer", "NylorunAction"].map(
    (name) => `'${prefix}${name}'`,
  );
  const clauses = [
    `target_service_name IN (${services.join(", ")})`,
    `status IN ('paused', 'backing-off')`,
  ];
  if (options.tenantId !== undefined) {
    const tenant = sqlString(options.tenantId);
    clauses.push(
      `(target_service_key = ${tenant} OR starts_with(target_service_key, ${sqlString(`${options.tenantId}:`)}))`,
    );
  }
  const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
  const rows = await query(
    options.adminUrl,
    "SELECT id, status, target_service_name, target_handler_name, target_service_key, " +
      "retry_count, last_failure, modified_at FROM sys_invocation " +
      `WHERE ${clauses.join(" AND ")} ORDER BY modified_at LIMIT ${limit}`,
  );
  // Restate 1.7 clears `last_failure` and `retry_count` when it pauses an
  // invocation; the failure is kept on the journal's `Paused` event.
  const paused = rows.filter((row) => row.status === "paused").map((row) => String(row.id));
  const pausedFailures = new Map<string, string>();
  if (paused.length > 0) {
    const events = await query(
      options.adminUrl,
      "SELECT id, appended_at, event_json FROM sys_journal_events " +
        `WHERE event_type = 'Paused' AND id IN (${paused.map(sqlString).join(", ")}) ` +
        "ORDER BY appended_at",
    );
    for (const event of events) {
      const message = pausedFailure(event.event_json);
      if (message !== undefined) pausedFailures.set(String(event.id), message);
    }
  }
  return rows.map((row) => {
    const id = String(row.id);
    const key = String(row.target_service_key ?? "");
    const colon = key.indexOf(":");
    const lastFailure =
      row.last_failure == null ? pausedFailures.get(id) : String(row.last_failure);
    const modifiedAt = row.modified_at == null ? undefined : String(row.modified_at);
    return {
      id,
      status: String(row.status),
      service: String(row.target_service_name).slice(prefix.length),
      handler: String(row.target_handler_name),
      key,
      ...(key ? { tenantId: colon > 0 ? key.slice(0, colon) : key } : {}),
      retryCount: Number(row.retry_count ?? 0),
      ...(lastFailure !== undefined ? { lastFailure } : {}),
      ...(modifiedAt !== undefined ? { modifiedAt } : {}),
    };
  });
}

async function query(adminUrl: string, sql: string): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${adminUrl.replace(/\/+$/, "")}/query`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(
      `Restate query ${response.status}: ${await response.text().catch(() => "")}`,
    );
  return ((await response.json()) as { rows: Record<string, unknown>[] }).rows;
}

function pausedFailure(eventJson: unknown): string | undefined {
  try {
    const event = JSON.parse(String(eventJson)) as {
      last_failure?: { error_code?: number; error_message?: string };
    };
    const failure = event.last_failure;
    if (!failure?.error_message) return undefined;
    return failure.error_code === undefined
      ? failure.error_message
      : `[${failure.error_code}] ${failure.error_message}`;
  } catch {
    return undefined;
  }
}

function tenantKey(tenantId: string): string {
  if (!tenantId || tenantId.includes(":"))
    throw new Error(`Invalid tenant id: ${tenantId}`);
  return tenantId;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

class PermanentError extends Error {}

async function withRetry(
  what: string,
  timeoutMs: number,
  attempt: () => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let delay = 100;
  for (;;) {
    try {
      await attempt();
      return;
    } catch (error) {
      if (error instanceof PermanentError || Date.now() + delay > deadline)
        throw new Error(`${what} failed: ${(error as Error).message}`, {
          cause: error,
        });
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 2000);
    }
  }
}

function sdkLogger(
  log: (level: string, message: string) => void,
): restate.LoggerTransport {
  return (meta, message, ...rest) => {
    const parts = [message, ...rest].map((part) =>
      part instanceof Error ? part.stack ?? part.message : String(part),
    );
    log(meta.level, parts.join(" "));
  };
}
