/**
 * One run: resume the engine from `turn.start` with the session's transcript (cached, or read
 * once), run the segment over the API host, and report how it ended. Core settles it and
 * answers with the record position the transcript is now at.
 *
 * A run core stopped for a shutdown or a lost lease is given back (`lease.release`); core
 * settles nothing for it, as it never did for an advance it stopped.
 */
import {
  fromBase64,
  type CompactionFacts,
  transcriptOf,
  transcriptUpdates,
  withTranscript,
  type HarnessChannel,
  type OutputMethod,
  type TurnOutput,
  type TurnStatus,
} from "@nylorun/core/harness-api";
import type { WorkflowManifest } from "@nylorun/core/contracts";
import type { AgentManifest } from "@nylorun/core/define";
import { runDurable, type DurableCheckpoint } from "../run/durable.js";
import { runFlowDurable } from "../flow/engine.js";
import type { FlowCheckpoint } from "../flow/checkpoint.js";
import type { FlowOperatorLimits } from "../flow/limits.js";
import { runAbortKind } from "./abort.js";
import type { HarnessExecutors, HarnessRun } from "./executors.js";
import { apiHost, type EngineConfig } from "./host.js";
import { engineToolsFor } from "../tools/engine-tools.js";
import { mcpToolSet } from "../tools/mcp.js";
import { saveOutputs } from "../tools/outputs.js";
import type { TranscriptCache } from "./transcript-cache.js";
import type { FileContext } from "../loop/model/files.js";

export interface RunContext {
  readonly channel: HarnessChannel;
  readonly executors: HarnessExecutors;
  readonly cache: TranscriptCache;
  /** The harness's configuration of our engine's own tools. */
  readonly engine: EngineConfig;
}

type EngineResult =
  Awaited<ReturnType<typeof runDurable>> | Awaited<ReturnType<typeof runFlowDurable>>;

const METHODS: Record<TurnStatus, OutputMethod> = {
  completed: "turn.completed",
  paused: "turn.paused",
  yielded: "checkpoint",
  waiting: "turn.waiting",
  uncertain: "turn.waiting",
  failed: "turn.failed",
  cancelled: "turn.failed",
};

