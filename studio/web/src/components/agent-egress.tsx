import { Link } from "react-router-dom";
import type { AgentEvent, EgressRunningTurn } from "@nylorun/agents";
import { sessionHref } from "@/session-open";
import { Badge } from "@/components/ui/badge";
import { date } from "@/components/agents";

/** The payload of an `agent.egress` event (D67), as Studio reads it. */
export interface EgressPayload {
  readonly host: string;
  readonly port: number;
  readonly outcome: "allowed" | "refused";
  readonly reason?: string;
  readonly mode: "tunnel" | "credential";
  readonly requests?: number;
  readonly bytesUp: number;
  readonly bytesDown: number;
  readonly durationMs: number;
  readonly startedAt: string;
  readonly runningTurns?: readonly EgressRunningTurn[];
}

export function egressOf(event: AgentEvent): EgressPayload | undefined {
  return event.type === "agent.egress" ? (event.payload as unknown as EgressPayload) : undefined;
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

/**
 * One connection the Agent's sandbox opened through egress-gate. It is the Agent's (D67): the
 * turns listed were running when it opened, which says when, not which one made it.
 */
export function EgressRow({
  egress,
  sessionId,
}: {
  egress: EgressPayload;
  /** The session whose view this is: its own turns are named as such. */
  sessionId?: string;
}) {
  const turns = egress.runningTurns ?? [];
  const others = turns.filter((turn) => turn.sessionId !== sessionId);
  return (
    <div className="space-y-1 border-b py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="break-all font-mono">
          {egress.host}:{egress.port}
        </span>
        <Badge variant={egress.outcome === "allowed" ? "secondary" : "destructive"}>
          {egress.outcome === "allowed" ? "allowed" : `refused${egress.reason ? ` · ${egress.reason}` : ""}`}
        </Badge>
        {egress.mode === "credential" ? <Badge variant="outline">credential set</Badge> : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {date(egress.startedAt)} · {Math.round(egress.durationMs)} ms · {bytes(egress.bytesUp)} up ·{" "}
        {bytes(egress.bytesDown)} down
        {egress.requests !== undefined ? ` · ${egress.requests} requests` : ""}
      </p>
      <p className="break-all text-xs text-muted-foreground">
        {turns.length === 0 ? (
          "No turn was running."
        ) : (
          <>
            Running then:{" "}
            {turns.map((turn, index) => (
              <span key={`${turn.sessionId}:${turn.turnId}`}>
                {index > 0 ? ", " : ""}
                {turn.sessionId === sessionId ? (
                  "this session"
                ) : (
                  <Link className="underline" to={sessionHref(turn.sessionId)}>
                    {turn.sessionId}
                  </Link>
                )}
              </span>
            ))}
            {sessionId !== undefined && others.length > 0 ? " (the connection may be theirs)" : ""}
          </>
        )}
      </p>
    </div>
  );
}
