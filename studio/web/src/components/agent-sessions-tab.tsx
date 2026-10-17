import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { AgentView } from "@nylorun/agents";
import type { SessionSummary } from "@/studio-types";
import { lastActivity, sessionPath, sortSessions } from "@/session-list";
import { fullTime, shortTime } from "@/time-format";
import {
  ActionMenu,
  EmptyRow,
  FilterMenu,
  SearchBox,
  StatusDot,
  TableFrame,
  TableToolbar,
  ToolbarCount,
  countText,
  cellClass,
  headClass,
  menuCellClass,
  rowClass,
} from "@/components/data-table";

type Status = AgentView["sessions"][number]["status"];

/** How each session status reads: what runs, what waits on someone, what ended badly. */
export const sessionTone = (status: string) =>
  status === "running" || status === "runnable"
    ? "busy"
    : status === "waiting" || status === "paused" || status === "uncertain"
      ? "warn"
      : status === "failed"
        ? "error"
        : status === "completed"
          ? "ok"
          : "idle";

/**
 * The sessions that run on the Agent (its view lists them), by last activity as the session list
 * read it: none is special (D71). A row opens the session.
 */
export function AgentSessionsTab({
  agent,
  known,
}: {
  agent: AgentView;
  /** The Tenant's sessions as the session list read them, with their times. */
  known: readonly SessionSummary[];
}) {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"any" | Status>("any");
  const [by, setBy] = useState("any");
  const times = new Map(known.map((session) => [session.session, session]));
  const sorted = sortSessions(
    agent.sessions.map((session) => ({
      ...session,
      session: session.id,
      createdAt: times.get(session.id)?.createdAt ?? null,
      lastEventAt: times.get(session.id)?.lastEventAt ?? null,
    })),
    "newest",
  );
  const needle = search.trim().toLowerCase();
  const rows = sorted.filter(
    (s) =>
      (status === "any" || s.status === status) &&
      (by === "any" || s.ownerUserId === by) &&
      (needle === "" || s.id.toLowerCase().includes(needle) || s.ownerUserId.toLowerCase().includes(needle)),
  );
  const statuses = [...new Set(agent.sessions.map((s) => s.status))];
  const owners = [...new Set(agent.sessions.map((s) => s.ownerUserId))];
  return (
    <div>
      <TableToolbar>
        <SearchBox label="Search sessions" value={search} onChange={setSearch} />
        <FilterMenu
          label="Started by"
          value={by}
          options={[{ value: "any", label: "Anyone" }, ...owners.map((value) => ({ value, label: value }))]}
          onChange={setBy}
        />
        <FilterMenu
          label="Status"
          value={status}
          options={[{ value: "any", label: "Any" }, ...statuses.map((value) => ({ value, label: value }))]}
          onChange={setStatus}
        />
        <ToolbarCount>
          {countText(rows.length, sorted.length, "session", "sessions")}
        </ToolbarCount>
      </TableToolbar>
      <TableFrame minWidth={640}>
        <thead>
          <tr>
            <th className={headClass}>Session</th>
            <th className={`${headClass} w-[22%]`}>Started by</th>
            <th className={`${headClass} w-[18%]`}>Last activity</th>
            <th className={`${headClass} w-[16%]`}>Status</th>
            <th className={`${headClass} w-12`}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <EmptyRow columns={5}>
              {sorted.length === 0 ? "No sessions run on it yet." : "No sessions match these filters."}
            </EmptyRow>
          ) : null}
          {rows.map((s) => {
            const at = lastActivity(s);
            const open = () => navigate(sessionPath(agent.id, s.id));
            return (
              <tr key={s.id} className={`${rowClass} cursor-pointer`} onClick={open}>
                <td className={`${cellClass} font-mono text-[13px]`} title={s.id}>
                  <Link
                    to={sessionPath(agent.id, s.id)}
                    className="underline-offset-4 hover:underline"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {s.id}
                  </Link>
                </td>
                <td className={cellClass} title={s.ownerUserId}>
                  {s.ownerUserId}
                </td>
                <td className={`${cellClass} text-muted-foreground`}>
                  {at ? (
                    <time dateTime={at} title={fullTime(at)}>
                      {shortTime(at)}
                    </time>
                  ) : (
                    "—"
                  )}
                </td>
                <td className={cellClass} title={s.activeTurnId ? `Active turn: ${s.activeTurnId}` : undefined}>
                  <StatusDot tone={sessionTone(s.status)}>{s.status}</StatusDot>
                </td>
                <td className={menuCellClass}>
                  <ActionMenu
                    label={`Actions for ${s.id}`}
                    actions={[
                      { label: "Open", onSelect: open },
                      {
                        label: "View its artifacts",
                        onSelect: () => navigate(`${sessionPath(agent.id, s.id)}?inspector=record`),
                      },
                      { label: "Copy session id", onSelect: () => void navigator.clipboard.writeText(s.id) },
                    ]}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </TableFrame>
    </div>
  );
}
