import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  Box,
  Files,
  Bot,
  ChevronRight,
  CirclePlus,
  Database,
  GitBranch,
  LoaderCircle,
  ServerOff,
  Settings,
} from "lucide-react";
import type { AgentManifest, Connection, SessionSummary } from "@/studio-types";
import { shortTenantId, type StudioTenantInfo } from "@/config";
import { embedded } from "@/embed/index.ts";
import { useStartSession } from "@/components/new-session";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarSeparator,
} from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

function agentPath(agentId: string): string {
  return "/agents/" + encodeURIComponent(agentId);
}
function sessionPath(agentId: string, sessionId: string): string {
  return agentPath(agentId) + "/sessions/" + encodeURIComponent(sessionId);
}
function sessionTitle(session: SessionSummary): string {
  const title = session.title?.replace(/\s+/gu, " ").trim();
  return title ? title : "New session";
}
function SessionStatus({ status }: Readonly<{ status: string }>) {
  if (status === "running")
    return (
      <LoaderCircle
        className="ml-auto size-3.5 shrink-0 animate-spin text-muted-foreground"
        aria-label="Running"
      />
    );
  if (status === "waiting")
    return (
      <span
        className="ml-auto size-1.5 shrink-0 rounded-full bg-amber-500"
        aria-label="Waiting for input"
      />
    );
  return (
    <span
      className="ml-auto size-1.5 shrink-0 rounded-full bg-muted-foreground"
      aria-label="Idle"
    />
  );
}

function SessionItem({
  session,
  active,
  agentId,
}: Readonly<{
  session: SessionSummary;
  active: boolean;
  agentId: string;
}>) {
  const title = sessionTitle(session);
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton asChild isActive={active} size="sm">
        <Link to={sessionPath(agentId, session.session)} title={title}>
          <span className="min-w-0 flex-1 truncate">{title}</span>
          <SessionStatus status={session.status} />
        </Link>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}
function AgentNavigation({
  agent,
  sessions,
  activeAgentId,
  activeSessionId,
}: Readonly<{
  agent: AgentManifest;
  sessions: readonly SessionSummary[];
  activeAgentId?: string;
  activeSessionId?: string;
}>) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (agent.id === activeAgentId) setOpen(true);
  }, [agent.id, activeAgentId]);
  const displayedSessions =
    activeAgentId === agent.id &&
    activeSessionId !== undefined &&
    !sessions.some((session) => session.session === activeSessionId)
      ? [
          { session: activeSessionId, status: "idle", startedAt: Date.now() },
          ...sessions,
        ]
      : sessions;
  const startNewSession = useStartSession();
  const startSession = (): void => startNewSession(agent);
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <SidebarMenuItem>
        <SidebarMenuButton asChild isActive={agent.id === activeAgentId} tooltip={agent.name}>
          <Link to={agentPath(agent.id)}>
            {agent.kind === "workflow" || agent.manifest.kind === "workflow" ? (
              <GitBranch />
            ) : (
              <Bot />
            )}
            <span>{agent.name}</span>
          </Link>
        </SidebarMenuButton>
        <CollapsibleTrigger asChild>
          <SidebarMenuAction className="data-[state=open]:rotate-90">
            <ChevronRight />
            <span className="sr-only">Toggle {agent.name} sessions</span>
          </SidebarMenuAction>
        </CollapsibleTrigger>
        <SidebarMenuAction className="right-7" showOnHover onClick={startSession}>
          <CirclePlus />
          <span className="sr-only">New {agent.name} session</span>
        </SidebarMenuAction>
        <CollapsibleContent>
          <SidebarMenuSub>
            {displayedSessions.length === 0 ? (
              <SidebarMenuSubItem>
                <span className="block px-2 py-1 text-xs text-muted-foreground">
                  No sessions yet
                </span>
              </SidebarMenuSubItem>
            ) : (
              displayedSessions.map((session) => (
                <SessionItem
                  key={session.session}
                  session={session}
                  active={session.session === activeSessionId}
                  agentId={agent.id}
                />
              ))
            )}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}
