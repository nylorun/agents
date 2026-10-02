/**
 * Builds a session event on the `nylorun.event/2` envelope and checks it against the event
 * catalog (Durable Streams §9.5) before a store writes it. Both stores call it inside
 * `Tx.event`, so nothing the catalog does not describe reaches a stream.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  EVENT_CATALOG,
  EVENT_SCHEMA,
  EVENT_SCHEMAS,
  isEventType,
  type EventPayload,
  type EventType,
  type SessionEventOf,
} from "@nylorun/core/contracts";
import { encodeCursor } from "./cursor.js";

/** A write of an event the catalog does not describe: a bug in the writer. */
export class InvalidEventError extends Error {
  constructor(
    readonly eventType: string,
    detail: string,
  ) {
    super(`Event ${eventType} does not match the event catalog: ${detail}`);
    this.name = "InvalidEventError";
  }
}

export interface EventInput<T extends EventType> {
  tenantId: string;
  sessionId: string;
  turnId: string | null;
  seq: number;
  /** The session's ownership epoch when the event is written. */
  epoch: number;
  time: Date;
  type: T;
  payload: EventPayload<T>;
}

/** The event as stored and streamed: JSON-normalized, validated. Throws `InvalidEventError`. */
export function buildEvent<T extends EventType>(input: EventInput<T>): SessionEventOf<T> {
  const type: string = input.type;
  if (!isEventType(type)) throw new InvalidEventError(type, "unknown type");
  const entry = EVENT_CATALOG[type];
  const event = JSON.parse(
    JSON.stringify({
      schema: EVENT_SCHEMA,
      eventId: randomUUID(),
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      runId: null,
      turnId: input.turnId,
      incarnation: 0,
      epoch: input.epoch,
      seq: input.seq,
      cursor: encodeCursor(input.sessionId, input.seq),
      time: input.time.toISOString(),
      schemaVersion: entry.version,
      source: { kind: entry.source, id: "runtime" },
      evidence: "observed",
      visibility: "public",
      retention: "full",
      type,
      payload: input.payload,
    }),
  ) as SessionEventOf<T>;
  const checked = EVENT_SCHEMAS[type].safeParse(event);
  if (!checked.success) throw new InvalidEventError(type, z.prettifyError(checked.error));
  return event;
}
