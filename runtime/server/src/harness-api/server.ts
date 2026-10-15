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
 * (`session.mcp`), and a harness that declared `workspace` in `hello` serves the Tenant's
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
  DEFAULT_HARNESS,
  DEFINITION_FILE_CHUNK_BYTES,
  HARNESS_API_VERSION,
  HARNESS_CLAIMS,
  MAX_HARNESS_STATE_BYTES,
  isHarnessId,
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
import { definitionFilesOf, type EventWriter } from "@nylorun/core/contracts";
import {
  TOOL_CALL_TOOL,
  TOOL_SEARCH_TOOL,
  delegatesOf,
  type AgentManifest,
} from "@nylorun/core/define";
import { isOwnershipLost } from "../store/ownership.js";
import { harnessOf, ownedSession, type Lease, type Session, type TenantContext } from "../tenant/context.js";
import {
  mcpDiscovered,
  pinDeferral,
  sessionToolsOf,
  type McpDiagnostic,
  type McpSnapshot,
} from "../mcp/snapshot.js";
import { contextWindowOf } from "../model/catalog.js";
import { turnManifestOf } from "../tenant/session.js";
import { sandboxWorkspaceKey, workspacePrefix } from "../sandbox/records.js";
import type { RunOf } from "../tenant/run-grants.js";
import { abortKind } from "../tenant/worker.js";
import { BlobRangeError } from "../blob/index.js";
import { openDefinitionFile, readDefinitionFile } from "../tenant/definition-files.js";
import { recordIntent, recordOutcome } from "./record.js";
import { redactTokens } from "./redact.js";
import { beat, renewEveryMs, tokenOf } from "./renew.js";

/** Who is on the other end of a connection. */
export interface HarnessPeer {
  /** For logs. */
  readonly name: string;
  /**
   * The harness id its credential is for (R4.1): `nylorun` for the harness token, a custom
   * harness's id for its own token. Its `hello` must name it. Absent for an in-process
   * harness, which may name any id; a pod's host is checked against its Environment's harness.
   */
  readonly harness?: string;
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
  /** The session's harness (R4.1): only a connection that said this id takes it. Default ours. */
  readonly harness?: string;
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
  | { readonly kind: "unavailable" }
  /**
   * The harness that would take the run cannot: a tool it runs itself (`features.tools`) has the
   * name of a tool of the turn's agents. The turn fails with `message`.
   */
  | { readonly kind: "refused"; readonly message: string };

export interface HarnessApiServer {
  /** Serves a harness's channel until it closes. Returns a function that detaches it. */
  attach(channel: HarnessChannel, peer: HarnessPeer): () => void;
  offer(offer: RunOffer): Promise<RunEnd>;
  /**
   * Sends a `workspace.*` request to a harness that serves workspaces: with `pod`, the host of
   * that pod sandbox (with `minEpoch`, one that joined at that host epoch or later, so a pod's
   * new volume is never written through its old host); otherwise one that hosts no sandbox.
   * Throws `NoWorkspaceHarness` when none is attached.
   */
  workspace<M extends CoreMethod>(
    method: M,
    params: ParamsOf<M>,
    signal?: AbortSignal,
    target?: { readonly pod?: string; readonly minEpoch?: number }
  ): Promise<ResultOf<M>>;
  /**
   * Pod sandbox `sandboxId`'s host epoch moved to `epoch` (F7.2): connections hosting it at an
   * older epoch are closed.
   */
  revokeHost(sandboxId: string, epoch: number): void;
  /**
   * Whether a host of pod sandbox `sandboxId` is connected: with `minEpoch`, one that joined at
   * that host epoch or later. A restore or a lost volume moves the epoch before the old host's
   * connection is closed (`host.revoked` is delivered after the commit), so a caller that writes
   * the new volume passes the Environment's epoch.
   */
  hosting(sandboxId: string, minEpoch?: number): boolean;
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
  /** The harness id its `hello` named (R4.1); undefined until then, when it takes no run. */
  harness?: string;
  /** Declared `workspace` in its `hello`. */
  workspace: boolean;
  /** The tools it declared it runs itself (`features.tools`, R4.2), by name. */
  tools?: ReadonlySet<string>;
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

/** What our harness said in `hello` before harness ids (R4.1): refused, with the new id. */
const LEGACY_NAME = "@nylorun/harness";

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