function ConnectionIndicator({
  connection,
}: Readonly<{ connection: Connection }>) {
  const running = connection.status === "Running";
  const className = running
    ? "bg-emerald-500"
    : connection.status === "Connecting"
      ? "bg-amber-500"
      : "bg-muted-foreground";
  const indicator = (
    <div className="flex items-center gap-2">
      <span className={"size-2 shrink-0 rounded-full " + className} />
      {connection.status === "Connecting" ? (
        <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
      ) : running ? (
        <Activity className="size-3.5 shrink-0" />
      ) : (
        <ServerOff className="size-3.5 shrink-0" />
      )}
      <span className="group-data-[collapsible=icon]:hidden">
        {connection.status}
      </span>
    </div>
  );
  if (connection.url === undefined) return indicator;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{indicator}</TooltipTrigger>
      <TooltipContent side="right">{connection.url}</TooltipContent>
    </Tooltip>
  );
}
export function AppSidebar({
  connection,
  tenant,
  activeAgentId,
  activeSessionId,
  settingsActive,
  resourceActive,
}: Readonly<{
  connection: Connection;
  tenant?: StudioTenantInfo;
  activeAgentId?: string;
  activeSessionId?: string;
  settingsActive?: boolean;
  resourceActive?: "sandboxes" | "artifacts";
}>) {
  const availability =
    connection.status === "Running"
      ? connection.agents.length +
        " agent" +
        (connection.agents.length === 1 ? "" : "s")
      : "Agent server unavailable";
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          {/* Embedded, the app owns the branding (Studio §8.7). */}
          {embedded() ? null : (
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/">
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                  <img
                    alt=""
                    aria-hidden
                    className="size-5 dark:invert"
                    height={20}
                    src="/brand/nylorun-mark-white.svg"
                    width={20}
                  />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">Nylorun</span>
                  <span className="truncate text-xs">Studio</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          )}
          {tenant && !embedded() ? (
            <SidebarMenuItem>
              <div
                className="px-2 py-1.5 text-xs text-sidebar-foreground/70 group-data-[collapsible=icon]:hidden"
                title={tenant.id}
              >
                <div className="truncate font-medium text-sidebar-foreground">
                  {tenant.name}
                </div>
                <div className="truncate font-mono">
                  {shortTenantId(tenant.id)}
                </div>
              </div>
            </SidebarMenuItem>
          ) : null}
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Agents</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {connection.agents.map((agent) => (
                <AgentNavigation
                  key={agent.id}
                  agent={agent}
                  sessions={connection.sessionsByAgent[agent.id] ?? []}
                  activeAgentId={activeAgentId}
                  activeSessionId={activeSessionId}
                />
              ))}
              {connection.status === "Running" &&
              connection.agents.length === 0 ? (
                <SidebarMenuItem>
                  <span className="block px-2 py-1 text-sm text-muted-foreground">
                    None
                  </span>
                </SidebarMenuItem>
              ) : null}
              {connection.status === "Connecting" ? (
                <SidebarMenuItem>
                  <span className="flex items-center gap-2 px-2 py-1 text-sm text-muted-foreground">
                    <LoaderCircle className="size-4 animate-spin" />
                    Discovering agents
                  </span>
                </SidebarMenuItem>
              ) : null}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {(["sandboxes", "artifacts"] as const).map(resource => (
                <SidebarMenuItem key={resource}>
                  <SidebarMenuButton asChild isActive={resourceActive === resource} tooltip={resource === "sandboxes" ? "Sandboxes" : "Artifacts"}>
                    <Link to={`/${resource}`}>
                      {resource === "sandboxes" ? <Box /> : <Files />}
                      <span>{resource === "sandboxes" ? "Sandboxes" : "Artifacts"}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={settingsActive}
                  tooltip="Tenant settings"
                >
                  <Link to="/settings/overview">
                    <Settings />
                    <span>Tenant settings</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarSeparator />
        <div className="flex flex-col gap-2 px-2 py-1.5 text-xs text-sidebar-foreground/70 group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:px-0">
          <div className="flex items-center gap-2">
            <Database className="size-3.5 shrink-0" />
            <span className="group-data-[collapsible=icon]:hidden">
              {availability}
            </span>
          </div>
          <ConnectionIndicator connection={connection} />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
