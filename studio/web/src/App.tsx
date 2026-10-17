import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Link,
  Navigate,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { Tabs as TabsPrimitive } from "radix-ui";
import { ArrowDown, PanelRight, RefreshCw } from "lucide-react";
import { Agents } from "@/components/agents";
import { useAgentCatalog } from "@/resources/agents";
import { agentFilter as agentListFilter } from "@/agent-list";
import { AgentPage } from "@/components/agent-page";
import { AgentManifestPage, AgentManifests } from "@/components/agent-manifests";
import { SessionAgentPanel } from "@/components/session-agent";
import { Artifacts, SessionArtifacts } from "@/components/artifacts";
import { artifactReferences } from "@/resources/artifacts";
import { AppSidebar } from "@/components/app-sidebar";
import {
  SETTINGS_SECTIONS,
  TenantSettings,
  settingsSection as settingsSectionOf,
} from "@/components/tenant-settings";
import { TenantOverview } from "@/components/tenant-overview";
import { SessionsTable } from "@/components/sessions-table";
import { ViewErrorBoundary } from "@/components/view-error-boundary";
import { AgentManifestPanel } from "@/components/agent-manifest-panel";
import { EventDetails } from "@/components/event-details";
import { EventTable } from "@/components/event-table";
import { IterationTimeline } from "@/components/iteration-timeline";
import { SessionComposer } from "@/components/session-composer";
import { SessionUsage } from "@/components/session-usage";
import { fullTime, shortTime } from "@/time-format";
import { AttachmentPreview } from "@/components/attachment-preview";
import { ToolTraceBadges } from "@/components/tool-trace";
import type { ComposerAttachment } from "@/attachments";
import { HeaderSlot, HeaderSlotContext } from "@/components/header-slot";
import { SessionIdCopy, SessionStatus } from "@/components/session-meta";
import { Separator } from "@/components/ui/separator";
import { useStickToBottom } from "@/hooks/use-stick-to-bottom";
import { WorkflowLinkBanner } from "@/components/workflow-link-banner";
import { WorkflowTree } from "@/components/workflow-tree";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  toolLabel,
  toolTrace,
  agentOf,
  eventLabel,
  mergeStudioEvents,
  type StudioEvent,
} from "@/event-presentation";
import { trackPageView } from "@/analytics";
import { type StudioTenantInfo } from "@/config";
import {
  embedSession,
  embedded,
  onEmbedNavigate,
  postToEmbedder,
} from "@/embed/index.ts";
import {
  EmbedSessionUnavailableError,
  type EmbedStatus,
} from "@/embed/session.ts";
import {
  StudioSignedOutError,
  createTenantClient,
  decodeSegment,
  fetchHello,
  tenantHref,
  tenantScope,
} from "@/proxy-client";
import { AGENT_FILTER, loadSessions } from "@/session-list";
import {
  STUDIO_OWNER,
  isNewSessionState,
  loadSessionDefinition,
} from "@/session-open";
import {
  agentPath,
  agentRoute,
  legacyRedirect as legacyRedirectOf,
  manifestRoute,
} from "@/agent-path";
import type { PinnedManifestState } from "@/manifest/model";
import { ApprovalCard } from "@/components/approval-card";
import { Markdown } from "@/components/markdown";
import { pendingApprovals } from "@/approvals";
import type { AgentManifest, Connection } from "@/studio-types";
import {
  isWorkflowManifest,
  iterationTimelineFromEvents,
  linksFromEvents,
  liveStatusFromEvents,
  lookupWorkflowLink,
  rememberWorkflowLinks,
  treeFromManifest,
  type IterationRecord,
  type WorkflowTreeNode,
} from "@/workflow";

export type { AgentManifest, Connection, SessionSummary } from "@/studio-types";

function studioClient(tenantId: string) {
  return createTenantClient(tenantId);
}

type BootState =
  | { kind: "booting" }
  | { kind: "signed-out" }
  | { kind: "waiting-for-app" }
  | { kind: "unreachable"; message: string }
  | { kind: "runtime-incompatible"; message: string }
  | { kind: "tenant-unavailable"; message: string }
  | { kind: "ready"; tenant: StudioTenantInfo };

function StatusScreen({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-svh w-full max-w-lg flex-col justify-center gap-4 p-8">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <div className="space-y-3 text-muted-foreground">{children}</div>
    </main>
  );
}
const pretty = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);

const code =
  "rounded bg-muted px-1.5 py-0.5 font-mono text-sm text-foreground";

/** The tabs beside a session's chat; `artifacts` is the Artifacts tab, `agent` where it runs. */
type InspectorTab =
  | "events"
  | "manifest"
  | "tree"
  | "iterations"
  | "artifacts"
  | "agent"
  | "usage";

/** Where Studio remembers whether the session inspector is shown. */
const INSPECTOR_STORAGE_KEY = "nylorun.studio.inspector";

function inspectorShownAtFirst(): boolean {
  try {
    return window.localStorage.getItem(INSPECTOR_STORAGE_KEY) !== "hidden";
  } catch {
    return true;
  }
}

function rememberInspector(shown: boolean): void {
  try {
    window.localStorage.setItem(INSPECTOR_STORAGE_KEY, shown ? "shown" : "hidden");
  } catch {
    /* Storage is optional: the toggle still works for this page. */
  }
}

/** A chat message's time, shown while the message is hovered or focused. */
function MessageTime({ value }: { value: string }) {
  return (
    <time
      dateTime={value}
      title={fullTime(value)}
      className="text-xs tabular-nums text-muted-foreground opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
    >
      {shortTime(value)}
    </time>
  );
}

const tabTrigger =
  "border-b-2 border-transparent px-0 pb-3 text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground";

/**
 * Studio serves its installation's one Tenant. `/tenants/<id>/…` is its
 * dashboard, with the router based at `/tenants/<id>` so its routes
 * (`/agents/…`, `/agent-manifests/…`, `/settings`) stay Tenant-relative. The server
 * redirects `/` there.
 */