export async function runTurn(ctx: RunContext, run: HarnessRun): Promise<void> {
  const { runId, signal } = run;
  let { start } = run;
  const sessionId = run.grant.sessionId;
  const cursor = start.transcript.cursor;
  let transcript: readonly unknown[] = [];
  let output: TurnOutput;
  let after: readonly unknown[] | undefined;
  try {
    if (start.engine === "agent" && ctx.executors.prepare) {
      const prepared = await ctx.executors.prepare(run, (params) =>
        ctx.channel.request("session.mcp", { runId, ...params }),
      );
      if (prepared?.mcp) {
        start = { ...start, mcp: prepared.mcp };
        // The executors and our engine's tools read the run's facts as they now are.
        (run as { start: HarnessRun["start"] }).start = start;
      }
    }
    let checkpoint = start.checkpoint as DurableCheckpoint;
    // The state is ours alone (R4.2): core never reads it. The turn's manifest is core's choice
    // (the pin, or a variant a message named), and the state follows it.
    if (
      start.engine === "agent" &&
      checkpoint.state &&
      checkpoint.state.manifestHash !== checkpoint.manifestHash
    )
      checkpoint = {
        ...checkpoint,
        state: { ...checkpoint.state, manifestHash: checkpoint.manifestHash },
      };
    if (start.engine === "agent" && checkpoint.state) {
      transcript = ctx.cache.get(sessionId, cursor) ?? (await read(ctx, run));
      checkpoint = { ...checkpoint, state: withTranscript(checkpoint.state, transcript) };
    }
    // The session's MCP tools as our engine offers them (protocol 15): named, and laid out as our
    // state pinned them while the facts stay the same.
    const engineTools = (agent: AgentManifest) =>
      engineToolsFor(agent, start.environment, ctx.engine);
    const mcp =
      start.engine === "agent" && start.mcp
        ? mcpToolSet(start.mcp, start.manifest as AgentManifest, {
            config: ctx.engine.mcpTools,
            ...(start.model ? { model: start.model } : {}),
            ...(checkpoint.state?.mcpLayout ? { layout: checkpoint.state.mcpLayout } : {}),
            taken: (agent) => engineTools(agent).tools.map((tool) => tool.name),
          })
        : undefined;
    const host = apiHost(ctx.channel, ctx.executors, run, ctx.engine, mcp);
    const result: EngineResult =
      start.engine === "flow"
        ? await runFlowDurable({
            manifest: start.manifest as WorkflowManifest,
            checkpoint: start.checkpoint as FlowCheckpoint,
            signal,
            host,
            limits: start.options.flowLimits as Partial<FlowOperatorLimits> | undefined,
            valueChars: ctx.engine.flowValueChars,
          })
        : await runDurable({
            manifest: start.manifest as AgentManifest,
            checkpoint,
            signal,
            host,
            ...(mcp ? { mcp } : {}),
            // Our engine's own tools and text, from the turn's facts (protocol 15).
            engineTools,
            ...(start.options.yieldAfter ? { yieldAfter: start.options.yieldAfter } : {}),
            ...(start.model ? { model: start.model } : {}),
            files: filesOf(ctx, run, start),
            loop: ctx.engine.loop,
          });
    // Our engine's outputs folder (Q5): saved before the turn ends, while the run is held.
    if (
      start.engine === "agent" &&
      result.status === "completed" &&
      start.environment?.sandbox !== undefined &&
      ctx.executors.files
    )
      await saveOutputs({
        channel: ctx.channel,
        run,
        files: ctx.executors.files,
        config: ctx.engine.outputs,
        signal,
      });
    ({ output, after } = outputOf(runId, result, transcript, start.limits.recordEntryBytes));
  } catch (error) {
    output = {
      runId,
      thrown: {
        ...(typeof (error as { code?: unknown })?.code === "string"
          ? { code: (error as { code: string }).code }
          : {}),
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
  const kind = runAbortKind(signal);
  if (kind === "shutdown" || kind === "ownership.lost") {
    await ctx.channel.request("lease.release", { runId, reason: kind }).catch(() => undefined);
    return;
  }
  const status = output.status;
  const settled = await ctx.channel
    .request(status ? METHODS[status] : "turn.failed", output)
    .catch(() => undefined);
  // The cache follows the record: an edited transcript at the cursor core settled it at; a
  // segment that waits leaves it as it started; a failure or cancel reverts it in the fold.
  if (status === "waiting" || status === "uncertain") {
    if (start.engine === "agent") ctx.cache.put(sessionId, cursor, transcript);
  } else if (after && settled?.cursor !== undefined)
    ctx.cache.put(
      sessionId,
      settled.cursor,
      after,
      estimate(ctx.cache, sessionId, transcript, output),
    );
  else ctx.cache.delete(sessionId);
}

/**
 * How the run's engine reads the turn's files (protocol 15): it decides from the model
 * descriptor and the Runtime limits, and reads text over the artifact seam.
 */
function filesOf(ctx: RunContext, run: HarnessRun, start: HarnessRun["start"]): FileContext {
  return {
    ...(start.model ? { model: start.model } : {}),
    limits: start.limits,
    async read(reference, offset, length, signal) {
      const answer = await ctx.channel.request(
        "artifact.read",
        {
          runId: run.runId,
          artifactId: reference.artifactId,
          version: reference.version,
          offset,
          length,
        },
        signal ?? run.signal,
      );
      return { artifact: answer.artifact, bytes: fromBase64(answer.base64), eof: answer.eof };
    },
  };
}

/** The edited transcript's size from the cached one's and the edits, without serializing it. */
function estimate(
  cache: TranscriptCache,
  sessionId: string,
  start: readonly unknown[],
  output: TurnOutput,
): number | undefined {
  const base = cache.bytesOf(sessionId);
  const updates = output.transcript ?? [];
  if (base === undefined) return undefined;
  if (updates.length === 0) return base;
  const keep = updates[0]!.keep;
  const kept = start.length === 0 ? 0 : Math.round((base * keep) / start.length);
  return updates.reduce((sum, update) => sum + JSON.stringify(update.entries).length, kept);
}

async function read(ctx: RunContext, run: HarnessRun): Promise<unknown[]> {
  try {
    const { entries } = await ctx.channel.request("transcript.read", { runId: run.runId });
    return entries;
  } catch (error) {
    if (run.signal.aborted) throw run.signal.reason;
    throw error;
  }
}

/** The engine's result as an output. An agent's state goes without its transcript. */
function outputOf(
  runId: string,
  result: EngineResult,
  start: readonly unknown[],
  recordEntryBytes: number,
): { output: TurnOutput; after?: readonly unknown[] } {
  if (result.status === "waiting" || result.status === "uncertain")
    return { output: { runId, status: result.status, effectIds: [...result.effectIds] } };
  const outcome = ("result" in result ? result.result : {}) as {
    state?: unknown;
    output?: unknown;
    pending?: unknown;
    error?: unknown;
  };
  const fields = {
    ...(outcome.output !== undefined ? { output: outcome.output } : {}),
    ...(outcome.pending !== undefined ? { pending: outcome.pending } : {}),
    ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    ...("cancelEffectIds" in result && result.cancelEffectIds?.length
      ? { cancelEffectIds: [...result.cancelEffectIds] }
      : {}),
  };
  if (outcome.state === undefined) return { output: { runId, status: result.status, ...fields } };
  const after = transcriptOf(outcome.state);
  const compaction = compactionOf(start, after, result);
  return {
    output: {
      runId,
      status: result.status,
      state: withTranscript(outcome.state, []),
      transcript: transcriptUpdates(start, after, recordEntryBytes, compaction),
      ...fields,
    },
    after,
  };
}

/**
 * What the segment says of a compaction it made (Q4): its transcript starts with a summary it did
 * not start with, written by the root's summary calls. Our engine keeps one summary, first; a
 * segment that compacted twice names every summary call, and the facts of the last.
 */
function compactionOf(
  start: readonly unknown[],
  after: readonly unknown[],
  result: EngineResult,
): CompactionFacts | undefined {
  const ids = "summaryEffectIds" in result ? result.summaryEffectIds : undefined;
  const entry = after[0] as
    | { kind?: unknown; trigger?: unknown; tokensBefore?: unknown; tokensAfter?: unknown }
    | undefined;
  if (!ids?.length || entry?.kind !== "compaction") return undefined;
  if (JSON.stringify(start[0]) === JSON.stringify(entry)) return undefined;
  return {
    trigger: entry.trigger === "overflow" ? "overflow" : "threshold",
    tokensBefore: Math.max(0, Math.round(Number(entry.tokensBefore) || 0)),
    tokensAfter: Math.max(0, Math.round(Number(entry.tokensAfter) || 0)),
    summaryEffectIds: [...ids],
  };
}
