/**
 * A sandbox's lifecycle stream (blueprint D39, F7.1): `sandbox.created`, `sandbox.attached`,
 * `sandbox.detached` and `sandbox.deleted`, on the `nylorun.sandbox-event/1` envelope, numbered
 * from 0 per sandbox id in `nylorun_streams.sandbox_events`. The record module is its only
 * writer, as for session events; the store runs the two statements through
 * `SandboxRecordWriter` in the caller's transaction, under the sandbox row's lock (or, for a
 * sandbox being created, its new row).
 *
 * The stream lives in the record only: it is not published to the stream relay, so no S2
 * stream follows it yet. Clients read it with `GET /v1/sandboxes/{id}/events`.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  SANDBOX_EVENT_PAYLOADS,
  SANDBOX_EVENT_SCHEMA,
  SandboxEventSchema,
  type SandboxEvent,
  type SandboxEventPayload,
  type SandboxEventType,
} from "@nylorun/core/contracts";
import { InvalidEventError } from "./envelope.js";

/** The sandbox stream's two statements, in the caller's transaction. */
export interface SandboxRecordWriter {
  /** The seq the sandbox's next event takes: one past its last, or 0. */
  nextSeq(sandboxId: string): Promise<number>;
  insert(row: { sandboxId: string; seq: number; type: string; body: SandboxEvent }): Promise<void>;
}

export interface SandboxAppendInput<T extends SandboxEventType> {
  tenantId: string;
  sandboxId: string;
  time: Date;
  type: T;
  payload: SandboxEventPayload<T>;
}

/** Builds the event and checks it against the sandbox event catalog. */
export function buildSandboxEvent<T extends SandboxEventType>(
  input: SandboxAppendInput<T> & { seq: number },
): SandboxEvent {
  const payload = SANDBOX_EVENT_PAYLOADS[input.type] as z.ZodType;
  const checkedPayload = payload.safeParse(input.payload);
  if (!checkedPayload.success)
    throw new InvalidEventError(input.type, z.prettifyError(checkedPayload.error));
  const event = JSON.parse(
    JSON.stringify({
      schema: SANDBOX_EVENT_SCHEMA,
      eventId: randomUUID(),
      tenantId: input.tenantId,
      sandboxId: input.sandboxId,
      seq: input.seq,
      time: input.time.toISOString(),
      type: input.type,
      payload: input.payload,
    }),
  ) as SandboxEvent;
  const checked = SandboxEventSchema.safeParse(event);
  if (!checked.success) throw new InvalidEventError(input.type, z.prettifyError(checked.error));
  return event;
}

/** Appends one event to the sandbox's stream through `writer`. */
export async function appendSandboxEvent<T extends SandboxEventType>(
  writer: SandboxRecordWriter,
  input: SandboxAppendInput<T>,
): Promise<SandboxEvent> {
  const seq = await writer.nextSeq(input.sandboxId);
  const event = buildSandboxEvent({ ...input, seq });
  await writer.insert({ sandboxId: input.sandboxId, seq, type: input.type, body: event });
  return event;
}
