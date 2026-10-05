/**
 * The Harness API's server, one per Tenant (blueprint D37). Harnesses attach a channel each and
 * keep `lease` requests waiting; an advance that took a session's lease *offers* its segment
 * (`offer`), and the first waiting harness takes it as a run. Offers are served in order; one
 * no harness takes within `offerWaitMs` ends `unavailable`.
 *
 * A run is bound to the connection that leased it: any other gets `run_not_held`. Core's abort
 * of the advance reaches the harness as `cancel` with the abort's reason. The run ends with an
 * output (answered once core has settled it, with the transcript's new cursor), a release, or
 * the connection's loss (`connection.lost`).
 *
 * F6.2: a harness readies the session's MCP servers itself and records what it found
 * (`session.mcp`); an Action outcome recorded while its run is held reaches it as
 * `effect.resolved`; and a harness that declared `workspace` in `hello` serves the Tenant's
 * workspaces (`workspace`, the `workspace.*` requests). A harness claims `sandbox.*` events
 * only for a run it holds (its session, or the session owning the run's sandbox) or a session a
 * workspace request it is serving acts for; a `sandbox.state` claim's record becomes the
 * workspace's row in the `sandboxes` table.
 *
 * F7.2: a pod sandbox's engine connects as that sandbox's *host* (`HarnessPeer.host`, from its
 * host token): it leases only runs whose session is attached to its sandbox (`RunOffer.pod`),
 * serves only that sandbox's workspace (`workspace(..., { pod })`), and claims events only for
 * those. Every other connection (the harness container, the in-process harness) never leases a
 * pod sandbox's run and never serves its workspace. A connection whose host epoch is older than
 * the sandbox's (`revokeHost`: a new join, a stop, a loss) is closed; its runs end as
 * `connection.lost`.
 */
import { randomUUID } from "node:crypto";
import {
  HARNESS_API_VERSION,
  HARNESS_CLAIMS,
  HarnessApiError,
  type CoreMethod,
  type EffectIntent,
  type HarnessChannel,
  type HarnessClaim,
  type OutputMethod,
  type ParamsOf,
  type ReleaseReason,
  type ResultOf,
  type RunGrant,
  type TurnOutput,
  type TurnStart,
  type WorkspaceRecord,
} from "@nylorun/core/harness-api";
import type { ActionOutcome } from "@nylorun/core/contracts";
import { isOwnershipLost } from "../store/ownership.js";
import { ownedSession, type Lease, type TenantContext } from "../tenant/context.js";
import { mcpDiscovered, sessionToolsOf, type McpDiagnostic, type McpSnapshot } from "../mcp/snapshot.js";
import { sandboxWorkspaceKey, workspacePrefix } from "../sandbox/records.js";
import type { RunOf } from "../tenant/run-grants.js";
import { abortKind } from "../tenant/worker.js";
import { recordIntent, recordOutcome } from "./record.js";
import { beat, renewEveryMs, tokenOf } from "./renew.js";

/** Who is on the other end of a connection. */
export interface HarnessPeer {
  /** For logs. */
  readonly name: string;
  /** A pod sandbox's engine (F7.2): the sandbox it hosts, at the host epoch of its token. */
  readonly host?: { readonly sandboxId: string; readonly epoch: number };
}

/** A segment an advance offers to a harness. */
export interface RunOffer {
  readonly lease: Lease;
  readonly start: TurnStart;
  /** The advance's controller: its abort is the run's `cancel`. */
  readonly controller: AbortController;
  /** The transcript core folded at `start.transcript.cursor`, for `transcript.read`. */
  readonly transcript: readonly unknown[];
  /** What the run token names, for its re-mint on renewal (F5). */
  readonly run: RunOf;
  /** Called when a harness takes the run. */
  readonly onTaken?: () => void;
  /**
   * The pod sandbox whose engine runs it (F7.2): only that sandbox's host takes it. Absent,
   * only a harness that hosts no sandbox does.
   */
  readonly pod?: string;
  /** How long to wait for a harness to take it. Default the server's `offerWaitMs`. */
  readonly waitMs?: number;
}

