import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowDown, ArrowUp, Bot, ChevronDown, GitBranch, LoaderCircle } from "lucide-react";
import type { Connection } from "@/studio-types";
import {
  lastActivity,
  sessionAgents,
  sessionPath,
  sessionsPath,
  sortSessions,
  type SessionAgent,
  type SessionOrder,
} from "@/session-list";
import { fullTime, shortTime } from "@/time-format";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
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

export function AgentName({ agent }: Readonly<{ agent: SessionAgent }>) {
  const Icon = agent.workflow ? GitBranch : Bot;
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate">{agent.name}</span>
    </span>
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
  const [order, setOrder] = useState<SessionOrder>("newest");
  const sessions = useMemo(
    () =>
      sortSessions(
        agentFilter === undefined
          ? connection.sessions
          : connection.sessions.filter((session) => session.agentId === agentFilter),
        order,
      ),
    [connection.sessions, agentFilter, order],
  );
  const [filterOpen, setFilterOpen] = useState(false);
  // One agent at a time: picking one closes the menu.
  const filterOn = (agentId?: string): void => {
    setFilterOpen(false);
    void navigate(sessionsPath(agentId));
  };
  const filterLabel =
    agentFilter === undefined
      ? "All agents"
      : (byId.get(agentFilter)?.name ?? agentFilter);
  return (
    <section className="flex min-h-0 w-full flex-1 flex-col overflow-hidden">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b bg-background px-4">
        <h1 className="text-sm font-medium">Sessions</h1>
        <span className="text-xs text-muted-foreground">
          {sessions.length} total
        </span>
        <DropdownMenu open={filterOpen} onOpenChange={setFilterOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto w-44 justify-between font-normal"
              aria-label="Filter by agent"
            >
              <span className="truncate">{filterLabel}</span>
              <ChevronDown className="size-4 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuCheckboxItem
              checked={agentFilter === undefined}
              onCheckedChange={() => filterOn()}
            >
              All agents
              <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                {connection.sessions.length}
              </span>
            </DropdownMenuCheckboxItem>
            {agents.map((agent) => (
              <DropdownMenuCheckboxItem
                key={agent.id}
                checked={agent.id === agentFilter}
                onCheckedChange={() => filterOn(agent.id)}
              >
                <span className="truncate">{agent.name}</span>
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                  {agent.count}
                </span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <TableHead>Session</TableHead>
              <TableHead className="w-64">Agent</TableHead>
              <TableHead className="w-56">Owner</TableHead>
              <TableHead
                className="w-40"
                aria-sort={order === "newest" ? "descending" : "ascending"}
              >
                <button
                  type="button"
                  className="-ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted"
                  title={
                    order === "newest"
                      ? "Newest first: show oldest first"
                      : "Oldest first: show newest first"
                  }
                  onClick={() => setOrder(order === "newest" ? "oldest" : "newest")}
                >
                  Last activity
                  {order === "newest" ? (
                    <ArrowDown className="size-3.5 text-muted-foreground" />
                  ) : (
                    <ArrowUp className="size-3.5 text-muted-foreground" />
                  )}
                </button>
              </TableHead>
              <TableHead className="w-32">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {connection.status === "Connecting" ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="h-28 text-center text-muted-foreground"
                >
                  Loading sessions…
                </TableCell>
              </TableRow>
            ) : sessions.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="h-28 text-center text-muted-foreground"
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
                const activity = lastActivity(session);
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
                    <TableCell className="max-w-0 truncate text-xs text-muted-foreground">
                      {session.ownerUserId}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                      {activity ? (
                        <time dateTime={activity} title={fullTime(activity)}>
                          {shortTime(activity)}
                        </time>
                      ) : (
                        "—"
                      )}
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
      </ScrollArea>
    </section>
  );
}
