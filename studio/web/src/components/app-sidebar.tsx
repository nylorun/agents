import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Bot,
  Building2,
  ChevronRight,
  CirclePlus,
  Cpu,
  GitBranch,
  KeyRound,
  LoaderCircle,
} from "lucide-react";
import type { AgentManifest, Connection, SessionSummary } from "@/studio-types";
import { shortTenantId, type StudioTenantInfo } from "@/config";
import { embedded } from "@/embed/index.ts";
import { NEW_SESSION } from "@/session-open";
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
} from "@/components/ui/sidebar";

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
  const navigate = useNavigate();
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
  const startSession = (): void => {
    void navigate(sessionPath(agent.id, crypto.randomUUID()), {
      state: NEW_SESSION,
    });
  };
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
function statusDotClass(status: Connection["status"]): string {
  return status === "Running"
    ? "bg-emerald-500"
    : status === "Connecting"
      ? "bg-amber-500"
      : "bg-muted-foreground";
}
/** The Tenant and its Runtime status; opens the Tenant overview. */
function TenantNavigation({
  connection,
  tenant,
  active,
}: Readonly<{
  connection: Connection;
  tenant?: StudioTenantInfo;
  active: boolean;
}>) {
  // Embedded, the app owns the Tenant's name too (Studio §8.7).
  const named = tenant !== undefined && !embedded();
  const title = named ? tenant.name : "Runtime";
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="lg"
        asChild
        isActive={active}
        tooltip={title + " · " + connection.status}
      >
        <Link to="/settings/overview" title={tenant?.id}>
          <div className="relative flex aspect-square size-8 items-center justify-center rounded-lg border bg-background">
            <Building2 className="size-4" />
            <span
              className={
                "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-sidebar " +
                statusDotClass(connection.status)
              }
            />
          </div>
          <div className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-medium">{title}</span>
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-sidebar-foreground/70">
              {named ? (
                <span className="truncate font-mono">
                  {shortTenantId(tenant.id)}
                </span>
              ) : null}
              {named ? <span aria-hidden>·</span> : null}
              <span className="flex shrink-0 items-center gap-1" role="status">
                {connection.status === "Connecting" ? (
                  <LoaderCircle className="size-3 animate-spin" />
                ) : null}
                {connection.status}
              </span>
            </span>
          </div>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
export type SettingsSection = "overview" | "models" | "credentials";
export function AppSidebar({
  connection,
  tenant,
  activeAgentId,
  activeSessionId,
  settingsSection,
}: Readonly<{
  connection: Connection;
  tenant?: StudioTenantInfo;
  activeAgentId?: string;
  activeSessionId?: string;
  settingsSection?: SettingsSection;
}>) {
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
          <TenantNavigation
            connection={connection}
            tenant={tenant}
            active={settingsSection === "overview"}
          />
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>
            Agents
            {connection.status === "Running" ? (
              <span className="ml-1 tabular-nums">
                ({connection.agents.length})
              </span>
            ) : null}
          </SidebarGroupLabel>
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
              {connection.status === "Offline" ? (
                <SidebarMenuItem>
                  <span className="block px-2 py-1 text-sm text-muted-foreground group-data-[collapsible=icon]:hidden">
                    Agent server unavailable
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
      </SidebarContent>
      {/* Pinned below the agents, which scroll above it. */}
      <SidebarFooter>
        <SidebarGroup className="p-0">
          <SidebarGroupLabel>Settings</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={settingsSection === "models"}
                  tooltip="Models"
                >
                  <Link to="/settings/models">
                    <Cpu />
                    <span>Models</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={settingsSection === "credentials"}
                  tooltip="Credentials"
                >
                  <Link to="/settings/credentials">
                    <KeyRound />
                    <span>Credentials</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarFooter>
    </Sidebar>
  );
}
