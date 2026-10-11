/** Session events as the log stores them, for the trace tests. */
import type { LiveEvent } from "@nylorun/core/contracts";

export const TENANT = "tn_01jtracetest0000000000000a";
export const SESSION = "ses_trace";
export const TURN = "trn_3f9";

let seq = 0;

export function row(
  type: string,
  payload: Record<string, unknown>,
  options: Partial<Pick<LiveEvent, "turnId" | "time" | "source" | "evidence" | "principal" | "visibility" | "seq">> = {},
): LiveEvent {
  const at = options.seq ?? seq++;
  return {
    schema: "nylorun.event/2",
    eventId: `evt_${at}`,
    tenantId: TENANT,
    sessionId: SESSION,
    runId: null,
    turnId: options.turnId === undefined ? TURN : options.turnId,
    incarnation: 0,
    epoch: 1,
    seq: at,
    cursor: Buffer.from(`${SESSION}:${at}`).toString("base64url"),
    time: options.time ?? "2026-10-11T09:14:12.930Z",
    schemaVersion: 1,
    source: options.source ?? { kind: "core", id: "runtime" },
    evidence: options.evidence ?? "observed",
    ...(options.principal ? { principal: options.principal } : {}),
    visibility: options.visibility ?? "public",
    retention: "full",
    type,
    payload,
  } as LiveEvent;
}

export const message = (payload: Record<string, unknown> = {}) =>
  row(
    "command.message",
    {
      type: "message",
      requestId: "req-1",
      idempotencyKey: "idem-secret-key",
      content: "Fix the failing test",
      ...payload,
    },
    {
      source: { kind: "client", id: "alice@example.com" },
      principal: { kind: "subject", id: "alice@example.com" },
    },
  );
