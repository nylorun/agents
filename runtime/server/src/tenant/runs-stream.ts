/**
 * The Tenant's runs stream (D83): every run of every Agent's triggers, in the `runs` stream of the
 * Tenant's current basin (Durable Streams, `streams/types.ts`), kept 7 days, and served at
 * `GET /v1/runs/stream` as server-sent events from a cursor.
 *
 * **The outbox.** A run is a `trigger_runs` row, written in its trigger's transaction; nothing is
 * appended there (no I/O in a transaction). After the commit, the code that made the run appends
 * it (`appendRuns`) and marks the row (`streamed_at`). A crash between the two leaves the row
 * unmarked, and the Tenant sweep appends every run still unmarked once it is
 * `RUNS_STREAM_GRACE_MS` old, oldest first (`streamMissedRuns`), so no run is lost. A run can
 * therefore arrive twice (appended, then the mark lost); a reader drops a run id it has seen. The
 * session stream relay is not involved: its replication filter and heads are keyed by session.
 *
 * **Basins.** The stream lives in the Tenant's current basin generation: a Tenant reset's new
 * basin starts it at 0 again. The cursor names the generation, so one from an older basin is
 * answered `410 cursor_expired`. Without S2 (tests, a local Host) the in-memory streams hold it,
 * and a restart loses what was unread.
 *
 * Nothing inside the Runtime reads it or waits on it (D48): it serves API listeners only.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TenantRun } from "@nylorun/core/contracts";
import { basinOf } from "../streams/basin.js";
import { RUNS_STREAM, RUNS_STREAM_RETENTION_SECS, type DurableStreams } from "../streams/types.js";
import type { TriggerRunRow } from "../store/types.js";
import { sleep } from "../retry.js";
import { hostTuning } from "../tuning.js";
import type { TenantContext } from "./context.js";
import { fail } from "./http.js";
import { openSse, send } from "./session-streams.js";

/** How old an unmarked run is before the sweep appends it: the code that made it had its chance. */
export const RUNS_STREAM_GRACE_MS = 2_000;

/** A run as the runs stream carries it. */
export function tenantRunOf(row: TriggerRunRow): TenantRun {
  return {
    runId: row.id,
    agentId: row.agentId,
    triggerId: row.triggerId,
    kind: row.kind,
    status: row.status,
    reason: row.reason,
    sessionId: row.sessionId,
    turnId: row.turnId,
    queuedMessageId: row.queuedMessageId,
    dueAt: row.dueAt,
    firedAt: row.firedAt,
    late: row.late,
    origin: row.kind === "wake" ? "wake" : row.origin,
    title: row.title,
  };
}

/** The basins whose runs stream this process has ensured (its retention set), by streams. */
const ensured = new WeakMap<DurableStreams, Set<string>>();

/**
 * Appends `runs` (made in a transaction that committed) to the Tenant's runs stream, then marks
 * them. Never throws: a run it cannot append stays unmarked, and the sweep appends it later.
 */