  /**
   * A harness may take a run of its own harness id (R4.1): a pod sandbox's host its sandbox's
   * runs, any other the rest.
   */
  const takes = (connection: Connection, run: Run) =>
    connection.harness === (run.offer.harness ?? DEFAULT_HARNESS) && connection.host?.sandboxId === run.offer.pod;

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
      const clash = nativeToolClashes(waiting[at]!.connection.tools, run.offer.start);
      if (clash.length > 0) {
        // The harness keeps waiting for a run its tools fit; this turn fails (Harness API 3).
        run.end({
          kind: "refused",
          message: `Harness '${waiting[at]!.connection.harness}' runs tools named like tools of this turn's agents: ${clash.join(", ")}. A tool the harness runs itself needs a name no other tool of the session has.`,
        });
        continue;
      }
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

  /** What a harness reports is its claim (R4.9): its harness id and, in a run, the run. */
  const writerOf = (connection: Connection, runId?: string): EventWriter => ({
    source: { kind: "harness", id: connection.harness ?? connection.peer.name },
    evidence: "claimed",
    ...(runId === undefined ? {} : { runId }),
  });

  const scope = (run: Run) => ({
    ctx,
    lease: run.offer.lease,
    signal: run.offer.controller.signal,
    ...(run.connection?.tools ? { nativeTools: run.connection.tools } : {}),
    ...(run.connection ? { writer: writerOf(run.connection, run.grant.runId) } : {}),
  });

  const serve = (connection: Connection) =>
    async (method: string, params: unknown, signal: AbortSignal): Promise<unknown> => {
      const p = params as Record<string, unknown>;
      if (method === "hello") {
        const { api, name, features } = p as ParamsOf<"hello">;
        // R3's next version adds a window of supported versions; until then there is one.
        if (api !== HARNESS_API_VERSION)
          throw new HarnessApiError(
            "invalid",
            `unsupported Harness API version ${api}: this Runtime speaks ${HARNESS_API_VERSION}`
          );
        connection.harness = await harnessIdOf(connection, name);
        connection.workspace = features.workspace !== undefined;
        if (features.tools?.length) connection.tools = new Set(features.tools.map((tool) => tool.name));
        return {
          api: HARNESS_API_VERSION,
          tenantId: ctx.config.tenantId,
          // A pod's engine runs its sandbox's backend, whatever the Tenant's preference.
          sandbox: { backend: connection.host ? null : (options.sandboxPreference ?? null) },
          renewEveryMs: renewEveryMs(ctx),
        };
      }
      if (method === "event") return claim(connection, p as ParamsOf<"event">);
      if (method === "lease" && connection.harness === undefined)
        throw new HarnessApiError("invalid", "Say hello first: a harness leases runs of the id it names");
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
      if (OUTPUTS.includes(method)) {
        const run = held(connection, String(p.runId), method);
        if (connection.harness !== DEFAULT_HARNESS) checkCustomOutput(run, method, p);
        return output(run, method, p);
      }
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
        case "definition.file":
          return definitionFile(run, p as ParamsOf<"definition.file">, signal);
        default:
          throw new HarnessApiError("invalid", `Unknown request ${method}`);
      }
    };