/** How a run ended. An output waits for `reply` (or `refuse`) before the harness hears back. */
export type RunEnd =
  | {
      readonly kind: "output";
      readonly method: OutputMethod;
      readonly output: TurnOutput;
      reply(answer: { cursor?: number }): void;
      refuse(error: unknown): void;
    }
  | { readonly kind: "released"; readonly reason: ReleaseReason }
  /** Core's controller aborted before any harness took the run. */
  | { readonly kind: "aborted" }
  /** No harness took the run within `offerWaitMs`. */
  | { readonly kind: "unavailable" };

export interface HarnessApiServer {
  /** Serves a harness's channel until it closes. Returns a function that detaches it. */
  attach(channel: HarnessChannel, peer: HarnessPeer): () => void;
  offer(offer: RunOffer): Promise<RunEnd>;
  /**
   * An Action outcome of session `sessionId` was recorded: the run holding it, if any, gets it
   * (`effect.resolved`). Call it after the outcome's commit.
   */
  resolved(sessionId: string, effectId: string, outcome: ActionOutcome): void;
  /** A harness holds a run of `sessionId` here. */
  holds(sessionId: string): boolean;
  /**
   * Sends a `workspace.*` request to a harness that serves workspaces: with `pod`, the host of
   * that pod sandbox; otherwise one that hosts no sandbox. Throws `NoWorkspaceHarness` when
   * none is attached.
   */
  workspace<M extends CoreMethod>(
    method: M,
    params: ParamsOf<M>,
    signal?: AbortSignal,
    target?: { readonly pod?: string }
  ): Promise<ResultOf<M>>;
  /**
   * Pod sandbox `sandboxId`'s host epoch moved to `epoch` (F7.2): connections hosting it at an
   * older epoch are closed.
   */
  revokeHost(sandboxId: string, epoch: number): void;
  /** Whether a host of pod sandbox `sandboxId` is connected. */
  hosting(sandboxId: string): boolean;
  /** Harnesses attached now, and whether one serves workspaces. */
  status(): HarnessStatus;
  /** Harnesses attached now. */
  readonly connected: number;
  close(): void;
}

/** The Harness API's state, for Tenant status and `/ready`. */
export interface HarnessStatus {
  readonly connected: number;
  readonly workspace: boolean;
}

/** No attached harness serves workspaces (or, with `pod`, that pod sandbox's). */
export class NoWorkspaceHarness extends Error {
  override readonly name = "NoWorkspaceHarness";
  constructor(readonly pod?: string) {
    super(
      pod === undefined
        ? "No harness serving workspaces is connected"
        : `Sandbox ${pod} has no pod connected: it is stopped or starting`
    );
  }
}

interface Connection {
  readonly channel: HarnessChannel;
  readonly peer: HarnessPeer;
  /** The pod sandbox it hosts, if any. */
  readonly host?: { readonly sandboxId: string; readonly epoch: number };
  /** Declared `workspace` in its `hello`. */
  workspace: boolean;
  /** Sessions its workspace requests in flight act for, with how many each. */
  readonly claims: Map<string, number>;
  /** `workspace.sweep` and `workspace.remove` requests in flight: they may stop any workspace. */
  sweeping: number;
}

interface Waiting {
  readonly connection: Connection;
  resolve(answer: { run: RunGrant; input: TurnStart }): void;
}

interface Run {
  grant: RunGrant;
  readonly offer: RunOffer;
  connection?: Connection;
  ended?: true;
  /** Outputs received, by method: a repeated one gets the same answer. */
  readonly outputs: Map<string, Promise<{ cursor?: number }>>;
  end(end: RunEnd): void;
}

const OUTPUTS: readonly string[] = [
  "turn.completed",
  "turn.paused",
  "turn.waiting",
  "turn.failed",
  "checkpoint",
];

export interface HarnessApiServerOptions {
  offerWaitMs?: number;
  /** The sandbox backend preference a harness that serves workspaces selects with. */
  sandboxPreference?: string;
}

