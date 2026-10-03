/**
 * One run: resume the engine from `turn.start` with the session's transcript (cached, or read
 * once), run the segment over the API host, and report how it ended. Core settles it and
 * answers with the record position the transcript is now at.
 *
 * A run core stopped for a shutdown or a lost lease is given back (`lease.release`); core
 * settles nothing for it, as it never did for an advance it stopped.
 */
import {
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
import { runDurable, type DurableCheckpoint, type DurableSessionTool } from "../run/durable.js";
import { runFlowDurable } from "../flow/engine.js";
import type { FlowCheckpoint } from "../flow/checkpoint.js";
import type { FlowOperatorLimits } from "../flow/limits.js";
import { runAbortKind } from "./abort.js";
import type { HarnessExecutors, HarnessRun } from "./executors.js";
import { apiHost } from "./host.js";
import type { TranscriptCache } from "./transcript-cache.js";

export interface RunContext {
  readonly channel: HarnessChannel;
  readonly executors: HarnessExecutors;
  readonly cache: TranscriptCache;
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
  const { start, runId, signal } = run;
  const sessionId = run.grant.sessionId;
  const cursor = start.transcript.cursor;
  let transcript: readonly unknown[] = [];
  let output: TurnOutput;
  let after: readonly unknown[] | undefined;
  try {
    let checkpoint = start.checkpoint as DurableCheckpoint;
    if (start.engine === "agent" && checkpoint.state) {
      transcript = ctx.cache.get(sessionId, cursor) ?? (await read(ctx, run));
      checkpoint = { ...checkpoint, state: withTranscript(checkpoint.state, transcript) };
    }
    const host = apiHost(ctx.channel, ctx.executors, run);
    const result: EngineResult =
      start.engine === "flow"
        ? await runFlowDurable({
            manifest: start.manifest as WorkflowManifest,
            checkpoint: start.checkpoint as FlowCheckpoint,
            signal,
            host,
            limits: start.options.flowLimits as Partial<FlowOperatorLimits> | undefined,
          })
        : await runDurable({
            manifest: start.manifest as AgentManifest,
            checkpoint,
            signal,
            host,
            sessionTools: start.sessionTools as readonly DurableSessionTool[] | undefined,
            ...(start.options.yieldAfter ? { yieldAfter: start.options.yieldAfter } : {}),
          });
    ({ output, after } = outputOf(runId, result, transcript));
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
  return {
    output: {
      runId,
      status: result.status,
      state: withTranscript(outcome.state, []),
      transcript: transcriptUpdates(start, after),
      ...fields,
    },
    after,
  };
}
