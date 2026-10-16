import { Link } from "react-router-dom";
import type { AgentView } from "@nylorun/agents";
import {
  Bot,
  Building2,
  Cpu,
  FileJson,
  Files,
  LoaderCircle,
  MessagesSquare,
  Plus,
} from "lucide-react";
import type { Connection } from "@/studio-types";
import { shortTenantId, type StudioTenantInfo } from "@/config";
import { embedded } from "@/embed/index.ts";
import { useStartSession } from "@/components/new-session";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { sessionsPath } from "@/session-list";
import { agentGroups, agentsPath, stateLabel, type AgentGroup } from "@/agent-list";
import { agentPath, manifestPath } from "@/agent-path";
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

/** One manifest under Agents, which filters the list to it, then its Agents, each to its page. */
function AgentGroupItems({
  group,
  activeAgentId,
  activeManifest,
}: Readonly<{ group: AgentGroup; activeAgentId?: string; activeManifest?: string }>) {
  return (
    <>
      <SidebarMenuSubItem>
        <SidebarMenuSubButton asChild isActive={group.name === activeManifest} size="sm">
          <Link to={agentsPath({ manifest: group.name })} title={group.name}>
            <FileJson />
            <span className="min-w-0 flex-1 truncate">{group.name}</span>
            <span className="ml-auto shrink-0 text-xs tabular-nums text-sidebar-foreground/70">
              {group.agents.length}
            </span>
          </Link>
        </SidebarMenuSubButton>
      </SidebarMenuSubItem>
      {group.agents.map((agent) => (
        <SidebarMenuSubItem key={agent.id}>
          <SidebarMenuSubButton asChild isActive={agent.id === activeAgentId} size="sm" className="pl-6">
            <Link to={agentPath(agent.id)} title={`${agent.id} · ${stateLabel(agent.state)}`}>
              <span className={"size-1.5 shrink-0 rounded-full " + stateDot(agent.state)} aria-hidden />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{agent.id}</span>
              <span className="ml-auto shrink-0 text-xs tabular-nums text-sidebar-foreground/70">
                {agent.sessions.length}
              </span>
            </Link>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ))}
    </>
  );
}

/** Starts a session on the Agent picked from its menu, grouped by manifest, from any page. */
function NewSessionItem({ groups }: Readonly<{ groups: readonly AgentGroup[] }>) {
  const start = useStartSession();
  const withAgents = groups.filter((group) => group.agents.length > 0);
  return (
    <SidebarMenuItem className="pt-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            tooltip="New session"
            disabled={withAgents.length === 0}
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
          {withAgents.map((group, index) => (
            <AgentMenuGroup key={group.name} group={group} separated={index > 0} onPick={start} />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}

function AgentMenuGroup({
  group,
  separated,
  onPick,
}: Readonly<{ group: AgentGroup; separated: boolean; onPick: (agent: AgentView) => void }>) {
  return (
    <>
      {separated ? <DropdownMenuSeparator /> : null}
      <DropdownMenuLabel className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
        <FileJson className="size-3.5" />
        {group.name}
      </DropdownMenuLabel>
      {group.agents.map((agent) => {
        const unavailable = agentUnavailable(agent, STUDIO_OWNER);
        return (
          <DropdownMenuItem
            key={agent.id}
            disabled={unavailable !== undefined}
            title={unavailable}
            onSelect={() => onPick(agent)}
          >
            <Bot />
            <span className="truncate font-mono text-xs">{agent.id}</span>
          </DropdownMenuItem>
        );
      })}
    </>
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
  sessionsActive,
  agentsActive,
  manifestsActive,
  activeAgentId,
  activeManifest,
  settingsSection,
}: Readonly<{
  connection: Connection;
  tenant?: StudioTenantInfo;
  catalog: AgentCatalog;
  /** The session list is open. */
  sessionsActive?: boolean;
  /** The Agents list, an Agent's page or one of its sessions is open. */
  agentsActive?: boolean;
  /** The agent manifests or one manifest's page is open. */
  manifestsActive?: boolean;
  /** The open Agent, or the open session's. */
  activeAgentId?: string;
  /** The manifest the Agents list is filtered on. */
  activeManifest?: string;
  settingsSection?: SettingsSection;
}>) {
  const groups = agentGroups(catalog.manifests, catalog.agents);
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
          <NewSessionItem groups={groups} />
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={sessionsActive} tooltip="Sessions">
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
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={agentsActive && activeAgentId === undefined && activeManifest === undefined}
                  tooltip="Agents"
                >
                  <Link to={agentsPath()}>
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
                  {groups.map((group) => (
                    <AgentGroupItems
                      key={group.name}
                      group={group}
                      {...(agentsActive && activeAgentId !== undefined ? { activeAgentId } : {})}
                      {...(agentsActive && activeManifest !== undefined ? { activeManifest } : {})}
                    />
                  ))}
                  {catalog.status === "Ready" && groups.length === 0 ? (
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
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={manifestsActive} tooltip="Agent manifests">
                  <Link to={manifestPath()}>
                    <Files />
                    <span>Agent manifests</span>
                    {catalog.status === "Ready" && !catalog.manifestsError ? (
                      <span className="tabular-nums text-sidebar-foreground/70">
                        ({catalog.manifests.length})
                      </span>
                    ) : null}
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      {/* Pinned below the Agents, which scroll above it. */}
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
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarFooter>
    </Sidebar>
  );
}
