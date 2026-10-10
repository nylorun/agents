import { Link } from "react-router-dom";
import {
  Bot,
  Building2,
  Cpu,
  GitBranch,
  KeyRound,
  LoaderCircle,
  MessagesSquare,
} from "lucide-react";
import type { Connection } from "@/studio-types";
import { shortTenantId, type StudioTenantInfo } from "@/config";
import { embedded } from "@/embed/index.ts";
import { sessionAgents, sessionsPath, type SessionAgent } from "@/session-list";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";

/** One agent under Sessions: it filters the session list to that agent. */
function AgentFilterItem({
  agent,
  active,
}: Readonly<{ agent: SessionAgent; active: boolean }>) {
  const Icon = agent.workflow ? GitBranch : Bot;
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton asChild isActive={active} size="sm">
        <Link to={sessionsPath(agent.id)} title={agent.name}>
          <Icon />
          <span className="min-w-0 flex-1 truncate">{agent.name}</span>
          <span className="ml-auto shrink-0 text-xs tabular-nums text-sidebar-foreground/70">
            {agent.count}
          </span>
        </Link>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
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
  sessionsActive,
  activeAgentId,
  settingsSection,
}: Readonly<{
  connection: Connection;
  tenant?: StudioTenantInfo;
  /** The session list or a session is open. */
  sessionsActive?: boolean;
  /** The agent the session list is filtered on, or the open session's agent. */
  activeAgentId?: string;
  settingsSection?: SettingsSection;
}>) {
  const agents = sessionAgents(connection);
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
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={sessionsActive && activeAgentId === undefined}
                  tooltip="Sessions"
                >
                  <Link to={sessionsPath()}>
                    <MessagesSquare />
                    <span>Sessions</span>
                    {connection.status === "Running" ? (
                      <span className="tabular-nums text-sidebar-foreground/70">
                        ({connection.sessions.length})
                      </span>
                    ) : null}
                  </Link>
                </SidebarMenuButton>
                <SidebarMenuSub>
                  {agents.map((agent) => (
                    <AgentFilterItem
                      key={agent.id}
                      agent={agent}
                      active={sessionsActive === true && agent.id === activeAgentId}
                    />
                  ))}
                  {connection.status === "Running" && agents.length === 0 ? (
                    <SidebarMenuSubItem>
                      <span className="block px-2 py-1 text-xs text-muted-foreground">
                        No agents yet
                      </span>
                    </SidebarMenuSubItem>
                  ) : null}
                  {connection.status === "Offline" ? (
                    <SidebarMenuSubItem>
                      <span className="block px-2 py-1 text-xs text-muted-foreground">
                        Agent server unavailable
                      </span>
                    </SidebarMenuSubItem>
                  ) : null}
                  {connection.status === "Connecting" ? (
                    <SidebarMenuSubItem>
                      <span className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
                        <LoaderCircle className="size-3.5 animate-spin" />
                        Discovering agents
                      </span>
                    </SidebarMenuSubItem>
                  ) : null}
                </SidebarMenuSub>
              </SidebarMenuItem>
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