  /**
   * The harness id a `hello` names (R4.1): a harness id, and the one the connection's credential
   * is for. A pod's host must be its Environment's harness, so an image that is not the harness
   * its recipe names never takes the Environment's runs.
   */
  const harnessIdOf = async (connection: Connection, name: string): Promise<string> => {
    if (!isHarnessId(name))
      throw new HarnessApiError(
        "invalid",
        name === LEGACY_NAME
          ? `A harness names its harness id in hello: ours is ${DEFAULT_HARNESS}. Update the harness image (it said ${LEGACY_NAME}).`
          : `hello.name ${JSON.stringify(name)} is not a harness id: lowercase letters, digits and dashes, starting with a letter`
      );
    const bound = connection.peer.harness;
    if (bound !== undefined && bound !== name)
      throw new HarnessApiError("invalid", `This credential is for the ${bound} harness, not ${name}`);
    if (connection.host) {
      const environment = await ctx.store.tx((t) => t.environment(connection.host!.sandboxId));
      const expected = environment?.applied.harness ?? DEFAULT_HARNESS;
      if (expected !== name)
        throw new HarnessApiError(
          "invalid",
          `Environment ${connection.host.sandboxId} runs the ${expected} harness, and this pod says ${name}`
        );
    }
    return name;
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
      (event.type !== "environment.state" ||
        record.sessionId !== event.sessionId ||
        !record.key.startsWith(workspacePrefix(ctx.config.tenantId)) ||
        (connection.host !== undefined &&
          record.key !== sandboxWorkspaceKey(ctx.config.tenantId, connection.host.sandboxId)))
    )
      throw new HarnessApiError("invalid", "The workspace record is not this session's");
    try {
      await ctx.store.tx(async (t) => {
        if (record) await t.put("sandboxes", record.key, record satisfies WorkspaceRecord);
        await t.event(
          event.sessionId,
          event.turnId,
          event.type,
          redactTokens(event.payload) as never,
          writerOf(connection, event.runId)
        );
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
  const recordMcp = async (run: Run, params: ParamsOf<"session.mcp">) => {
    const snapshot = params.snapshot as McpSnapshot | undefined;
    if (snapshot !== undefined && !isSnapshot(snapshot))
      throw new HarnessApiError("invalid", "The MCP snapshot is malformed");
    // Which MCP tools the model reaches through tool_search, decided once for the session from
    // the Tenant's model's context window (R2b C10, Q21).
    const contextWindow = snapshot ? contextWindowOf(await ctx.vault.getHostModel()) : 0;
    return ctx.store.tx(async (t) => {
      const { lease } = run.offer;
      const current = await ownedSession(t, lease, lease.sessionId);
      const diagnostics = params.diagnostics as McpDiagnostic[];
      if (snapshot && !current.mcpSnapshot) {
        current.mcpSnapshot = pinDeferral(snapshot, current.manifest, contextWindow);
        current.mcpDiagnostics = diagnostics;
        await t.put("sessions", current.id, current);
        await t.event(
          current.id,
          run.grant.turnId,
          "mcp.discovered",
          mcpDiscovered(current.mcpSnapshot, diagnostics, current.manifest),
          run.connection ? writerOf(run.connection, run.grant.runId) : undefined
        );
      } else if (diagnostics.length > 0) {
        const prior = [...(current.mcpDiagnostics ?? [])];
        for (const item of diagnostics) {
          const index = prior.findIndex(
            (existing) =>
              (existing.agentId ?? null) === (item.agentId ?? null) && existing.serverName === item.serverName
          );
          if (index >= 0) prior[index] = item;
          else prior.push(item);
        }
        current.mcpDiagnostics = prior;
        await t.put("sessions", current.id, current);
      }
      return {
        ...(current.mcpSnapshot ? { snapshot: current.mcpSnapshot } : {}),
        // The turn's manifest: a variant may have disabled tools or required their approval.
        sessionTools: [...(sessionToolsOf(current.mcpSnapshot, turnManifestOf(current)) ?? [])],
      } as { snapshot: unknown; sessionTools: unknown[] };
    });
  };

  /**
   * A definition file the run's definition names (its skills', for its sandbox), base64: whole,
   * or the range `offset` and `length` name (none past the end).
   */
  const definitionFile = async (
    run: Run,
    { sha256, offset, length }: ParamsOf<"definition.file">,
    signal: AbortSignal
  ) => {
    if (!definitionFilesOf(run.offer.start.routing.rootManifest).has(sha256))
      throw new HarnessApiError("invalid", `The run's definition names no file ${sha256}`);
    const missing = () => new HarnessApiError("unavailable", `The Object store has no bytes for ${sha256}`);
    if (offset === undefined && length === undefined) {
      const bytes = await readDefinitionFile(ctx.blobs, sha256, signal);
      if (!bytes) throw missing();
      return { base64: Buffer.from(bytes).toString("base64") };
    }
    const start = offset ?? 0;
    const end = start + (length ?? DEFINITION_FILE_CHUNK_BYTES) - 1;
    let body: ReadableStream<Uint8Array> | undefined;
    try {
      body = await openDefinitionFile(ctx.blobs, sha256, { range: { start, end }, signal });
    } catch (error) {
      if (error instanceof BlobRangeError) return { base64: "" };
      throw error;
    }
    if (!body) throw missing();
    return { base64: Buffer.from(await new Response(body).arrayBuffer()).toString("base64") };
  };

  /**
   * A custom harness's output (R4.2): its state is its own, stored as sent and never read, so it
   * must be JSON and at most `MAX_HARNESS_STATE_BYTES`; a larger one fails the turn, as an engine
   * that threw would. It cannot pause for approvals in v2 (Q14): approvals read our engine's plan
   * until R5 makes them core holds.
   */
  const checkCustomOutput = (run: Run, method: string, params: Record<string, unknown>) => {
    if (method === "turn.paused")
      throw new HarnessApiError("invalid", "A custom harness cannot pause for approvals in Harness API 2");
    if (params.state === undefined || run.outputs.has(method)) return;
    const bytes = Buffer.byteLength(JSON.stringify(params.state) ?? "");
    if (bytes <= MAX_HARNESS_STATE_BYTES) return;
    output(run, "turn.failed", {
      runId: run.grant.runId,
      status: "failed",
      thrown: { code: "invalid", message: `The harness's state is ${bytes} bytes, over ${MAX_HARNESS_STATE_BYTES}` },
    }).catch(() => undefined);
    throw new HarnessApiError("invalid", `state over 256 KiB (${bytes} bytes): the turn failed`);
  };

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
          (connection) =>
            connection.workspace &&
            !connection.host &&
            connection.harness === DEFAULT_HARNESS &&
            !connection.channel.closed
        ),
      };
    },
    hosting(sandboxId, minEpoch) {
      return [...connections].some(
        (connection) =>
          connection.host?.sandboxId === sandboxId &&
          connection.host.epoch >= (minEpoch ?? 0) &&
          !connection.channel.closed
      );
    },
    revokeHost(sandboxId, epoch) {
      for (const connection of [...connections])
        if (connection.host?.sandboxId === sandboxId && connection.host.epoch < epoch)
          connection.channel.close("the sandbox's host epoch moved");
    },
    async workspace(method, params, signal, target) {
      const pod = target?.pod;
      const session = (params as { session?: { ownerId?: string } }).session?.ownerId;
      // A pod's workspace is its host's, whatever harness it is. Any other session's is served
      // by its own harness, if that harness serves workspaces: our harness's workspaces are not
      // a custom harness's files (R4.1). Sweeps and removes go to ours.
      const harness =
        pod !== undefined || session === undefined
          ? DEFAULT_HARNESS
          : harnessOf((await ctx.store.tx((t) => t.get<Session>("sessions", session))) ?? {});
      const connection = [...connections].find(
        (item) =>
          item.workspace &&
          !item.channel.closed &&
          item.host?.sandboxId === pod &&
          (item.host === undefined || item.host.epoch >= (target?.minEpoch ?? 0)) &&
          (pod !== undefined || item.harness === harness)
      );
      if (!connection) throw new NoWorkspaceHarness(pod);
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

/**
 * The tools a harness runs itself (`features.tools`) whose names the turn already uses: a tool of
 * the turn's agents (their own and the Runtime's `runtime` tools), a session tool, `tool_search` or
 * `tool_call` (session tools a later step may get). Tools are known by name alone, so a native
 * tool must not take one (Harness API 3); `hello` already refuses a name with `__`, which names an
 * MCP server's tools. A flow turn runs no native tools.
 */
export function nativeToolClashes(tools: ReadonlySet<string> | undefined, start: TurnStart): string[] {
  if (!tools?.size || start.engine !== "agent") return [];
  const manifest = start.manifest as unknown as AgentManifest;
  const taken = new Set<string>([TOOL_SEARCH_TOOL, TOOL_CALL_TOOL]);
  for (const agent of [manifest, ...delegatesOf(manifest).map((delegate) => delegate.manifest)])
    for (const tool of [...(agent.tools ?? []), ...(agent.runtime?.tools ?? [])]) taken.add(tool.name);
  for (const tool of (start.sessionTools ?? []) as readonly { readonly name?: unknown }[])
    if (typeof tool?.name === "string") taken.add(tool.name);
  return [...tools].filter((name) => taken.has(name)).sort();
}
