/**
 * A environment's lifecycle stream (blueprint D39, F7.1): `environment.created`, `environment.attached`,
 * `environment.detached` and `environment.deleted` (and the rest of `ENVIRONMENT_EVENT_TYPES`, egress-gate's
 * `environment.egress` for every connection among them, D67), on the `nylorun.environment-event/1` envelope, numbered
 * from 0 per environment id in `nylorun_streams.environment_events`. The record module is its only
 * writer, as for session events; the store runs the two statements through
 * `EnvironmentRecordWriter` in the caller's transaction, under the environment row's lock (or, for a
 * environment being created, its new row).
 *
 * The stream lives in the record only: it is not published to the stream relay, so no S2
 * stream follows it yet. Clients read it with `GET /v1/environmentes/{id}/events`.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ENVIRONMENT_EVENT_PAYLOADS,
  ENVIRONMENT_EVENT_SCHEMA,
  EnvironmentEventSchema,
  type EnvironmentEvent,
  type EnvironmentEventPayload,
  type EnvironmentEventType,
} from "@nylorun/core/contracts";
import { InvalidEventError } from "./envelope.js";
import { checkEntry } from "./append.js";

/** The Environment stream's two statements, in the caller's transaction. */
export interface EnvironmentRecordWriter {
  /** The seq the Environment's next event takes: one past its last, or 0. */
  nextSeq(environmentId: string): Promise<number>;
  insert(row: { environmentId: string; seq: number; type: string; body: EnvironmentEvent }): Promise<void>;
}

export interface EnvironmentAppendInput<T extends EnvironmentEventType> {
  tenantId: string;
  environmentId: string;
  time: Date;
  type: T;
  payload: EnvironmentEventPayload<T>;
  /** The Tenant's Runtime limit `recordEntryBytes`, as for a session's events. */
  maxEntryBytes: number;
}

/** Builds the event and checks it against the Environment event catalog. */
export function buildEnvironmentEvent<T extends EnvironmentEventType>(
  input: EnvironmentAppendInput<T> & { seq: number },
): EnvironmentEvent {
  const payload = ENVIRONMENT_EVENT_PAYLOADS[input.type] as z.ZodType;
  const checkedPayload = payload.safeParse(input.payload);
  if (!checkedPayload.success)
    throw new InvalidEventError(input.type, z.prettifyError(checkedPayload.error));
  const event = JSON.parse(
    JSON.stringify({
      schema: ENVIRONMENT_EVENT_SCHEMA,
      eventId: randomUUID(),
      tenantId: input.tenantId,
      environmentId: input.environmentId,
      seq: input.seq,
      time: input.time.toISOString(),
      type: input.type,
      payload: input.payload,
    }),
  ) as EnvironmentEvent;
  const checked = EnvironmentEventSchema.safeParse(event);
  if (!checked.success) throw new InvalidEventError(input.type, z.prettifyError(checked.error));
  return event;
}

/** Appends one event to the Environment's stream through `writer`. */
export async function appendEnvironmentEvent<T extends EnvironmentEventType>(
  writer: EnvironmentRecordWriter,
  input: EnvironmentAppendInput<T>,
): Promise<EnvironmentEvent> {
  checkEntry(`The ${input.type} event's payload`, input.payload, input.maxEntryBytes);
  const seq = await writer.nextSeq(input.environmentId);
  const event = buildEnvironmentEvent({ ...input, seq });
  await writer.insert({ environmentId: input.environmentId, seq, type: input.type, body: event });
  return event;
}
