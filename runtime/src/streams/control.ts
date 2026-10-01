/**
 * Signals on a basin's `tenant/control` stream (Durable Streams §8). They are appended
 * directly, never recorded: a lost signal costs latency, never correctness (the epoch fence
 * stops a cancelled turn's effects; readers also check their sessions periodically).
 */
import { CONTROL_STREAM, type ControlSignal, type DurableStreams } from "./types.js";

/** Appends a `session.cancel` signal: the process running the session's advance aborts it. */
export async function signalCancel(
  streams: DurableStreams,
  basin: string,
  sessionId: string,
): Promise<void> {
  if (!sessionId) throw new Error("sessionId is required");
  const signal: ControlSignal = { type: "session.cancel", sessionId };
  await streams.append(basin, CONTROL_STREAM, [signal]);
}

/**
 * Appends a `sessions.reset` signal to the old generation's basin: every process with the
 * Tenant open moves its readers to `generation` and ends the streams of deleted sessions.
 */
export async function signalSessionsReset(
  streams: DurableStreams,
  basin: string,
  generation: number,
): Promise<void> {
  const signal: ControlSignal = { type: "sessions.reset", generation };
  await streams.append(basin, CONTROL_STREAM, [signal]);
}

/**
 * Appends a `subject.revoked` signal: every process with the Tenant open ends the subject's
 * streams opened with a token older than `epoch`.
 */
export async function signalSubjectRevoked(
  streams: DurableStreams,
  basin: string,
  subject: string,
  epoch: number,
): Promise<void> {
  const signal: ControlSignal = { type: "subject.revoked", subject, epoch };
  await streams.append(basin, CONTROL_STREAM, [signal]);
}
