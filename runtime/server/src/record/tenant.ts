/**
 * The Tenant's stream: keys, signing keys, tool policy, settings, vault credentials
 * written and used, and Studio sign-ins (`TENANT_EVENT_TYPES`), numbered from 0 in
 * `nylorun_streams.tenant_events`, each with who acted (`principal`) and what wrote it (`source`).
 * The record module is its only writer; the store runs the two statements through
 * `TenantRecordWriter` in the caller's transaction, so an event commits with the change it
 * records. The writer serializes the Tenant's appends, so `seq` follows commit order.
 *
 * Like an Agent's stream, it lives in the record only: it is not published to the stream relay.
 * Clients read it with `GET /v1/tenant/audit`.
 */
import { z } from "zod";
import {
  TENANT_EVENT_PAYLOADS,
  TENANT_EVENT_SCHEMA,
  TenantEventSchema,
  type TenantEvent,
  type TenantEventPayload,
  type TenantEventSource,
  type TenantEventType,
} from "@nylorun/core/contracts";
import { InvalidEventError } from "./envelope.js";

/** The Tenant stream's two statements, in the caller's transaction. */
export interface TenantRecordWriter {
  /**
   * The seq the Tenant's next event takes: one past its last, or 0. Holds the stream's append
   * lock until the transaction ends.
   */
  nextSeq(): Promise<number>;
  insert(row: {
    seq: number;
    type: string;
    at: string;
    source: string;
    principal: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}

export interface TenantAppendInput<T extends TenantEventType> {
  time: Date;
  type: T;
  payload: TenantEventPayload<T>;
  source: TenantEventSource;
  principal: string;
}

/** Builds the event and checks it against the Tenant event catalog. */
export function buildTenantEvent<T extends TenantEventType>(input: TenantAppendInput<T> & { seq: number }): TenantEvent {
  const checkedPayload = (TENANT_EVENT_PAYLOADS[input.type] as z.ZodType).safeParse(input.payload);
  if (!checkedPayload.success) throw new InvalidEventError(input.type, z.prettifyError(checkedPayload.error));
  const event = JSON.parse(
    JSON.stringify({
      schema: TENANT_EVENT_SCHEMA,
      seq: input.seq,
      time: input.time.toISOString(),
      type: input.type,
      source: input.source,
      principal: input.principal,
      payload: input.payload,
    }),
  ) as TenantEvent;
  const checked = TenantEventSchema.safeParse(event);
  if (!checked.success) throw new InvalidEventError(input.type, z.prettifyError(checked.error));
  return event;
}

/** Appends one event to the Tenant's stream through `writer`. */
export async function appendTenantEvent<T extends TenantEventType>(
  writer: TenantRecordWriter,
  input: TenantAppendInput<T>,
): Promise<TenantEvent> {
  const seq = await writer.nextSeq();
  const event = buildTenantEvent({ ...input, seq });
  await writer.insert({
    seq,
    type: event.type,
    at: event.time,
    source: event.source,
    principal: event.principal,
    payload: event.payload,
  });
  return event;
}
