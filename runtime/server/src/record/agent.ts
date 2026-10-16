/**
 * An Agent's lifecycle stream (blueprint D39, F7.1; an Environment's before protocol 16):
 * `agent.created`, `agent.attached`, `agent.detached` and `agent.deleted` (and the rest of
 * `AGENT_EVENT_TYPES`, egress-gate's `agent.egress` for every connection among them, D67), on
 * the `nylorun.agent-event/1` envelope, numbered from 0 per Agent id in
 * `nylorun_streams.agent_events`. The record module is its only writer, as for session events;
 * the store runs the two statements through `AgentRecordWriter` in the caller's transaction, under
 * the Agent row's lock (or, for an Agent being created, its new row).
 *
 * The stream lives in the record only: it is not published to the stream relay, so no S2 stream
 * follows it yet. Clients read it with `GET /v1/agents/{id}/events`.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AGENT_EVENT_PAYLOADS,
  AGENT_EVENT_SCHEMA,
  AgentEventSchema,
  type AgentEvent,
  type AgentEventPayload,
  type AgentEventType,
} from "@nylorun/core/contracts";
import { InvalidEventError } from "./envelope.js";
import { checkEntry } from "./append.js";

/** The Agent stream's two statements, in the caller's transaction. */
export interface AgentRecordWriter {
  /** The seq the Agent's next event takes: one past its last, or 0. */
  nextSeq(agentId: string): Promise<number>;
  insert(row: { agentId: string; seq: number; type: string; body: AgentEvent }): Promise<void>;
}

export interface AgentAppendInput<T extends AgentEventType> {
  tenantId: string;
  agentId: string;
  time: Date;
  type: T;
  payload: AgentEventPayload<T>;
  /** The Tenant's Runtime limit `recordEntryBytes`, as for a session's events. */
  maxEntryBytes: number;
}

/** Builds the event and checks it against the Agent event catalog. */
export function buildAgentEvent<T extends AgentEventType>(input: AgentAppendInput<T> & { seq: number }): AgentEvent {
  const payload = AGENT_EVENT_PAYLOADS[input.type] as z.ZodType;
  const checkedPayload = payload.safeParse(input.payload);
  if (!checkedPayload.success)
    throw new InvalidEventError(input.type, z.prettifyError(checkedPayload.error));
  const event = JSON.parse(
    JSON.stringify({
      schema: AGENT_EVENT_SCHEMA,
      eventId: randomUUID(),
      tenantId: input.tenantId,
      agentId: input.agentId,
      seq: input.seq,
      time: input.time.toISOString(),
      type: input.type,
      payload: input.payload,
    }),
  ) as AgentEvent;
  const checked = AgentEventSchema.safeParse(event);
  if (!checked.success) throw new InvalidEventError(input.type, z.prettifyError(checked.error));
  return event;
}

/** Appends one event to the Agent's stream through `writer`. */
export async function appendAgentEvent<T extends AgentEventType>(
  writer: AgentRecordWriter,
  input: AgentAppendInput<T>,
): Promise<AgentEvent> {
  checkEntry(`The ${input.type} event's payload`, input.payload, input.maxEntryBytes);
  const seq = await writer.nextSeq(input.agentId);
  const event = buildAgentEvent({ ...input, seq });
  await writer.insert({ agentId: input.agentId, seq, type: input.type, body: event });
  return event;
}
