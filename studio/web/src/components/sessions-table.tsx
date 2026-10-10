import { Link, useNavigate } from "react-router-dom";
import { Bot, ChevronDown, GitBranch, LoaderCircle, Plus } from "lucide-react";
import type { Connection } from "@/studio-types";
import { NEW_SESSION } from "@/session-open";
import {
  sessionAgents,
  sessionPath,
  sessionsPath,
  type SessionAgent,
} from "@/session-list";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

function SessionStatus({ status }: Readonly<{ status: string }>) {
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  if (status === "running" || status === "runnable")
    return (
      <span className="inline-flex items-center gap-1.5">
        <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
        {label}
      </span>
    );
  const dot =
    status === "failed"
      ? "bg-red-500"
      : status === "waiting" || status === "uncertain" || status === "paused"
        ? "bg-amber-500"
        : status === "completed"
          ? "bg-emerald-500"
          : "bg-muted-foreground";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={"size-1.5 shrink-0 rounded-full " + dot} />
      {label}
    </span>
  );
}

function AgentName({ agent }: Readonly<{ agent: SessionAgent }>) {
  const Icon = agent.workflow ? GitBranch : Bot;
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate">{agent.name}</span>
    </span>
  );
}

/** Starts a session of the filtered agent, or of the agent picked from a menu. */
function NewSessionButton({
  agents,
  agentFilter,
}: Readonly<{ agents: readonly SessionAgent[]; agentFilter?: string }>) {
  const navigate = useNavigate();
  const start = (agentId: string): void => {
    void navigate(sessionPath(agentId, crypto.randomUUID()), {
      state: NEW_SESSION,
    });
  };
  const registered = agents.filter((agent) => agent.registered);
  const filtered = registered.find((agent) => agent.id === agentFilter);
  if (filtered)
    return (
      <Button onClick={() => start(filtered.id)}>
        <Plus />
        New session
      </Button>
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button disabled={registered.length === 0}>
          <Plus />
          New session
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {registered.map((agent) => (
          <DropdownMenuItem key={agent.id} onSelect={() => start(agent.id)}>
            <AgentName agent={agent} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Every session of the Tenant in one table, optionally filtered to one agent. */
export function SessionsTable({
  connection,
  agentFilter,
}: Readonly<{ connection: Connection; agentFilter?: string }>) {
  const navigate = useNavigate();
  const agents = sessionAgents(connection);
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const sessions =
    agentFilter === undefined
      ? connection.sessions
      : connection.sessions.filter((session) => session.agentId === agentFilter);
  const filterKnown = agentFilter === undefined || byId.has(agentFilter);
  return (
    <section className="flex w-full flex-1 flex-col gap-6 overflow-auto p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Sessions</h1>
          <p className="mt-2 text-muted-foreground">
            Every session in this Tenant. Open one to chat and inspect its
            events.
          </p>
        </div>
        <NewSessionButton agents={agents} agentFilter={agentFilter} />
      </div>
      <label className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-muted-foreground">Agent</span>
        <select
          className="h-9 min-w-56 rounded-md border bg-transparent px-3"
          value={agentFilter ?? ""}
          onChange={(event) =>
            void navigate(sessionsPath(event.target.value || undefined))
          }
        >
          <option value="">All agents ({connection.sessions.length})</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name} ({agent.count})
            </option>
          ))}
          {filterKnown ? null : (
            <option value={agentFilter}>{agentFilter} (0)</option>
          )}
        </select>
      </label>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Session</TableHead>
              <TableHead>Agent</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {connection.status === "Connecting" ? (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="h-24 text-center text-muted-foreground"
                >
                  Loading sessions…
                </TableCell>
              </TableRow>
            ) : sessions.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="h-24 text-center text-muted-foreground"
                >
                  {agentFilter === undefined
                    ? "No sessions yet."
                    : `No sessions for ${byId.get(agentFilter)?.name ?? agentFilter}.`}
                </TableCell>
              </TableRow>
            ) : (
              sessions.map((session) => {
                const href = sessionPath(session.agentId, session.session);
                const agent = byId.get(session.agentId);
                return (
                  <TableRow
                    key={session.session}
                    className="cursor-pointer"
                    onClick={() => void navigate(href)}
                  >
                    <TableCell className="font-mono text-xs">
                      <Link
                        to={href}
                        className="underline-offset-4 hover:underline"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {session.session}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {agent ? <AgentName agent={agent} /> : session.agentId}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {session.ownerUserId}
                    </TableCell>
                    <TableCell>
                      <SessionStatus status={session.status} />
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