export function createHarnessApiServer(
  ctx: TenantContext,
  options: HarnessApiServerOptions = {}
): HarnessApiServer {
  const offerWaitMs = options.offerWaitMs ?? 10_000;
  const connections = new Set<Connection>();
  const waiting: Waiting[] = [];
  const queued: Run[] = [];
  const runs = new Map<string, Run>();
  let closed = false;

  /** A harness may take a run: a pod sandbox's host its sandbox's runs, any other the rest. */
  const takes = (connection: Connection, run: Run) => connection.host?.sandboxId === run.offer.pod;

  /** Hands queued runs to waiting harnesses that may take them, in order. */
  const match = () => {
    for (let i = 0; i < queued.length; ) {
      const run = queued[i]!;
      const at = waiting.findIndex((entry) => takes(entry.connection, run));
      if (at < 0) {
        i += 1;
        continue;
      }
      queued.splice(i, 1);
      const lease = waiting.splice(at, 1)[0]!;
      run.connection = lease.connection;
      // The run token the advance holds now (F5): the gate calls of this run present it.
      run.grant = { ...run.grant, ...tokenOf(ctx, run.offer.lease) };
      runs.set(run.grant.runId, run);
      lease.resolve({ run: run.grant, input: run.offer.start });
      run.offer.onTaken?.();
    }
  };

  const held = (connection: Connection, runId: string, output?: string): Run => {
    const run = runs.get(runId);
    if (!run || run.connection !== connection || (run.ended && !(output && run.outputs.has(output))))
      throw new HarnessApiError("run_not_held", `Run ${runId} is not held by this harness`);
    return run;
  };

  const scope = (run: Run) => ({
    ctx,
    lease: run.offer.lease,
    signal: run.offer.controller.signal,
  });

  const serve = (connection: Connection) =>
    async (method: string, params: unknown, signal: AbortSignal): Promise<unknown> => {
      const p = params as Record<string, unknown>;
      if (method === "hello") {
        const { capabilities } = p as ParamsOf<"hello">;
        connection.workspace = capabilities.workspace !== undefined;
        return {
          api: HARNESS_API_VERSION,
          tenantId: ctx.config.tenantId,
          // A pod's engine runs its sandbox's backend, whatever the Tenant's preference.
          sandbox: { backend: connection.host ? null : (options.sandboxPreference ?? null) },
          renewEveryMs: renewEveryMs(ctx),
        };
      }
      if (method === "event") return claim(connection, p as ParamsOf<"event">);
      if (method === "lease")
        return new Promise((resolve, reject) => {
          const entry: Waiting = { connection, resolve };
          waiting.push(entry);
          signal.addEventListener("abort", () => {
            const index = waiting.indexOf(entry);
            if (index >= 0) waiting.splice(index, 1);
            reject(signal.reason);
          });
          match();
        });
      if (OUTPUTS.includes(method)) return output(held(connection, String(p.runId), method), method, p);
      const run = held(connection, String(p.runId));
      switch (method) {
        case "lease.renew":
          return beat(ctx, run.offer.lease, run.offer.controller, run.offer.run, () => !run.ended);
        case "lease.release":
          run.end({ kind: "released", reason: p.reason as ReleaseReason });
          return {};
        case "effect.intent": {
          const { effect, requestHash } = p as ParamsOf<"effect.intent">;
          if (effect.sessionId !== run.grant.sessionId || effect.turnId !== run.grant.turnId)
            throw new HarnessApiError("invalid", "The effect is not of this run's turn");
          return recordIntent(scope(run), effect as EffectIntent, requestHash);
        }
        case "effect.outcome": {
          const { effectId, ...result } = p as ParamsOf<"effect.outcome">;
          return recordOutcome(
            scope(run),
            effectId,
            "error" in result ? { error: result.error } : { value: result.value }
          );
        }
        case "transcript.read":
          return { cursor: run.offer.start.transcript.cursor, entries: [...run.offer.transcript] };
        case "session.mcp":
          return recordMcp(run, p as ParamsOf<"session.mcp">);
        default:
          throw new HarnessApiError("invalid", `Unknown request ${method}`);
      }
    };

  /**
   * A `sandbox.*` event the harness claims: for a run it holds (the run's session, or the
   * session owning its sandbox), or a session one of its workspace requests acts for. A
   * `sandbox.state` record becomes the workspace's `sandboxes` row. Claims are best effort, as
   * the events of core's own SandboxManager are: a session gone since is skipped.
   */
  const claim = async (connection: Connection, event: ParamsOf<"event">): Promise<Record<string, never>> => {
    if (!HARNESS_CLAIMS.includes(event.type as HarnessClaim))
      throw new HarnessApiError("invalid", `A harness may not claim ${event.type}`);
    let allowed = connection.sweeping > 0 || connection.claims.has(event.sessionId);
    if (event.runId !== undefined) {
      const run = held(connection, event.runId);
      allowed ||=
        event.sessionId === run.grant.sessionId || event.sessionId === run.offer.start.routing.sandbox?.ownerId;
    }
    if (!allowed) throw new HarnessApiError("run_not_held", `This harness may not claim events of ${event.sessionId}`);
    const record = event.record;
    if (
      record &&
      (event.type !== "sandbox.state" ||
        record.sessionId !== event.sessionId ||
        !record.key.startsWith(workspacePrefix(ctx.config.tenantId)) ||
        (connection.host !== undefined &&
          record.key !== sandboxWorkspaceKey(ctx.config.tenantId, connection.host.sandboxId)))
    )
      throw new HarnessApiError("invalid", "The workspace record is not this session's");
    try {
      await ctx.store.tx(async (t) => {
        if (record) await t.put("sandboxes", record.key, record satisfies WorkspaceRecord);
        await t.event(event.sessionId, event.turnId, event.type, event.payload as never);
      });
    } catch (error) {
      ctx.config.logger.warn("harness event claim not recorded", {
        sessionId: event.sessionId,
        type: event.type,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return {};
  };

  /**
   * What a harness found readying the run's MCP servers: the first snapshot recorded for the
   * session wins, with `mcp.discovered` in its log; diagnostics replace those of the same server.
   * Answers the session's snapshot and the tools the engine advertises.
   */
  const recordMcp = (run: Run, params: ParamsOf<"session.mcp">) =>
    ctx.store.tx(async (t) => {
      const { lease } = run.offer;
      const current = await ownedSession(t, lease, lease.sessionId);
      const diagnostics = params.diagnostics as McpDiagnostic[];
      const snapshot = params.snapshot as McpSnapshot | undefined;
      if (snapshot !== undefined && !isSnapshot(snapshot))
        throw new HarnessApiError("invalid", "The MCP snapshot is malformed");
      if (snapshot && !current.mcpSnapshot) {
        current.mcpSnapshot = snapshot;
        current.mcpDiagnostics = diagnostics;
        await t.put("sessions", current.id, current);
        await t.event(current.id, run.grant.turnId, "mcp.discovered", mcpDiscovered(snapshot, diagnostics));
      } else if (diagnostics.length > 0) {
        const prior = [...(current.mcpDiagnostics ?? [])];
        for (const item of diagnostics) {
          const index = prior.findIndex(
            (existing) => existing.capabilityId === item.capabilityId && existing.serverName === item.serverName
          );
          if (index >= 0) prior[index] = item;
          else prior.push(item);
        }
        current.mcpDiagnostics = prior;
        await t.put("sessions", current.id, current);
      }
      return {
        ...(current.mcpSnapshot ? { snapshot: current.mcpSnapshot } : {}),
        sessionTools: [...(sessionToolsOf(current.mcpSnapshot) ?? [])],
      } as { snapshot: unknown; sessionTools: unknown[] };
    });

  const output = (run: Run, method: string, params: Record<string, unknown>) => {
    const known = run.outputs.get(method);
    if (known) return known;
    const answer = new Promise<{ cursor?: number }>((reply, refuse) =>
      run.end({
        kind: "output",
        method: method as OutputMethod,
        output: params as unknown as TurnOutput,
        reply,
        refuse,
      })
    );
    run.outputs.set(method, answer);
    return answer;
  };

  return {
    get connected() {
      return connections.size;
    },
    status() {
      return {
        connected: connections.size,
        workspace: [...connections].some(
          (connection) => connection.workspace && !connection.host && !connection.channel.closed
        ),
      };
    },
    hosting(sandboxId) {
      return [...connections].some(
        (connection) => connection.host?.sandboxId === sandboxId && !connection.channel.closed
      );
    },
    revokeHost(sandboxId, epoch) {
      for (const connection of [...connections])
        if (connection.host?.sandboxId === sandboxId && connection.host.epoch < epoch)
          connection.channel.close("the sandbox's host epoch moved");
    },
    holds(sessionId) {
      for (const run of runs.values())
        if (run.grant.sessionId === sessionId && !run.ended && run.connection) return true;
      return false;
    },
    resolved(sessionId, effectId, outcome) {
      for (const run of runs.values())
        if (run.grant.sessionId === sessionId && !run.ended && run.connection)
          run.connection.channel.notify("effect.resolved", { runId: run.grant.runId, effectId, outcome });
    },
    async workspace(method, params, signal, target) {
      const pod = target?.pod;
      const connection = [...connections].find(
        (item) => item.workspace && !item.channel.closed && item.host?.sandboxId === pod
      );
      if (!connection) throw new NoWorkspaceHarness(pod);
      const session = (params as { session?: { ownerId?: string } }).session?.ownerId;
      if (session) connection.claims.set(session, (connection.claims.get(session) ?? 0) + 1);
      else connection.sweeping += 1;
      try {
        return await connection.channel.request(method, params, signal);
      } finally {
        if (session) {
          const left = (connection.claims.get(session) ?? 1) - 1;
          if (left > 0) connection.claims.set(session, left);
          else connection.claims.delete(session);
        } else connection.sweeping -= 1;
      }
    },
    attach(channel, peer) {
      const connection: Connection = {
        channel,
        peer,
        ...(peer.host ? { host: { sandboxId: peer.host.sandboxId, epoch: peer.host.epoch } } : {}),
        workspace: false,
        claims: new Map(),
        sweeping: 0,
      };
      connections.add(connection);
      const handler = serve(connection);
      channel.handle(async (method, params, signal) => {
        try {
          return await handler(method, params, signal);
        } catch (error) {
          if (isOwnershipLost(error)) throw new HarnessApiError("ownership_lost", (error as Error).message);
          throw error;
        }
      });
      const detach = () => {
        if (!connections.delete(connection)) return;
        for (let i = waiting.length - 1; i >= 0; i -= 1)
          if (waiting[i]!.connection === connection) waiting.splice(i, 1);
        for (const run of runs.values())
          if (run.connection === connection) run.end({ kind: "released", reason: "connection.lost" });
      };
      channel.onClose(detach);
      return detach;
    },
    offer(offer) {
      const { lease, controller } = offer;
      return new Promise<RunEnd>((resolve) => {
        const checkpoint = offer.start.checkpoint as { turnId: string };
        let timer: NodeJS.Timeout | undefined;
        const onAbort = () => {
          const index = queued.indexOf(run);
          if (index >= 0) {
            queued.splice(index, 1);
            run.end({ kind: "aborted" });
            return;
          }
          if (run.ended || !run.connection) return;
          const reason = controller.signal.reason;
          run.connection.channel.notify("cancel", {
            runId: run.grant.runId,
            reason: abortKind(controller.signal)!,
            ...(reason instanceof Error ? { message: reason.message } : {}),
          });
        };
        const run: Run = {
          grant: { runId: randomUUID(), sessionId: lease.sessionId, turnId: checkpoint.turnId, epoch: lease.epoch },
          offer,
          outputs: new Map(),
          end(end) {
            if (run.ended) return;
            run.ended = true;
            clearTimeout(timer);
            controller.signal.removeEventListener("abort", onAbort);
            // An output's run stays held until core answers it, so a repeat gets the same answer.
            if (end.kind === "output") {
              const forget = () => runs.delete(run.grant.runId);
              resolve({
                ...end,
                reply: (answer) => {
                  forget();
                  end.reply(answer);
                },
                refuse: (error) => {
                  forget();
                  end.refuse(error);
                },
              });
            } else {
              runs.delete(run.grant.runId);
              resolve(end);
            }
          },
        };
        if (closed) return run.end({ kind: "unavailable" });
        queued.push(run);
        if (controller.signal.aborted) return onAbort();
        controller.signal.addEventListener("abort", onAbort);
        timer = setTimeout(() => {
          const index = queued.indexOf(run);
          if (index < 0) return;
          queued.splice(index, 1);
          run.end({ kind: "unavailable" });
        }, offer.waitMs ?? offerWaitMs);
        timer.unref();
        match();
      });
    },
    close() {
      closed = true;
      for (const run of queued.splice(0)) run.end({ kind: "unavailable" });
    },
  };
}

function isSnapshot(value: unknown): value is McpSnapshot {
  const snapshot = value as Partial<McpSnapshot> | null;
  return (
    typeof snapshot === "object" &&
    snapshot !== null &&
    snapshot.snapshotSchemaVersion === 1 &&
    typeof snapshot.manifestHash === "string" &&
    Array.isArray(snapshot.mcpTools)
  );
}
