import { Link } from "react-router-dom";
import type { AgentView } from "@nylorun/agents";
import { Bot, Building2, Cpu, Files, LoaderCircle, Plus } from "lucide-react";
import type { Connection } from "@/studio-types";
import { shortTenantId, type StudioTenantInfo } from "@/config";
import { embedded } from "@/embed/index.ts";
import { useStartSession } from "@/components/new-session";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { sessionsPath } from "@/session-list";
import { manifestVersionOf, stateLabel } from "@/agent-list";
import { manifestPath } from "@/agent-path";
import { agentUnavailable } from "@/credential-coverage";
import { STUDIO_OWNER } from "@/session-open";
import type { AgentCatalog } from "@/resources/agents";
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

/** The dot of an Agent's state: amber when it needs input, red when it fails. */
function stateDot(state: string): string {
  return state === "failing"
    ? "bg-red-500"
    : state === "input_required"
      ? "bg-amber-500"
      : state === "working"
        ? "bg-sky-500"
        : "bg-sidebar-foreground/30";
}

/** The sessions of an Agent that wait on a person or fail, from what made its state. */
function needsPerson(agent: AgentView): number {
  return agent.attention.filter(
    (item) => item.sessionId !== undefined && (item.state === "input_required" || item.state === "failing"),
  ).length;
}

/** One Agent under Agents: it filters the session table to its sessions. */
function AgentItem({ agent, active }: Readonly<{ agent: AgentView; active: boolean }>) {
  const waiting = needsPerson(agent);
  // The dot and the count are seen only: the name says them too.
  const label =
    `${agent.id} · ${stateLabel(agent.state)}` +
    (waiting > 0 ? ` · ${waiting} ${waiting === 1 ? "session needs" : "sessions need"} attention` : "");
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton asChild isActive={active} size="sm">
        <Link to={sessionsPath(agent.id)} aria-label={label} title={`${label} · ${manifestVersionOf(agent)}`}>
          <span className={"size-1.5 shrink-0 rounded-full " + stateDot(agent.state)} aria-hidden />
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{agent.id}</span>
          {waiting > 0 ? (
            <span
              className={
                "ml-auto shrink-0 rounded-full px-1.5 text-xs tabular-nums text-white " +
                (agent.state === "failing" ? "bg-red-500" : "bg-amber-500")
              }
              aria-hidden
            >
              {waiting}
            </span>
          ) : null}
        </Link>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}

/** Starts a session on the Agent picked from its menu, from any page. */
function NewSessionItem({ agents }: Readonly<{ agents: readonly AgentView[] }>) {
  const start = useStartSession();
  return (
    <SidebarMenuItem className="pt-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            tooltip="New session"
            disabled={agents.length === 0}
            className="h-9 justify-center gap-2 px-3 font-medium bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 hover:text-primary-foreground active:bg-primary/90 active:text-primary-foreground data-[state=open]:bg-primary/90 data-[state=open]:hover:bg-primary/90 data-[state=open]:hover:text-primary-foreground"
          >
            <Plus />
            {/* Centred with the icon when expanded; collapsed, the icon alone. */}
            <span className="group-data-[collapsible=icon]:hidden">New session</span>
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" className="max-h-96 w-64 overflow-y-auto">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            Start a session on
          </DropdownMenuLabel>
          {agents.map((agent) => {
            const unavailable = agentUnavailable(agent, STUDIO_OWNER);
            return (
              <DropdownMenuItem
                key={agent.id}
                disabled={unavailable !== undefined}
                title={unavailable}
                onSelect={() => start(agent)}
              >
                <Bot />
                <span className="truncate font-mono text-xs">{agent.id}</span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
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
    // Set apart from the brand above it (when shown) and New session below it.
    <SidebarMenuItem
      className={
        "border-b border-sidebar-border py-2" +
        (embedded() ? "" : " border-t")
      }
    >
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
export type SettingsSection = "overview" | "models";
export function AppSidebar({
  connection,
  tenant,
  catalog,
  allSessionsActive,
  activeAgentId,
  manifestsActive,
  settingsSection,
}: Readonly<{
  connection: Connection;
  tenant?: StudioTenantInfo;
  catalog: AgentCatalog;
  /** The session table is open on every Agent's sessions. */
  allSessionsActive?: boolean;
  /** The Agent the session table is filtered on, or whose page or session is open. */
  activeAgentId?: string;
  /** The agent manifests or one manifest's page is open. */
  manifestsActive?: boolean;
  settingsSection?: SettingsSection;
}>) {
  // By id, so a row stays put as its state changes; its dot tells the state.
  const agents = [...catalog.agents].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
          <NewSessionItem agents={agents} />
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {/* Agents open the session table: all of it, or each Agent's sessions. */}
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={allSessionsActive} tooltip="Agents">
                  <Link to={sessionsPath()}>
                    <Bot />
                    <span>Agents</span>
                    {catalog.status === "Ready" ? (
                      <span className="tabular-nums text-sidebar-foreground/70">
                        ({catalog.agents.length})
                      </span>
                    ) : null}
                  </Link>
                </SidebarMenuButton>
                <SidebarMenuSub>
                  {agents.map((agent) => (
                    <AgentItem key={agent.id} agent={agent} active={agent.id === activeAgentId} />
                  ))}
                  {catalog.status === "Ready" && agents.length === 0 ? (
                    <SidebarMenuSubItem>
                      <span className="block px-2 py-1 text-xs text-muted-foreground">No Agents yet</span>
                    </SidebarMenuSubItem>
                  ) : null}
                  {catalog.status === "Failed" ? (
                    <SidebarMenuSubItem>
                      <span className="block px-2 py-1 text-xs text-muted-foreground">Agents unavailable</span>
                    </SidebarMenuSubItem>
                  ) : null}
                  {catalog.status === "Loading" ? (
                    <SidebarMenuSubItem>
                      <span className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
                        <LoaderCircle className="size-3.5 animate-spin" />
                        Loading Agents
                      </span>
                    </SidebarMenuSubItem>
                  ) : null}
                </SidebarMenuSub>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      {/* Pinned below the Agents, which scroll above it: what Agents are made from and run on. */}
      <SidebarFooter>
        <SidebarGroup className="p-0">
          <SidebarGroupLabel>Configure</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={manifestsActive} tooltip="Agent manifests">
                  <Link to={manifestPath()}>
                    <Files />
                    <span>Manifests</span>
                    {catalog.status === "Ready" && !catalog.manifestsError ? (
                      <span className="tabular-nums text-sidebar-foreground/70">
                        ({catalog.manifests.length})
                      </span>
                    ) : null}
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
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
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarFooter>
    </Sidebar>
  );
}