export async function appendRuns(ctx: TenantContext, runs: readonly TriggerRunRow[]): Promise<void> {
  const fresh = runs.filter((run) => run.streamedAt === null);
  if (fresh.length === 0) return;
  // A Tenant without Durable Streams wired (a test's bare context) appends nothing.
  const streams = ctx.sessionStreams?.wiring?.streams;
  if (!streams) return;
  const basin = basinOf(ctx.config.tenantId, ctx.sessionStreams.generation);
  try {
    await ensureRunsStream(streams, basin).catch((error: unknown) =>
      // Not fatal: the stream keeps the basin's default retention, and the next append tries again.
      ctx.config.logger.warn("runs stream retention not set; appending anyway", {
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    const result = await streams.append(basin, RUNS_STREAM, fresh.map(tenantRunOf));
    if (result.status !== "ok") return;
    const at = new Date().toISOString();
    await ctx.store.tx((t) => t.markTriggerRunsStreamed(fresh.map((run) => run.id), at));
    for (const run of fresh) run.streamedAt = at;
  } catch (error) {
    ctx.config.logger.warn("runs stream append failed; the sweep appends it later", {
      runs: fresh.length,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Sets the runs stream's retention once per basin and process; a failure leaves the basin's default. */
async function ensureRunsStream(streams: DurableStreams, basin: string): Promise<void> {
  if (!streams.ensureStream) return;
  let done = ensured.get(streams);
  if (!done) ensured.set(streams, (done = new Set()));
  if (done.has(basin)) return;
  await streams.ensureStream(basin, RUNS_STREAM, { retentionSecs: RUNS_STREAM_RETENTION_SECS });
  done.add(basin);
}

/**
 * The Tenant sweep's step: appends the runs still unmarked `RUNS_STREAM_GRACE_MS` after they
 * fired, oldest first, a batch at a time.
 */
export async function streamMissedRuns(ctx: TenantContext): Promise<void> {
  if (!ctx.sessionStreams?.wiring) return;
  const { batchSize } = hostTuning().sweep;
  for (let pass = 0; pass < 10; pass++) {
    const firedBefore = new Date(Date.now() - RUNS_STREAM_GRACE_MS).toISOString();
    const rows = await ctx.store.tx((t) => t.unstreamedTriggerRuns({ firedBefore, limit: batchSize }));
    if (rows.length === 0) return;
    await appendRuns(ctx, rows);
    // Not marked: the streams failed, and the next pass tries again.
    if (rows.some((row) => row.streamedAt === null) || rows.length < batchSize) return;
  }
}

// ---------------------------------------------------------------------------
// GET /v1/runs/stream

const CURSOR_PREFIX = `${RUNS_STREAM}:`;

/** The cursor after record `seq` of the runs stream in basin generation `generation`. */
export function runsCursor(generation: number, seq: number): string {
  return Buffer.from(`${CURSOR_PREFIX}${generation}:${seq}`).toString("base64url");
}

/**
 * The first sequence to read for `cursor` in the Tenant's current generation: 0 without one;
 * `400` for one that is not a runs cursor; `410 cursor_expired` for one from an older basin.
 */
export function runsStartSeq(cursor: string | undefined, generation: number): number {
  if (cursor === undefined || cursor === "") return 0;
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  const match = /^runs:(\d+):(\d+)$/.exec(text);
  if (!match) return fail(400, "cursor is not a cursor of the runs stream", { code: "invalid_cursor" });
  const from = Number(match[1]);
  if (from !== generation)
    return fail(410, "The cursor is from the Tenant's runs stream before its reset: read the stream again without a cursor.", {
      code: "cursor_expired",
    });
  return Number(match[2]) + 1;
}

/**
 * `GET /v1/runs/stream`: the Tenant's runs from the cursor, as `event: run` frames (`id:` the
 * cursor, `data:` `{cursor, run}`), following the stream until the client leaves, the Tenant moves
 * to a new basin (the stream ends: resume without a cursor) or it closes.
 */
export async function streamRuns(
  ctx: TenantContext,
  request: IncomingMessage,
  response: ServerResponse,
  cursor: string | undefined,
): Promise<void> {
  const streams = ctx.sessionStreams.wiring?.streams ?? fail(503, "The runs stream is unavailable");
  const generation = ctx.sessionStreams.generation;
  let next = runsStartSeq(cursor, generation);
  const basin = basinOf(ctx.config.tenantId, generation);
  const stop = new AbortController();
  openSse(request, response, () => stop.abort());
  void (async () => {
    const { minMs, maxMs } = hostTuning().streams.retry;
    let delay = minMs;
    while (!stop.signal.aborted && ctx.sessionStreams.generation === generation) {
      try {
        for await (const record of streams.read<TenantRun>(basin, RUNS_STREAM, next, { signal: stop.signal })) {
          if (stop.signal.aborted) return;
          if (record.seq < next) continue;
          next = record.seq + 1;
          delay = minMs;
          const at = runsCursor(generation, record.seq);
          send(response, `id: ${at}\nevent: run\ndata: ${JSON.stringify({ cursor: at, run: record.body })}\n\n`);
        }
        if (stop.signal.aborted) return;
        break;
      } catch (error) {
        if (stop.signal.aborted) return;
        ctx.config.logger.warn("runs stream read failed; retrying", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      await sleep(delay, stop.signal);
      delay = Math.min(delay * 2, maxMs);
    }
    if (!response.writableEnded) response.end();
  })();
}