export default function App() {
  const scope = tenantScope(window.location.pathname);
  return (
    <BrowserRouter basename={scope?.basename ?? "/"}>
      {embedded() ? <EmbedRouteSync basename={scope?.basename ?? ""} /> : null}
      <PageViews basename={scope?.basename ?? ""} />
      <Routes>
        <Route path="*" element={<StudioRoot tenantId={scope?.tenantId} />} />
      </Routes>
    </BrowserRouter>
  );
}

/** Reports each route as a page view (a no-op while analytics is off). */
function PageViews({ basename }: { basename: string }) {
  const location = useLocation();
  useEffect(() => {
    trackPageView(`${basename}${location.pathname}`);
  }, [basename, location.pathname]);
  return null;
}

/** The embed session's status, re-rendered on change (always "ready" outside embed mode). */
function useEmbedStatus(): EmbedStatus {
  const session = embedSession();
  const [status, setStatus] = useState<EmbedStatus>(session?.status() ?? "ready");
  useEffect(() => session?.subscribe(setStatus), [session]);
  return status;
}

/**
 * Embed mode: reports every route to the embedder (`route.changed`) and follows
 * its `navigate`. A route outside this Tenant is refused: Studio serves one.
 */
function EmbedRouteSync({ basename }: { basename: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const status = useEmbedStatus();
  // Posting needs the embedder's origin, known once `init` arrived: report the
  // route again when the session is ready.
  useEffect(() => {
    if (status !== "ready") return;
    const path = location.pathname === "/" ? "" : location.pathname;
    postToEmbedder({ kind: "route.changed", route: `${basename}${path}` || "/" });
  }, [basename, location.pathname, status]);
  useEffect(
    () =>
      onEmbedNavigate((route) => {
        if (basename === "" || (route !== basename && !route.startsWith(`${basename}/`))) {
          postToEmbedder({
            kind: "error",
            code: "route_other_tenant",
            message: "This Studio serves only its installation's Tenant.",
          });
          return;
        }
        void navigate(route.slice(basename.length) || "/");
      }),
    [basename, navigate],
  );
  return null;
}

function StudioRoot({ tenantId }: { tenantId?: string }) {
  const location = useLocation();
  const [boot, setBoot] = useState<BootState>({ kind: "booting" });
  const [attempt, setAttempt] = useState(0);
  const embedStatus = useEmbedStatus();
  // A session that arrives after Studio gave up waiting starts it again.
  useEffect(() => {
    if (embedStatus === "ready" && boot.kind === "waiting-for-app")
      setAttempt((value) => value + 1);
  }, [embedStatus, boot.kind]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const hello = await fetchHello();
        if (cancelled) return;
        if (!hello.runtime.compatible) {
          setBoot({
            kind: "runtime-incompatible",
            message:
              hello.runtime.message ??
              "The Runtime is incompatible with this Studio.",
          });
          return;
        }
        const tenant = hello.tenant;
        if (tenant.state !== "open" || tenant.id === null) {
          setBoot({
            kind: "tenant-unavailable",
            message: tenant.message ?? "The Tenant is unavailable.",
          });
          return;
        }
        setBoot({
          kind: "ready",
          tenant: { id: tenant.id, name: tenant.name ?? tenant.id },
        });
      } catch (cause) {
        if (cancelled) return;
        if (cause instanceof EmbedSessionUnavailableError)
          setBoot({ kind: "waiting-for-app" });
        else if (cause instanceof StudioSignedOutError)
          setBoot({ kind: "signed-out" });
        else
          setBoot({
            kind: "unreachable",
            message: cause instanceof Error ? cause.message : String(cause),
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (boot.kind === "booting") {
    // Embedded, the shell shows nothing until the app has signed it in.
    if (embedded()) return <main className="min-h-svh" aria-busy="true" />;
    return (
      <StatusScreen title="Connecting to Studio">
        <p>Checking the Studio session…</p>
      </StatusScreen>
    );
  }
  if (boot.kind === "waiting-for-app") {
    return (
      <StatusScreen title="Waiting for the app">
        <p>Studio has not been signed in by the app that shows it.</p>
        <Button variant="outline" onClick={() => embedSession()?.retry()}>
          Try again
        </Button>
      </StatusScreen>
    );
  }
  if (boot.kind === "signed-out") {
    return (
      <StatusScreen title="Sign in to Studio">
        <p>
          Run <code className={code}>npx nylorun studio</code> in a terminal.
          It opens Studio here, signed in for 30 days.
        </p>
      </StatusScreen>
    );
  }
  if (boot.kind === "unreachable") {
    return (
      <StatusScreen title="Studio is unavailable">
        <p>{boot.message}</p>
        <p>
          Check the Tenant with <code className={code}>nylorun status</code>.
        </p>
      </StatusScreen>
    );
  }
  if (boot.kind === "runtime-incompatible") {
    return (
      <StatusScreen title="Runtime incompatible">
        <p>{boot.message}</p>
      </StatusScreen>
    );
  }
  if (boot.kind === "tenant-unavailable") {
    return (
      <StatusScreen title="Tenant unavailable">
        <p>{boot.message}</p>
        <p>
          Check the Tenant with <code className={code}>npx nylorun status</code>.
        </p>
        <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
          Try again
        </Button>
      </StatusScreen>
    );
  }
  const tenant = boot.tenant;
  if (tenantId === undefined) return <OpenTenant tenant={tenant} />;
  if (tenantId !== tenant.id) {
    return (
      <StatusScreen title="Tenant not found">
        <p>
          This Studio serves the Tenant{" "}
          <code className={code}>{tenant.name}</code>, not{" "}
          <code className={code}>{tenantId}</code>.
        </p>
        {embedded() ? null : (
          <p>
            <a className="text-primary underline" href={tenantHref(tenant.id)}>
              Open {tenant.name}
            </a>
          </p>
        )}
      </StatusScreen>
    );
  }
  // A failed Workspace takes its sidebar with it: the next route (back, or an
  // embedder's `navigate`) renders it again.
  return (
    <ViewErrorBoundary resetKey={location.pathname}>
      <Workspace tenant={tenant} />
    </ViewErrorBoundary>
  );
}

/**
 * A path outside `/tenants/<id>` (the server already redirects `/`): a browser
 * tab moves to the Tenant; an embedded Studio waits for the app to navigate.
 */
function OpenTenant({ tenant }: { tenant: StudioTenantInfo }) {
  useEffect(() => {
    if (!embedded()) window.location.replace(tenantHref(tenant.id));
  }, [tenant.id]);
  return embedded() ? (
    <StatusScreen title="No Tenant route">
      <p>
        Open Studio on <code className={code}>{tenantHref(tenant.id)}</code>{" "}
        from the app.
      </p>
    </StatusScreen>
  ) : (
    <main className="min-h-svh" aria-busy="true" />
  );
}

function Workspace({ tenant }: { tenant: StudioTenantInfo }) {
  const location = useLocation();
  const embedStatus = useEmbedStatus();
  const match = location.pathname.match(/^\/agents\/([^/]+)\/sessions\/([^/]+)\/?$/);
  const sessionOnly = location.pathname.match(/^\/sessions\/([^/]+)\/?$/);
  const agentId = match?.[1] ? decodeSegment(match[1]) : undefined;
  const sessionId = match?.[2] ? decodeSegment(match[2]) : undefined;
  const redirectSessionId = sessionOnly?.[1] ? decodeSegment(sessionOnly[1]) : undefined;
  // A segment that is no valid percent-encoding (`%E0`) names no Agent or
  // session: the view says "not found" instead of throwing a URIError.
  const sessionSegment = match?.[2] ?? sessionOnly?.[1];
  const notFound: RouteNotFoundProps | undefined =
    sessionSegment && (sessionId ?? redirectSessionId) === undefined
      ? { what: "session", segment: sessionSegment }
      : match?.[1] && agentId === undefined
        ? { what: "agent", segment: match[1] }
        : undefined;
  const [connection, setConnection] = useState<Connection>({
    status: "Connecting",
    sessions: [],
  });
  const [error, setError] = useState("");
  const [headerStart, setHeaderStart] = useState<HTMLDivElement | null>(null);
  const [headerEnd, setHeaderEnd] = useState<HTMLDivElement | null>(null);
  const headerSlots = useMemo(
    () => ({ start: headerStart, end: headerEnd }),
    [headerStart, headerEnd],
  );
  const catalog = useAgentCatalog(tenant.id);
  const { reload: reloadCatalog } = catalog;
  const loadList = useCallback(async () => {
    try {
      const sessions = await loadSessions(studioClient(tenant.id));
      setConnection({ status: "Running", url: "Runtime", sessions });
      setError("");
    } catch (e) {
      setError(String(e));
      setConnection((c) => ({ ...c, status: "Offline" }));
    }
  }, [tenant.id]);
  // The sessions and the Agents, whose states a turn changes.
  const refresh = useCallback(async () => {
    reloadCatalog();
    await loadList();
  }, [reloadCatalog, loadList]);
  useEffect(() => {
    void loadList();
  }, [loadList]);
  const waiting =
    connection.status === "Running" &&
    catalog.status === "Ready" &&
    catalog.agents.length === 0 &&
    connection.sessions.length === 0;
  // Until the first Agent is made, look for it every few seconds.
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [waiting, refresh]);
  // Old Environment, Credentials, vault and sandbox links open the Agent's page.
  const legacyRedirect = legacyRedirectOf(location.pathname, location.search);
  const agent = agentRoute(location.pathname);
  const manifest = manifestRoute(location.pathname);
  const resourceActive =
    agent !== undefined
      ? "agents"
      : manifest !== undefined
        ? "manifests"
        : location.pathname === "/artifacts"
          ? "artifacts"
          : undefined;
  const settingsActive = location.pathname === "/settings" ||
    location.pathname.startsWith("/settings/");
  const settingsSection = settingsSectionOf(location.pathname);
  // Each move to the Agents, an Agent's page or the manifests reads them again, so the lists
  // and the sidebar follow what was made, forked or deleted.
  const catalogLocation =
    agent === undefined && manifest === undefined ? undefined : location.pathname;
  const lastCatalogLocation = useRef(catalogLocation);
  useEffect(() => {
    const previous = lastCatalogLocation.current;
    lastCatalogLocation.current = catalogLocation;
    if (catalogLocation !== undefined && catalogLocation !== previous) reloadCatalog();
  }, [catalogLocation, reloadCatalog]);
  const filter = agentListFilter(location.search);
  const manifestVersion = Number(new URLSearchParams(location.search).get("version"));
  const sessionList = /^\/(?:sessions\/?)?$/u.test(location.pathname);
  const agentFilter =
    new URLSearchParams(location.search).get(AGENT_FILTER) || undefined;
  const openAgentId = agent?.kind === "agent" ? agent.id : agentId;
  // The sidebar's Agent: the one the session table is filtered on, or whose page or session is open.
  const sidebarAgentId = sessionList ? agentFilter : openAgentId;
  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <AppSidebar
        connection={connection}
        tenant={tenant}
        catalog={catalog}
        allSessionsActive={sessionList && agentFilter === undefined}
        manifestsActive={resourceActive === "manifests"}
        {...(sidebarAgentId === undefined ? {} : { activeAgentId: sidebarAgentId })}
        {...(settingsSection ? { settingsSection } : {})}
      />
      <SidebarInset className="flex h-svh min-h-0 min-w-0 flex-col overflow-hidden">
        <HeaderSlotContext.Provider value={headerSlots}>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-5" />
          <strong className="max-w-64 shrink-0 truncate">
            {resourceActive === "agents"
              ? agent?.kind === "agent"
                ? "Agent"
                : "Agents"
              : resourceActive === "manifests"
                ? manifest?.kind === "manifest"
                  ? "Agent manifest"
                  : "Agent manifests"
                : resourceActive === "artifacts"
                  ? "Artifacts"
                  : settingsSection
                    ? SETTINGS_SECTIONS[settingsSection]
                    : sessionList
                      ? "Sessions"
                      : (agentId ?? "Nylorun Studio")}
          </strong>
          <div ref={setHeaderStart} className="flex min-w-0 items-center gap-2 overflow-hidden" />
          {embedStatus === "reconnecting" || embedStatus === "failed" ? (
            <Badge variant="outline" role="status">
              {embedStatus === "reconnecting" ? "Reconnecting…" : "Disconnected"}
            </Badge>
          ) : null}
          <div ref={setHeaderEnd} className="ml-auto flex min-w-0 items-center gap-3" />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh"
            title="Refresh"
            onClick={() => void refresh()}
          >
            <RefreshCw />
          </Button>
        </header>
        {error && (
          <p role="alert" className="shrink-0 p-4 text-red-600">
            {error}
          </p>
        )}
        {/* One broken view shows an error panel; the sidebar and header stay. */}
        <ViewErrorBoundary resetKey={location.pathname}>
          {notFound ? (
            <RouteNotFound {...notFound} />
          ) : redirectSessionId !== undefined ? (
            <SessionRedirect tenantId={tenant.id} sessionId={redirectSessionId} />
          ) : legacyRedirect !== undefined ? (
            <Navigate to={`${legacyRedirect}${location.hash}`} replace />
          ) : location.pathname === "/settings" ? (
            <Navigate to={`/settings/models${location.search}${location.hash}`} replace />
          ) : agent?.kind === "invalid" ? (
            <RouteNotFound what="agent" segment={agent.segment} />
          ) : agent?.kind === "agent" ? (
            <AgentPage
              key={agent.id}
              tenantId={tenant.id}
              id={agent.id}
              sessions={connection.sessions}
              onChanged={reloadCatalog}
            />
          ) : agent?.kind === "list" ? (
            <Agents tenantId={tenant.id} catalog={catalog} sessions={connection.sessions} filter={filter} />
          ) : manifest?.kind === "invalid" ? (
            <RouteNotFound what="manifest" segment={manifest.segment} />
          ) : manifest?.kind === "manifest" ? (
            <AgentManifestPage
              key={manifest.id}
              tenantId={tenant.id}
              name={manifest.id}
              {...(Number.isSafeInteger(manifestVersion) && manifestVersion > 0 ? { version: manifestVersion } : {})}
              catalog={catalog}
            />
          ) : manifest?.kind === "list" ? (
            <AgentManifests catalog={catalog} />
          ) : resourceActive === "artifacts" ? (
            <Artifacts tenantId={tenant.id} />
          ) : settingsSection ? (
            <TenantSettings tenant={tenant} section={settingsSection} />
          ) : settingsActive ? (
            <Navigate to="/settings/overview" replace />
          ) : agentId && sessionId ? (
            <SessionWorkspace
              key={sessionId}
              routeAgentId={agentId}
              sessionId={sessionId}
              tenantId={tenant.id}
              refresh={refresh}
            />
          ) : sessionList ? (
            waiting ? (
              <TenantOverview tenant={tenant} waitingForAgents />
            ) : (
              <SessionsTable
                connection={connection}
                agents={catalog.agents}
                manifests={catalog.manifests}
                {...(agentFilter === undefined ? {} : { agentFilter })}
              />
            )
          ) : (
            <RouteNotFound what="page" segment={location.pathname} />
          )}
        </ViewErrorBoundary>
        </HeaderSlotContext.Provider>
      </SidebarInset>
    </SidebarProvider>
  );
}

type RouteNotFoundProps = {
  what: "agent" | "session" | "manifest" | "page";
  segment: string;
};

/** A route segment that names nothing (it does not decode). */
function RouteNotFound({ what, segment }: RouteNotFoundProps) {
  return (
    <section className="mx-auto w-full max-w-3xl flex-1 p-8">
      <h1 className="text-2xl font-semibold">
        {what === "agent"
          ? "Agent not found"
          : what === "session"
            ? "Session not found"
            : what === "manifest"
              ? "Agent manifest not found"
              : "Page not found"}
      </h1>
      <p className="mt-2 text-muted-foreground">
        This Tenant has no {what === "manifest" ? "agent manifest" : what === "agent" ? "Agent" : what}{" "}
        <code className={code}>{segment}</code>.
      </p>
    </section>
  );
}

/**
 * `/tenants/:tenant/sessions/:session` (Studio §8.3): finds the session's Agent
 * and replaces itself with the session's page under it. Embedders often know only
 * the session id.
 */
function SessionRedirect({
  tenantId,
  sessionId,
}: {
  tenantId: string;
  sessionId: string;
}) {
  const navigate = useNavigate();
  const { search, hash } = useLocation();
  const [problem, setProblem] = useState<string | undefined>();
  useEffect(() => {
    const abort = new AbortController();
    studioClient(tenantId)
      .session(sessionId)
      .inspect(abort.signal)
      .then((view) => {
        if (abort.signal.aborted) return;
        if (!view.agentId) return setProblem("not-found");
        void navigate(
          `/agents/${encodeURIComponent(view.agentId)}/sessions/${encodeURIComponent(sessionId)}${search}${hash}`,
          { replace: true },
        );
      })
      .catch((cause: unknown) => {
        if (abort.signal.aborted) return;
        if ((cause as { status?: unknown }).status === 404) return setProblem("not-found");
        setProblem(cause instanceof Error ? cause.message : String(cause));
      });
    return () => abort.abort();
  }, [tenantId, sessionId, navigate, search, hash]);
  if (problem === undefined)
    return <p className="p-8 text-muted-foreground">Opening the session…</p>;
  return (
    <section className="mx-auto w-full max-w-3xl flex-1 p-8">
      <h1 className="text-2xl font-semibold">
        {problem === "not-found" ? "Session not found" : "Session unavailable"}
      </h1>
      <p className="mt-2 text-muted-foreground">
        {problem === "not-found" ? (
          <>
            This Tenant has no session <code className={code}>{sessionId}</code>.
          </>
        ) : (
          problem
        )}
      </p>
    </section>
  );
}

type SessionLoad =
  | { kind: "loading" }
  | {
      kind: "ready";
      agentId: string;
      definition: AgentManifest;
      pinned: PinnedManifestState;
      hasSandbox: boolean;
    }
  | { kind: "not-found" }
  | { kind: "failed"; message: string };

/**
 * Opens a session by reading it. Only Studio's own "New session" creates one, on
 * the Agent its route names: a PUT with Studio's parameters would answer 409 for
 * a session an application created with another owner, Agent or info. What it
 * runs is the loop manifest it pinned.
 */
function SessionWorkspace({
  routeAgentId,
  sessionId,
  tenantId,
  refresh,
}: {
  routeAgentId: string;
  sessionId: string;
  tenantId: string;
  refresh: () => Promise<void>;
}) {
  const location = useLocation();
  const create = isNewSessionState(location.state);
  const [load, setLoad] = useState<SessionLoad>({ kind: "loading" });
  useEffect(() => {
    const abort = new AbortController();
    const sdk = studioClient(tenantId);
    void (async () => {
      let agentId: string;
      try {
        agentId = (await sdk.session(sessionId).inspect(abort.signal)).agentId;
      } catch (cause) {
        if ((cause as { status?: unknown }).status !== 404) throw cause;
        if (!create) {
          if (!abort.signal.aborted) setLoad({ kind: "not-found" });
          return;
        }
        await sdk.createSession({
          id: sessionId,
          agent: routeAgentId,
          ownerUserId: STUDIO_OWNER,
        });
        agentId = routeAgentId;
      }
      const [{ definition, pinned }, hasSandbox] = await Promise.all([
        loadSessionDefinition(sdk, sessionId, agentId, abort.signal),
        // An Agent that cannot be read, such as a deleted one, counts as a sandbox.
        sdk.agents.get(agentId, { signal: abort.signal }).then(
          (found) => found.kind !== "none",
          () => true,
        ),
      ]);
      if (!abort.signal.aborted)
        setLoad({ kind: "ready", agentId, definition, pinned, hasSandbox });
    })().catch((cause: unknown) => {
      if (!abort.signal.aborted)
        setLoad({
          kind: "failed",
          message: cause instanceof Error ? cause.message : String(cause),
        });
    });
    return () => abort.abort();
  }, [tenantId, sessionId, routeAgentId, create]);

  if (load.kind === "loading")
    return <p className="p-8 text-muted-foreground">Opening the session…</p>;
  if (load.kind !== "ready")
    return (
      <section className="mx-auto w-full max-w-3xl flex-1 p-8">
        <h1 className="text-2xl font-semibold">
          {load.kind === "not-found" ? "Session not found" : "Session unavailable"}
        </h1>
        <p role="alert" className="mt-2 text-muted-foreground">
          {load.kind === "not-found" ? (
            <>
              This Tenant has no session <code className={code}>{sessionId}</code>.
            </>
          ) : (
            load.message
          )}
        </p>
      </section>
    );
  return (
    <SessionView
      agent={load.definition}
      agentId={load.agentId}
      pinned={load.pinned}
      hasSandbox={load.hasSandbox}
      sessionId={sessionId}
      tenantId={tenantId}
      refresh={refresh}
    />
  );
}

function SessionView({
  agent,
  agentId,
  pinned,
  hasSandbox,
  sessionId,
  tenantId,
  refresh,
}: {
  /** What the session runs: the loop manifest it pinned. */
  agent: AgentManifest;
  /** The Agent it runs on. */
  agentId: string;
  pinned: PinnedManifestState;
  hasSandbox: boolean;
  sessionId: string;
  tenantId?: string;
  refresh: () => Promise<void>;
}) {
  const workflowManifest = isWorkflowManifest(agent.manifest)
    ? agent.manifest
    : undefined;
  const isWorkflow = workflowManifest !== undefined;
  const [events, setEvents] = useState<readonly StudioEvent[]>([]);
  const [content, setContent] = useState("");
  const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>([]);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [activeTab, setActiveTab] = useState<InspectorTab>(isWorkflow ? "tree" : "events");
  const [selectedEvent, setSelectedEvent] = useState<StudioEvent | undefined>();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [inspectorShown, setInspectorShown] = useState(inspectorShownAtFirst);
  const toggleInspector = (): void => {
    setInspectorShown((shown) => {
      rememberInspector(!shown);
      return !shown;
    });
  };
  const [selectedNode, setSelectedNode] = useState<WorkflowTreeNode | undefined>();
  const [selectedIteration, setSelectedIteration] = useState<
    IterationRecord | undefined
  >();
  const workflowLink = lookupWorkflowLink(sessionId);
  const [sessionQuery, setSessionQuery] = useSearchParams();
  useEffect(() => {
    const asked = sessionQuery.get("inspector");
    // `environment` named the session's Environment tab before protocol 16.
    const tab = asked === "environment" ? "agent" : asked;
    setActiveTab(
      tab === "artifacts" ||
        tab === "events" ||
        tab === "agent" ||
        tab === "manifest" ||
        tab === "usage" ||
        (isWorkflow && (tab === "tree" || tab === "iterations"))
        ? tab
        : isWorkflow
          ? "tree"
          : "events",
    );
  }, [sessionQuery, isWorkflow]);
  function openArtifact(id: string, version: number) {
    const query = new URLSearchParams(sessionQuery);
    query.set("inspector", "artifacts");
    query.set("artifact", id);
    query.set("artifactVersion", String(version));
    query.set("artifactTab", "preview");
    query.delete("artifactFile");
    setSessionQuery(query);
  }

  useEffect(() => {
    if (!tenantId) {
      setError("Studio is missing a Tenant id.");
      return;
    }
    const abort = new AbortController();
    const sdk = studioClient(tenantId);
    const current = sdk.session(sessionId);
    void (async () => {
      const history = await current.history({ signal: abort.signal });
      if (abort.signal.aborted) return;
      const loaded = mergeStudioEvents(
        [],
        history.items.map((event) => ({ ...event, committed: true })),
      );
      setEvents(loaded);
      if (isWorkflow) {
        rememberWorkflowLinks(
          linksFromEvents(loaded, sessionId, { workflowAgentId: agentId }),
        );
      }
      const inspect = await current.inspect(abort.signal);
      setStatus(inspect.status);
      await refresh();
      for await (const event of current.observe({
        cursor: history.cursor ?? undefined,
        signal: abort.signal,
      })) {
        setEvents((previous) => {
          const next = mergeStudioEvents(previous, [
            { ...event, committed: false },
          ]);
          if (isWorkflow) {
            rememberWorkflowLinks(
              linksFromEvents(next, sessionId, { workflowAgentId: agentId }),
            );
          }
          return next;
        });
        if (event.type.startsWith("turn.")) {
          setStatus(event.type.slice(5));
          void refresh();
        } else if (event.type === "command.message") setStatus("running");
      }
    })().catch((e) => {
      if (!abort.signal.aborted) setError(String(e));
    });
    return () => abort.abort();
  }, [sessionId, agentId, refresh, tenantId, isWorkflow]);

  useEffect(() => {
    setSelectedEvent(undefined);
    setDetailsOpen(false);
    setSelectedNode(undefined);
    setSelectedIteration(undefined);
    // An uploaded attachment belongs to its session.
    setAttachments([]);
  }, [sessionId, isWorkflow]);

  const {
    scroller: chatScroller,
    content: chatContent,
    atBottom: atLatest,
    scrollToBottom: scrollToLatest,
  } = useStickToBottom(sessionId);

  const busy =
    sending || ["loading", "running", "runnable", "waiting"].includes(status);
  // Tool calls the Tool Gate holds for a person (R5 step 2).
  const approvals = useMemo(() => pendingApprovals(events), [events]);

  const attach = useCallback((files: readonly File[]) => {
    setAttachments((previous) => [
      ...previous,
      ...files.map((file) => ({ id: crypto.randomUUID(), file })),
    ]);
  }, []);
  const removeAttachment = useCallback((id: string) => {
    setAttachments((previous) => previous.filter((item) => item.id !== id));
  }, []);
  const markAttachment = (id: string, change: Partial<ComposerAttachment>) =>
    setAttachments((previous) =>
      previous.map((item) => (item.id === id ? { ...item, ...change } : item)),
    );

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!tenantId || (!content.trim() && attachments.length === 0) || busy) return;
    scrollToLatest();
    setSending(true);
    setStatus("running");
    setError("");
    const sdk = studioClient(tenantId);
    const session = sdk.session(sessionId);
    try {
      // Each file once: a resend after a refusal names the artifacts already uploaded.
      const files: { artifactId: string; version: number }[] = [];
      for (const attachment of attachments) {
        let uploaded = attachment.uploaded;
        if (!uploaded) {
          try {
            const reply = await sdk.artifacts.upload(attachment.file, {
              name: attachment.file.name,
              sessionId,
              contentType: attachment.file.type || "application/octet-stream",
            });
            uploaded = { artifactId: reply.artifact.artifactId, version: reply.version.version };
            markAttachment(attachment.id, { uploaded, error: undefined });
          } catch (cause) {
            markAttachment(attachment.id, { error: "Upload failed" });
            throw cause;
          }
        } else if (attachment.error) markAttachment(attachment.id, { error: undefined });
        files.push(uploaded);
      }
      const idempotencyKey = crypto.randomUUID();
      if (files.length === 0) await session.input(content, { idempotencyKey });
      else
        await session.inputParts(
          [
            ...(content.trim() ? [{ type: "text" as const, text: content }] : []),
            ...files.map((file) => ({ type: "file" as const, ...file })),
          ],
          { idempotencyKey },
        );
      setContent("");
      setAttachments([]);
    } catch (e) {
      // The draft stays, with its uploaded files, to send again.
      setError(String(e));
      try {
        setStatus((await session.inspect()).status);
      } catch {
        setStatus("idle");
      }
    } finally {
      setSending(false);
    }
  }

  function stop() {
    if (!tenantId) return;
    void studioClient(tenantId)
      .session(sessionId)
      .cancel({ idempotencyKey: crypto.randomUUID() })
      .catch((e) => setError(String(e)));
  }

  if (!tenantId) {
    return (
      <p role="alert" className="p-4 text-red-600">
        Studio is missing a Tenant id.
      </p>
    );
  }

  const openEvent = (event: StudioEvent): void => {
    setSelectedEvent(event);
    setDetailsOpen(true);
  };
  const changeTab = (value: string): void => {
    const nextTab = value as InspectorTab;
    setActiveTab(nextTab);
    const query = new URLSearchParams(sessionQuery);
    query.set("inspector", nextTab);
    setSessionQuery(query);
    if (nextTab !== "events") setDetailsOpen(false);
  };
  const showDetails =
    inspectorShown && activeTab === "events" && detailsOpen && selectedEvent !== undefined;

  const chronological = [...events].reverse();
  const liveByPath = liveStatusFromEvents(chronological);
  const tree =
    workflowManifest !== undefined
      ? treeFromManifest(workflowManifest)
      : undefined;
  const iterations =
    workflowManifest !== undefined
      ? iterationTimelineFromEvents(chronological)
      : [];

  // Newest-first in the Events table; chat stays chronological.
  const chatEvents = chronological;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {workflowLink && !workflowManifest ? (
        <WorkflowLinkBanner link={workflowLink} />
      ) : null}
      <ResizablePanelGroup
        orientation="horizontal"
        className="min-h-0 flex-1 overflow-hidden"
      >
      <ResizablePanel id="chat" defaultSize={!inspectorShown ? 100 : showDetails ? 34 : 42} minSize={28}>
        <section className="flex h-full min-h-0 flex-col overflow-hidden">
          <HeaderSlot side="start">
            <SessionIdCopy id={sessionId} />
            <SessionStatus status={status} />
            {workflowManifest ? (
              <Badge variant="secondary">workflow</Badge>
            ) : null}
          </HeaderSlot>
          <HeaderSlot side="end">
            <Link
              className="hidden max-w-56 truncate whitespace-nowrap text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline lg:inline"
              to={agentPath(agentId)}
              title={agentId}
            >
              Agent: {agentId}
            </Link>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={inspectorShown ? "Hide inspector" : "Show inspector"}
              aria-pressed={inspectorShown}
              title={inspectorShown ? "Hide inspector" : "Show inspector"}
              onClick={toggleInspector}
            >
              <PanelRight />
            </Button>
          </HeaderSlot>
          <div ref={chatScroller} className="min-h-0 flex-1 overflow-auto">
            <div ref={chatContent} className="space-y-4 p-4">
              {chatEvents.map((event) => {
                const payload = event.payload as Record<string, unknown>;
                const references = artifactReferences(event);
                const referenceLinks = references.map((ref) => (
                  <Button
                    key={`${ref.artifactId}:${ref.version}`}
                    size="sm"
                    variant="outline"
                    className="m-1 max-w-full whitespace-normal break-all"
                    onClick={() => openArtifact(ref.artifactId, ref.version)}
                  >
                    {ref.name} · v{ref.version}
                  </Button>
                ));
                if (event.type.startsWith("artifact.") && references.length)
                  return (
                    <div key={event.eventId} className="rounded border p-3">
                      <p className="text-xs text-muted-foreground">Artifact</p>
                      {referenceLinks}
                    </div>
                  );

                if (event.type === "command.message")
                  return (
                    <article
                      key={event.eventId}
                      className="group ml-8 rounded-xl bg-muted p-4"
                    >
                      <p className="mb-1 flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
                        You
                        <MessageTime value={event.time} />
                      </p>
                      {String(payload.content ?? "")}
                      {Array.isArray(payload.parts)
                        ? payload.parts.map((part, i) =>
                            typeof part === "object" &&
                            part !== null &&
                            part.type === "text" ? (
                              <p key={i} className="whitespace-pre-wrap">{String(part.text)}</p>
                            ) : null,
                          )
                        : null}
                      {references.length ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {references.map((ref) => (
                            <AttachmentPreview
                              key={`${ref.artifactId}:${ref.version}`}
                              tenantId={tenantId}
                              artifactId={ref.artifactId}
                              version={ref.version}
                              name={ref.name}
                              onOpen={() => openArtifact(ref.artifactId, ref.version)}
                            />
                          ))}
                        </div>
                      ) : null}

                    </article>
                  );
                if (event.type === "turn.completed")
                  return (
                    <article
                      key={event.eventId}
                      className="group mr-8 rounded-xl border p-4"
                    >
                      <p className="mb-1 flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
                        Assistant
                        <MessageTime value={event.time} />
                      </p>
                      {typeof payload.output === "string" ? (
                        <Markdown>{payload.output}</Markdown>
                      ) : (
                        <pre className="whitespace-pre-wrap font-sans">
                          {pretty(payload.output)}
                        </pre>
                      )}
                    </article>
                  );
                if (
                  ["delegation.started", "delegation.completed"].includes(
                    event.type,
                  )
                )
                  return (
                    <details
                      key={event.eventId}
                      className="rounded-lg border border-dashed p-3"
                      open={event.type === "delegation.completed"}
                    >
                      <summary className="cursor-pointer text-sm font-medium">
                        {eventLabel(event)} · {agentOf(payload)?.id}
                      </summary>
                      <pre className="mt-2 overflow-auto whitespace-pre-wrap text-xs">
                        {pretty(
                          event.type === "delegation.started"
                            ? payload.task
                            : payload.outcome,
                        )}
                      </pre>
                    </details>
                  );
                if (event.type === "tool.completed")
                  return (
                    <details
                      key={event.eventId}
                      className={
                        agentOf(payload)
                          ? "ml-6 rounded-lg border p-3"
                          : "rounded-lg border p-3"
                      }
                    >
                      <summary className="cursor-pointer text-sm font-medium">
                        <span className="inline-flex flex-wrap items-center gap-1.5 align-middle">
                          <span>
                            {toolLabel(payload)}
                            {payload.error ? " · failed" : ""}
                          </span>
                          <ToolTraceBadges trace={toolTrace(payload)} />
                        </span>
                      </summary>
                      <pre className="mt-2 overflow-auto whitespace-pre-wrap text-xs">
                        {pretty(payload.error ?? payload.output)}
                      </pre>
                      {/* The artifacts the harness stored the result in (protocol 15). */}
                      {referenceLinks.length ? <div className="mt-2">{referenceLinks}</div> : null}
                    </details>
                  );
                if (
                  ["turn.failed", "turn.cancelled", "turn.uncertain"].includes(
                    event.type,
                  )
                )
                  return (
                    <p
                      key={event.eventId}
                      className="text-sm text-muted-foreground"
                    >
                      {event.type}: {pretty(payload)}
                    </p>
                  );
                return null;
              })}
              {status === "paused" &&
                approvals.map((approval) => (
                  <ApprovalCard
                    key={approval.id}
                    approval={approval}
                    answer={async (approved) => {
                      await studioClient(tenantId)
                        .session(sessionId)
                        .approve(approval.id, approved, { idempotencyKey: crypto.randomUUID() });
                      setStatus("running");
                    }}
                  />
                ))}
              {["paused", "uncertain"].includes(status) && approvals.length === 0 && (
                <p className="rounded border p-3 text-sm">
                  This session needs attention. This release supports text and
                  ordinary tools; advanced waits and reconciliation are not
                  available in Studio.
                </p>
              )}
              {error && (
                <p role="alert" className="text-red-600">
                  {error}
                </p>
              )}
              {!atLatest ? (
                <div className="pointer-events-none sticky bottom-0 flex justify-center">
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="outline"
                    className="pointer-events-auto rounded-full shadow-sm"
                    aria-label="Scroll to latest"
                    title="Scroll to latest"
                    onClick={() => scrollToLatest("smooth")}
                  >
                    <ArrowDown />
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
          <SessionComposer
            tenantId={tenantId}
            agentName={agent.name}
            value={content}
            onChange={setContent}
            onSubmit={submit}
            onStop={stop}
            running={busy && status !== "loading"}
            sending={sending}
            blocked={["paused", "uncertain"].includes(status)}
            attachments={attachments}
            onAttach={attach}
            onRemove={removeAttachment}
          />
        </section>
      </ResizablePanel>
      {inspectorShown ? (
      <>
      <ResizableHandle withHandle />
      <ResizablePanel id="inspector" defaultSize={showDetails ? 36 : 58} minSize={28}>
        <TabsPrimitive.Root
          value={activeTab}
          onValueChange={changeTab}
          className="flex h-full min-h-0 flex-col overflow-hidden"
        >
          <div className="flex h-12 shrink-0 items-end border-b bg-background px-4">
            <TabsPrimitive.List className="flex h-full items-end gap-5 overflow-x-auto">
              {workflowManifest ? (
                <>
                  <TabsPrimitive.Trigger
                    value="tree"
                    className={tabTrigger}
                  >
                    Tree
                  </TabsPrimitive.Trigger>
                  <TabsPrimitive.Trigger
                    value="iterations"
                    className={tabTrigger}
                  >
                    Iterations
                  </TabsPrimitive.Trigger>
                </>
              ) : null}
              <TabsPrimitive.Trigger
                value="events"
                className={tabTrigger}
              >
                Events
              </TabsPrimitive.Trigger>
              <TabsPrimitive.Trigger
                value="manifest"
                className={tabTrigger}
              >
                {workflowManifest ? "Workflow" : "Manifest"}
              </TabsPrimitive.Trigger>
              <TabsPrimitive.Trigger value="agent" className={tabTrigger}>
                Agent
              </TabsPrimitive.Trigger>
              <TabsPrimitive.Trigger value="artifacts" className={tabTrigger}>
                Artifacts
              </TabsPrimitive.Trigger>
              <TabsPrimitive.Trigger value="usage" className={tabTrigger}>
                Usage
              </TabsPrimitive.Trigger>
            </TabsPrimitive.List>
          </div>
          {tree ? (
            <TabsPrimitive.Content
              value="tree"
              className="flex min-h-0 flex-1 flex-col overflow-hidden outline-none"
            >
              <WorkflowTree
                root={tree}
                liveByPath={liveByPath}
                selectedPath={selectedNode?.path}
                onSelect={setSelectedNode}
              />
              {selectedNode ? (
                <p className="shrink-0 border-t px-4 py-2 font-mono text-xs text-muted-foreground">
                  {selectedNode.path}
                  {selectedNode.kind === "item" || selectedNode.kind === "map"
                    ? " · item drill-down"
                    : ""}
                  {liveByPath.get(selectedNode.path)?.agentSessionId
                    ? ` · agent session ${liveByPath.get(selectedNode.path)?.agentSessionId}`
                    : ""}
                </p>
              ) : null}
            </TabsPrimitive.Content>
          ) : null}
          {workflowManifest ? (
            <TabsPrimitive.Content
              value="iterations"
              className="flex min-h-0 flex-1 flex-col overflow-hidden outline-none"
            >
              <div className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
                <h2 className="text-sm font-medium">Iteration timeline</h2>
              </div>
              <IterationTimeline
                rows={iterations}
                selected={selectedIteration}
                onSelect={setSelectedIteration}
              />
            </TabsPrimitive.Content>
          ) : null}
          <TabsPrimitive.Content
            value="events"
            className="flex min-h-0 flex-1 flex-col overflow-hidden outline-none"
          >
            <EventTable
              events={events}
              selected={selectedEvent}
              onSelect={openEvent}
            />
          </TabsPrimitive.Content>
          <TabsPrimitive.Content value="artifacts" className="flex min-h-0 flex-1 flex-col overflow-hidden outline-none">
            <SessionArtifacts
              tenantId={tenantId}
              sessionId={sessionId}
              revision={events.filter(e => e.type.startsWith("artifact.")).map(e => e.eventId).join("|")}
            />
          </TabsPrimitive.Content>
          <TabsPrimitive.Content
            value="agent"
            className="flex min-h-0 flex-1 flex-col overflow-hidden outline-none"
          >
            <SessionAgentPanel
              tenantId={tenantId}
              sessionId={sessionId}
              agentId={agentId}
              {...((pinned.kind === "pinned" || pinned.kind === "agent") && pinned.version
                ? { version: pinned.version }
                : {})}
            />
          </TabsPrimitive.Content>
          <TabsPrimitive.Content
            value="manifest"
            className="flex min-h-0 flex-1 flex-col overflow-hidden outline-none"
          >
            <AgentManifestPanel agent={agent} pinned={pinned} hasSandbox={hasSandbox} />
          </TabsPrimitive.Content>
          <TabsPrimitive.Content
            value="usage"
            className="flex min-h-0 flex-1 flex-col overflow-hidden outline-none"
          >
            <SessionUsage
              tenantId={tenantId}
              sessionId={sessionId}
              revision={events
                .filter((e) => e.type.startsWith("turn."))
                .map((e) => e.eventId)
                .join("|")}
              events={events}
              onViewEvent={(event) => {
                changeTab("events");
                openEvent(event);
              }}
            />
          </TabsPrimitive.Content>
        </TabsPrimitive.Root>
      </ResizablePanel>
      </>
      ) : null}
      {showDetails ? (
        <>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={30} minSize={22}>
            <EventDetails
              event={selectedEvent}
              onClose={() => {
                setDetailsOpen(false);
                setSelectedEvent(undefined);
              }}
            />
          </ResizablePanel>
        </>
      ) : null}
    </ResizablePanelGroup>
    </div>
  );
}
