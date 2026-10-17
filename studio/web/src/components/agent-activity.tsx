import { useCallback, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AGENT_EVENT_TYPES, type AgentEvent, type AgentEventType, type AgentView } from "@nylorun/agents";
import { createTenantClient } from "@/proxy-client";
import { useRead } from "@/resources/reads";
import { sessionHref } from "@/session-open";
import { fullTime, shortTime } from "@/time-format";
import { ReadState } from "@/components/resource-layout";
import { EgressRow, egressOf } from "@/components/agent-egress";
import {
  ActionMenu,
  CodeBlock,
  EmptyRow,
  FilterMenu,
  SearchBox,
  SidePanel,
  StatusDot,
  TableFrame,
  TableToolbar,
  ToolbarCount,
  countText,
  cellClass,
  headClass,
  menuCellClass,
  rowClass,
  type MenuAction,
} from "@/components/data-table";

/** The Agent's events: all of them, its lifecycle, or the connections its sandbox opened. */
type View = "any" | "lifecycle" | "connections";

/** Every type but egress: what happened to the Agent itself. */
const LIFECYCLE_TYPES: readonly AgentEventType[] = AGENT_EVENT_TYPES.filter((type) => type !== "agent.egress");

/** What an event says, on one line. */
function detailOf(event: AgentEvent): string {
  const egress = egressOf(event);
  if (egress)
    return `${egress.host}:${egress.port} · ${egress.outcome}${egress.reason ? ` · ${egress.reason}` : ""}`;
  const payload = event.payload as Record<string, unknown>;
  const parts = Object.entries(payload)
    .filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    .slice(0, 3)
    .map(([key, value]) => `${key} ${String(value)}`);
  return parts.join(" · ") || "—";
}

/** The session an event names, if any: its own, or the first turn running when a connection opened. */
function sessionOf(event: AgentEvent): string | undefined {
  const egress = egressOf(event);
  if (egress) return egress.runningTurns?.[0]?.sessionId;
  const sessionId = (event.payload as Record<string, unknown>).sessionId;
  return typeof sessionId === "string" ? sessionId : undefined;
}

/**
 * What happened to the Agent, newest first: its lifecycle (made, moved, started, stopped, its
 * disk kept and put back) and every connection its sandbox opened through egress-gate. A
 * connection is the Agent's: the turns listed were running when it opened. A row opens the event.
 */
export function AgentActivity({ tenantId, agent }: { tenantId: string; agent: AgentView }) {
  const [view, setView] = useState<View>("any");
  return <ActivityTable key={view} tenantId={tenantId} id={agent.id} view={view} onView={setView} />;
}

function ActivityTable({
  tenantId,
  id,
  view,
  onView,
}: {
  tenantId: string;
  id: string;
  view: View;
  onView: (view: View) => void;
}) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const navigate = useNavigate();
  const accumulated = useRef<AgentEvent[]>([]);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const from = accumulated.current.reduce((n, e) => Math.max(n, e.seq + 1), 0);
      const types =
        view === "connections" ? (["agent.egress"] as const) : view === "lifecycle" ? LIFECYCLE_TYPES : undefined;
      const next = await sdk.agents.events(id, { from, ...(types ? { types } : {}), signal });
      signal.throwIfAborted();
      accumulated.current = Array.from(new Map([...accumulated.current, ...next].map((e) => [e.seq, e])).values()).sort(
        (a, b) => b.seq - a.seq,
      );
      return accumulated.current;
    },
    [sdk, id, view],
  );
  const read = useRead(load);
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<"any" | "allowed" | "refused">("any");
  const [open, setOpen] = useState<number>();
  const events = read.data ?? [];
  const needle = search.trim().toLowerCase();
  const shown = events.filter((e) => {
    const egress = egressOf(e);
    if (result !== "any" && egress?.outcome !== result) return false;
    return needle === "" || e.type.includes(needle) || detailOf(e).toLowerCase().includes(needle);
  });
  const actions = (e: AgentEvent): MenuAction[] => {
    const session = sessionOf(e);
    return [
      ...(session ? [{ label: "Open session", onSelect: () => navigate(sessionHref(session)) }] : []),
      { label: "Copy event JSON", onSelect: () => void navigator.clipboard.writeText(JSON.stringify(e, null, 2)) },
    ];
  };
  const current = events.find((e) => e.seq === open);
  const currentEgress = current ? egressOf(current) : undefined;
  return (
    <div>
      <TableToolbar>
        <SearchBox label="Search activity" value={search} onChange={setSearch} />
        <FilterMenu
          label="Type"
          value={view}
          options={[
            { value: "any", label: "Any" },
            { value: "lifecycle", label: "Lifecycle" },
            { value: "connections", label: "Connections" },
          ]}
          onChange={onView}
        />
        <FilterMenu
          label="Result"
          value={result}
          options={[
            { value: "any", label: "Any" },
            { value: "allowed", label: "Allowed" },
            { value: "refused", label: "Refused" },
          ]}
          onChange={setResult}
        />
        <ToolbarCount>
          {countText(shown.length, events.length, "event", "events")}
        </ToolbarCount>
      </TableToolbar>
      <TableFrame minWidth={720}>
        <thead>
          <tr>
            <th className={`${headClass} w-[14%]`}>Time</th>
            <th className={`${headClass} w-[20%]`}>Event</th>
            <th className={headClass}>Detail</th>
            <th className={`${headClass} w-[20%]`}>Session</th>
            <th className={`${headClass} w-12`}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {read.data && shown.length === 0 ? (
            <EmptyRow columns={5}>
              {events.length === 0
                ? view === "connections"
                  ? "No connections."
                  : "No events."
                : "No activity matches these filters."}
            </EmptyRow>
          ) : null}
          {shown.map((e) => {
            const egress = egressOf(e);
            const session = sessionOf(e);
            return (
              <tr
                key={e.eventId}
                className={`${rowClass} cursor-pointer`}
                data-state={open === e.seq ? "selected" : undefined}
                onClick={() => setOpen(e.seq)}
              >
                <td className={`${cellClass} text-muted-foreground`}>
                  <time dateTime={e.time} title={fullTime(e.time)}>
                    {shortTime(e.time)}
                  </time>
                </td>
                <td className={`${cellClass} font-mono text-[13px]`} title={`${e.seq} · ${e.type}`}>
                  {egress ? (
                    <StatusDot tone={egress.outcome === "allowed" ? "ok" : "error"}>{e.type}</StatusDot>
                  ) : (
                    e.type
                  )}
                </td>
                <td className={`${cellClass} text-muted-foreground`} title={detailOf(e)}>
                  {detailOf(e)}
                </td>
                <td className={`${cellClass} font-mono text-xs text-muted-foreground`}>{session ?? "—"}</td>
                <td className={menuCellClass}>
                  <ActionMenu label={`Actions for event ${e.seq}`} actions={actions(e)} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </TableFrame>
      <ReadState {...read} onRetry={read.reload} />
      {current ? (
        <SidePanel
          title={current.type}
          description={`${current.seq} · ${fullTime(current.time)}`}
          actions={actions(current)}
          onClose={() => setOpen(undefined)}
          wide
        >
          {currentEgress ? <EgressRow egress={currentEgress} /> : null}
          <CodeBlock label="Payload">{JSON.stringify(current.payload, null, 2)}</CodeBlock>
        </SidePanel>
      ) : null}
    </div>
  );
}
