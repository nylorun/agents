import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { Tabs as TabsPrimitive } from "radix-ui";
import { AppSidebar } from "@/components/app-sidebar";
import { ModelSettings } from "@/components/model-settings";
import { VaultModule } from "@/components/vault";
import { ViewErrorBoundary } from "@/components/view-error-boundary";
import { AgentManifestPanel } from "@/components/agent-manifest-panel";
import { EventDetails } from "@/components/event-details";
import { EventTable } from "@/components/event-table";
import { IterationTimeline } from "@/components/iteration-timeline";
import { SessionModelPicker } from "@/components/session-model-picker";
import { WorkflowLinkBanner } from "@/components/workflow-link-banner";
import { WorkflowTree } from "@/components/workflow-tree";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  actionLabel,
  agentOf,
  eventLabel,
  mergeStudioEvents,
  type StudioEvent,
} from "@/event-presentation";
import { shortTenantId, type StudioTenantInfo } from "@/config";
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
  createTenant,
  createTenantClient,
  fetchHello,
  listTenants,
  tenantHref,
  tenantRuntime,
  tenantScope,
  tenantUseCommand,
  type StudioTenant,
} from "@/proxy-client";
import type {
  AgentManifest,
  Connection,
  StudioDefinition,
} from "@/studio-types";
import {
  isWorkflowManifest,
  iterationTimelineFromEvents,
  linksFromEvents,
  liveStatusFromEvents,
  lookupWorkflowLink,
  rememberWorkflowLinks,
  treeFromManifest,
  type IterationRecord,
  type WorkflowManifest,
  type WorkflowTreeNode,
} from "@/workflow";

export type { AgentManifest, Connection, SessionSummary } from "@/studio-types";

function asStudioDefinition(raw: {
  manifest: Record<string, unknown> & { id: string; name?: string };
}): StudioDefinition {
  const manifest = raw.manifest;
  if (manifest.kind === "workflow") {
    return {
      id: String(manifest.id),
      name: String(manifest.name ?? manifest.id),
      kind: "workflow",
      manifest: manifest as WorkflowManifest,
    };
  }
  const capabilities = Array.isArray(manifest.capabilities)
    ? (manifest.capabilities as {
        id: string;
        tools?: { name: string; description?: string }[];
        hooks?: { at: "before" | "after"; scope: "turn" | "step" }[];
      }[])
    : [];
  return {
    id: String(manifest.id),
    name: String(manifest.name ?? manifest.id),
    manifest: { capabilities },
  };
}

function studioClient(tenantId: string) {
  return createTenantClient(tenantId);
}

void STUDIO_VERSION;

type BootState =
  | { kind: "booting" }
  | { kind: "signed-out" }
  | { kind: "waiting-for-app" }
  | { kind: "unreachable"; message: string }
  | { kind: "runtime-incompatible"; message: string }
  | { kind: "ready" };

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

/**
 * `/` is the Tenant picker. `/tenants/<id>/…` is one Tenant's dashboard, with
 * the router based at `/tenants/<id>` so its routes (`/agents/…`, `/vault`,
 * `/settings`) stay Tenant-relative. Switching Tenants reloads the page.
 */
export default function App() {
  const scope = tenantScope(window.location.pathname);
  return (
    <BrowserRouter basename={scope?.basename ?? "/"}>
      {embedded() ? <EmbedRouteSync basename={scope?.basename ?? ""} /> : null}
      <Routes>
        <Route path="*" element={<StudioRoot tenantId={scope?.tenantId} />} />
      </Routes>
    </BrowserRouter>
  );
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
 * its `navigate`. A route in another Tenant is refused: the session is limited
 * to this one.
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
            message: "This Studio session is limited to another Tenant.",
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
        setBoot({ kind: "ready" });
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
          Check the stack with <code className={code}>nylorun status</code>.
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
  if (embedded())
    return tenantId === undefined ? (
      <StatusScreen title="No Tenant selected">
        <p>Open Studio on one of your Tenants from the app.</p>
      </StatusScreen>
    ) : (
      // The session is limited to this Tenant, so there is no list to check.
      <ViewErrorBoundary>
        <Workspace tenant={{ id: tenantId, name: tenantId }} />
      </ViewErrorBoundary>
    );
  return tenantId === undefined ? (
    <TenantPicker />
  ) : (
    <TenantWorkspace tenantId={tenantId} />
  );
}

type TenantsState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "loaded"; tenants: readonly StudioTenant[] };

function useTenants(): TenantsState {
  const [state, setState] = useState<TenantsState>({ kind: "loading" });
  useEffect(() => {
    let cancelled = false;
    listTenants().then(
      (tenants) => {
        if (!cancelled) setState({ kind: "loaded", tenants });
      },
      (cause: unknown) => {
        if (!cancelled)
          setState({
            kind: "failed",
            message: cause instanceof Error ? cause.message : String(cause),
          });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

function TenantPicker() {
  const state = useTenants();
  return (
    <main className="mx-auto flex min-h-svh w-full max-w-2xl flex-col gap-6 p-8">
      <h1 className="text-2xl font-semibold">Tenants</h1>
      {state.kind === "loading" ? (
        <p className="text-muted-foreground">Loading Tenants…</p>
      ) : state.kind === "failed" ? (
        <p role="alert" className="text-red-600">
          {state.message}
        </p>
      ) : state.tenants.length === 0 ? (
        <section className="space-y-4">
          <p className="text-muted-foreground">
            A Tenant holds your agents, their sessions, a model provider and a
            vault. Create one to get started; you connect your code to it next.
          </p>
          <CreateTenantForm initialName="my-agents" />
        </section>
      ) : (
        <>
          <ul className="divide-y rounded-lg border">
            {state.tenants.map((tenant) => (
              <li key={tenant.id}>
                <a
                  className="flex items-center gap-3 p-4 hover:bg-muted/50"
                  href={tenantHref(tenant.id)}
                >
                  <span className="font-medium">{tenant.name ?? tenant.id}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {shortTenantId(tenant.id)}
                  </span>
                  {tenant.state !== "open" ? (
                    <Badge variant="outline" className="ml-auto">
                      {tenant.state}
                    </Badge>
                  ) : null}
                </a>
              </li>
            ))}
          </ul>
          <section className="space-y-2">
            <h2 className="font-medium">New Tenant</h2>
            <CreateTenantForm initialName="" />
          </section>
        </>
      )}
    </main>
  );
}

type CreateState =
  | { kind: "idle" }
  | { kind: "creating" }
  | { kind: "failed"; message: string };

/** Creates a Tenant, then opens it (switching Tenants reloads the page). */
function CreateTenantForm({ initialName }: { initialName: string }) {
  const [name, setName] = useState(initialName);
  const [state, setState] = useState<CreateState>({ kind: "idle" });
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || state.kind === "creating") return;
    setState({ kind: "creating" });
    try {
      const tenant = await createTenant(name.trim());
      window.location.assign(tenantHref(tenant.id));
    } catch (cause) {
      setState({
        kind: "failed",
        message:
          cause instanceof StudioSignedOutError
            ? "Studio signed you out. Run npx nylorun studio to sign in again."
            : cause instanceof Error
              ? cause.message
              : String(cause),
      });
    }
  }
  return (
    <form className="space-y-2" onSubmit={(event) => void submit(event)}>
      <div className="flex gap-2">
        <label className="sr-only" htmlFor="tenant-name">
          Tenant name
        </label>
        <Input
          id="tenant-name"
          value={name}
          maxLength={64}
          placeholder="Tenant name"
          onChange={(event) => setName(event.target.value)}
        />
        <Button type="submit" disabled={!name.trim() || state.kind === "creating"}>
          {state.kind === "creating" ? "Creating…" : "Create Tenant"}
        </Button>
      </div>
      {state.kind === "failed" ? (
        <p role="alert" className="text-sm text-red-600">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

/** A command with a copy button. */
function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted px-3 py-2">
      <code className="flex-1 overflow-x-auto font-mono text-sm">{command}</code>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() =>
          void navigator.clipboard.writeText(command).then(
            () => setCopied(true),
            () => setCopied(false),
          )
        }
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

type ModelState =
  | { kind: "loading" }
  | { kind: "unknown" }
  | { kind: "unset" }
  | { kind: "set"; label: string };

function useTenantModel(tenantId: string): ModelState {
  const [state, setState] = useState<ModelState>({ kind: "loading" });
  useEffect(() => {
    let cancelled = false;
    void tenantRuntime(tenantId)("/v1/tenant/model")
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const body = (await response.json()) as {
          configured?: boolean;
          provider?: string;
          model?: string;
        };
        if (cancelled) return;
        setState(
          body.configured
            ? { kind: "set", label: `${body.provider ?? "?"} · ${body.model ?? "?"}` }
            : { kind: "unset" },
        );
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "unknown" });
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);
  return state;
}

/**
 * Shown while a Tenant has no agents: the steps from an empty Tenant to an
 * agent in Studio. The Workspace polls, so the first agent replaces it.
 */
function ConnectYourCode({ tenant }: { tenant: StudioTenantInfo }) {
  const navigate = useNavigate();
  const model = useTenantModel(tenant.id);
  return (
    <section className="mx-auto w-full max-w-3xl flex-1 space-y-6 overflow-auto p-8">
      <div>
        <h1 className="text-2xl font-semibold">Connect your code</h1>
        <p className="mt-2 text-muted-foreground">
          {tenant.name} has no agents yet. Agents appear here when your code
          registers them.
        </p>
      </div>
      <ol className="space-y-6">
        <li className="space-y-2">
          <h2 className="font-medium">1. Choose a model provider</h2>
          {model.kind === "set" ? (
            <p className="text-sm text-muted-foreground">
              Using {model.label}.{" "}
              <button
                type="button"
                className="text-primary underline"
                onClick={() => void navigate("/settings")}
              >
                Change it
              </button>
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {model.kind === "unset"
                ? "This Tenant has no model provider yet. "
                : "Agents call the Tenant's model provider. "}
              <button
                type="button"
                className="text-primary underline"
                onClick={() => void navigate("/settings")}
              >
                Open Model Settings
              </button>
            </p>
          )}
        </li>
        <li className="space-y-2">
          <h2 className="font-medium">2. Link your project to this Tenant</h2>
          <p className="text-sm text-muted-foreground">
            In your project's directory, run:
          </p>
          <CommandLine command={tenantUseCommand(tenant.id)} />
          <p className="text-sm text-muted-foreground">
            No project yet? Create one with{" "}
            <code className={code}>npm create @nylorun/agent@beta my-agent</code>,
            then run the command above inside it.
          </p>
        </li>
        <li className="space-y-2">
          <h2 className="font-medium">3. Start it</h2>
          <CommandLine command="npm run dev" />
        </li>
      </ol>
      <p role="status" className="text-sm text-muted-foreground">
        Waiting for an agent to register…
      </p>
    </section>
  );
}

function TenantWorkspace({ tenantId }: { tenantId: string }) {
  const state = useTenants();
  if (state.kind === "loading") {
    return (
      <StatusScreen title="Connecting to Studio">
        <p>Loading the Tenant…</p>
      </StatusScreen>
    );
  }
  const listed =
    state.kind === "loaded"
      ? state.tenants.find((tenant) => tenant.id === tenantId)
      : undefined;
  if (state.kind === "loaded" && !listed) {
    return (
      <StatusScreen title="Tenant not found">
        <p>
          This Host has no Tenant <code className={code}>{tenantId}</code>.
        </p>
        <p>
          <a className="text-primary underline" href="/">
            Choose a Tenant
          </a>
        </p>
      </StatusScreen>
    );
  }
  // If the list failed, still open the Tenant; its own calls report errors.
  return (
    <ViewErrorBoundary>
      <Workspace tenant={{ id: tenantId, name: listed?.name ?? tenantId }} />
    </ViewErrorBoundary>
  );
}

function Workspace({ tenant }: { tenant: StudioTenantInfo }) {
  const navigate = useNavigate();
  const location = useLocation();
  const embedStatus = useEmbedStatus();
  const match = location.pathname.match(
    /^\/agents\/([^/]+)(?:\/sessions\/([^/]+))?/,
  );
  const sessionOnly = location.pathname.match(/^\/sessions\/([^/]+)\/?$/);
  const agentId = match?.[1] ? decodeURIComponent(match[1]) : undefined;
  const sessionId = match?.[2] ? decodeURIComponent(match[2]) : undefined;
  const [connection, setConnection] = useState<Connection>({
    status: "Connecting",
    agents: [],
    sessionsByAgent: {},
  });
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      const client = studioClient(tenant.id);
      const [definitions, sessions] = await Promise.all([
        client.listAgents(),
        client.listSessions(),
      ]);
      const grouped: Connection["sessionsByAgent"] = {};
      for (const s of sessions.sessions)
        (grouped[s.agentId] ??= []).push({
          session: s.id,
          status: s.status,
          title: s.id.slice(0, 8),
          startedAt: 0,
        });
      setConnection({
        status: "Running",
        url: "Runtime",
        agents: definitions.agents.map((a) =>
          asStudioDefinition({
            manifest: a.manifest as unknown as Record<string, unknown> & {
              id: string;
              name?: string;
            },
          }),
        ),
        sessionsByAgent: grouped,
      });
      setError("");
    } catch (e) {
      setError(String(e));
      setConnection((c) => ({ ...c, status: "Offline" }));
    }
  }, [tenant.id]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const waiting =
    connection.status === "Running" && connection.agents.length === 0;
  // Until the first agent registers, look for it every few seconds.
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [waiting, refresh]);
  const agent = connection.agents.find((a) => a.id === agentId);
  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <AppSidebar
        connection={connection}
        tenant={tenant}
        activeAgentId={agentId}
        activeSessionId={sessionId}
        settingsActive={location.pathname === "/settings"}
        vaultActive={location.pathname === "/vault"}
      />
      <SidebarInset className="flex h-svh min-h-0 min-w-0 flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
          <SidebarTrigger />
          <strong>
            {location.pathname === "/settings"
              ? "Model Settings"
              : location.pathname === "/vault"
                ? "Vault"
                : (agent?.name ?? "Nylorun Studio")}
          </strong>
          {embedded() ? null : (
            <Badge variant="outline" title={tenant.id}>
              {tenant.name} · {shortTenantId(tenant.id)}
            </Badge>
          )}
          {embedStatus === "reconnecting" || embedStatus === "failed" ? (
            <Badge variant="outline" role="status">
              {embedStatus === "reconnecting" ? "Reconnecting…" : "Disconnected"}
            </Badge>
          ) : null}
          <Button
            className="ml-auto"
            variant="outline"
            onClick={() => void refresh()}
          >
            Refresh
          </Button>
        </header>
        {error && (
          <p role="alert" className="shrink-0 p-4 text-red-600">
            {error}
          </p>
        )}
        {/* One broken view shows an error panel; the sidebar and header stay. */}
        <ViewErrorBoundary resetKey={location.pathname}>
          {sessionOnly ? (
            <SessionRedirect
              tenantId={tenant.id}
              sessionId={decodeURIComponent(sessionOnly[1]!)}
            />
          ) : location.pathname === "/settings" ? (
            <ModelSettings tenantId={tenant.id} />
          ) : location.pathname === "/vault" ? (
            <VaultModule tenantId={tenant.id} />
          ) : waiting ? (
            <ConnectYourCode tenant={tenant} />
          ) : agent && sessionId ? (
            <SessionWorkspace
              key={sessionId}
              agent={agent}
              sessionId={sessionId}
              tenantId={tenant.id}
              refresh={refresh}
            />
          ) : (
            <section className="mx-auto w-full max-w-3xl flex-1 overflow-auto p-8">
              <h1 className="text-2xl font-semibold">
                {agent?.name ?? "Your local agents"}
              </h1>
              <p className="my-4 text-muted-foreground">
                Start a session to chat and inspect session events.
              </p>
              {(agent ? [agent] : connection.agents).map((a) => (
                <section key={a.id} className="mb-4 rounded-lg border p-4">
                  <h2 className="font-medium">{a.name}</h2>
                  <p className="my-2 text-sm text-muted-foreground">
                    {a.kind === "workflow" || a.manifest.kind === "workflow"
                      ? "Workflow"
                      : a.manifest.capabilities
                          ?.flatMap((c) => c.tools ?? [])
                          .map((t) => t.name)
                          .join(", ") || "Text agent"}
                  </p>
                  <Button
                    onClick={() =>
                      void navigate(
                        `/agents/${encodeURIComponent(a.id)}/sessions/${crypto.randomUUID()}`,
                      )
                    }
                  >
                    New session
                  </Button>
                </section>
              ))}
            </section>
          )}
        </ViewErrorBoundary>
      </SidebarInset>
    </SidebarProvider>
  );
}

/**
 * `/tenants/:tenant/sessions/:session` (Studio §8.3): finds the session's agent
 * and replaces itself with the agent's session page. Embedders often know only
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
  const [problem, setProblem] = useState<string | undefined>();
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await tenantRuntime(tenantId)(
          `/v1/sessions/${encodeURIComponent(sessionId)}`,
        );
        if (cancelled) return;
        if (response.status === 404) return setProblem("not-found");
        if (!response.ok) return setProblem(`Studio could not load the session (${response.status}).`);
        const body = (await response.json()) as { agentId?: unknown };
        if (cancelled) return;
        if (typeof body.agentId !== "string" || body.agentId === "")
          return setProblem("not-found");
        void navigate(
          `/agents/${encodeURIComponent(body.agentId)}/sessions/${encodeURIComponent(sessionId)}`,
          { replace: true },
        );
      } catch (cause) {
        if (!cancelled)
          setProblem(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, sessionId, navigate]);
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

function SessionWorkspace({
  agent,
  sessionId,
  tenantId,
  refresh,
}: {
  agent: AgentManifest;
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
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [activeTab, setActiveTab] = useState<
    "events" | "manifest" | "tree" | "iterations"
  >(isWorkflow ? "tree" : "events");
  const [selectedEvent, setSelectedEvent] = useState<StudioEvent | undefined>();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [selectedNode, setSelectedNode] = useState<WorkflowTreeNode | undefined>();
  const [selectedIteration, setSelectedIteration] = useState<
    IterationRecord | undefined
  >();
  const workflowLink = lookupWorkflowLink(sessionId);

  useEffect(() => {
    if (!tenantId) {
      setError("Studio is missing a Tenant id.");
      return;
    }
    const abort = new AbortController();
    const sdk = studioClient(tenantId);
    const current = sdk.session(sessionId);
    void (async () => {
      await sdk.createSession({
        id: sessionId,
        agentId: agent.id,
        ownerUserId: "local-developer",
      });
      const history = await current.history({ signal: abort.signal });
      if (abort.signal.aborted) return;
      const loaded = mergeStudioEvents(
        [],
        history.items.map((event) => ({ ...event, committed: true })),
      );
      setEvents(loaded);
      if (isWorkflow) {
        rememberWorkflowLinks(
          linksFromEvents(loaded, sessionId, { workflowAgentId: agent.id }),
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
              linksFromEvents(next, sessionId, { workflowAgentId: agent.id }),
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
  }, [sessionId, agent.id, refresh, tenantId, isWorkflow]);

  useEffect(() => {
    setSelectedEvent(undefined);
    setDetailsOpen(false);
    setSelectedNode(undefined);
    setSelectedIteration(undefined);
    setActiveTab(isWorkflow ? "tree" : "events");
  }, [sessionId, isWorkflow]);

  const busy =
    sending || ["loading", "running", "runnable", "waiting"].includes(status);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!tenantId || !content.trim() || busy) return;
    setSending(true);
    setStatus("running");
    setError("");
    const session = studioClient(tenantId).session(sessionId);
    try {
      await session.input(content, { idempotencyKey: crypto.randomUUID() });
      setContent("");
    } catch (e) {
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
    const nextTab = value as "events" | "manifest" | "tree" | "iterations";
    setActiveTab(nextTab);
    if (nextTab !== "events") setDetailsOpen(false);
  };
  const showDetails =
    activeTab === "events" && detailsOpen && selectedEvent !== undefined;

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
      <ResizablePanel defaultSize={showDetails ? 34 : 42} minSize={28}>
        <section className="flex h-full min-h-0 flex-col overflow-hidden">
          <div className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
            <Badge variant="outline">{status}</Badge>
            {workflowManifest ? (
              <Badge variant="secondary">workflow</Badge>
            ) : null}
            <span className="truncate font-mono text-xs text-muted-foreground">
              {sessionId}
            </span>
            {busy && status !== "loading" && (
              <Button
                className="ml-auto"
                variant="outline"
                size="sm"
                onClick={() =>
                  void studioClient(tenantId)
                    .session(sessionId)
                    .cancel({ idempotencyKey: crypto.randomUUID() })
                    .catch((e) => setError(String(e)))
                }
              >
                Cancel
              </Button>
            )}
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
            {chatEvents.map((event) => {
              const payload = event.payload as Record<string, unknown>;
              if (event.type === "command.message")
                return (
                  <article
                    key={event.eventId}
                    className="ml-8 rounded-xl bg-muted p-4"
                  >
                    <p className="mb-1 text-xs text-muted-foreground">You</p>
                    {String(payload.content ?? "")}
                  </article>
                );
              if (event.type === "turn.completed")
                return (
                  <article
                    key={event.eventId}
                    className="mr-8 rounded-xl border p-4"
                  >
                    <p className="mb-1 text-xs text-muted-foreground">
                      Assistant
                    </p>
                    <pre className="whitespace-pre-wrap font-sans">
                      {pretty(payload.output)}
                    </pre>
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
              if (["action.pending", "action.completed"].includes(event.type))
                return (
                  <details
                    key={event.eventId}
                    className={
                      agentOf(payload)
                        ? "ml-6 rounded-lg border p-3"
                        : "rounded-lg border p-3"
                    }
                    open={event.type === "action.completed"}
                  >
                    <summary className="cursor-pointer text-sm font-medium">
                      {actionLabel(payload)} · {event.type.slice(7)}
                    </summary>
                    <pre className="mt-2 overflow-auto whitespace-pre-wrap text-xs">
                      {pretty(
                        event.type === "action.pending"
                          ? payload.input
                          : payload.result,
                      )}
                    </pre>
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
            {["paused", "uncertain"].includes(status) && (
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
          </div>
          <form
            onSubmit={submit}
            className="flex shrink-0 flex-col gap-2 border-t p-3"
          >
            <SessionModelPicker
              tenantId={tenantId}
              disabled={busy || ["paused", "uncertain"].includes(status)}
            />
            <div className="flex gap-3">
              <textarea
                aria-label="Message"
                className="min-h-20 flex-1 resize-none rounded-md border bg-background p-3"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Look up order demo-123"
                disabled={busy || ["paused", "uncertain"].includes(status)}
              />
              <Button
                disabled={
                  busy ||
                  !content.trim() ||
                  ["paused", "uncertain"].includes(status)
                }
                type="submit"
              >
                Send
              </Button>
            </div>
          </form>
        </section>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={showDetails ? 36 : 58} minSize={28}>
        <TabsPrimitive.Root
          value={activeTab}
          onValueChange={changeTab}
          className="flex h-full min-h-0 flex-col overflow-hidden"
        >
          <div className="flex h-12 shrink-0 items-end border-b bg-background px-4">
            <TabsPrimitive.List className="flex h-full items-end gap-5">
              {workflowManifest ? (
                <>
                  <TabsPrimitive.Trigger
                    value="tree"
                    className="border-b-2 border-transparent px-0 pb-3 text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground"
                  >
                    Tree
                  </TabsPrimitive.Trigger>
                  <TabsPrimitive.Trigger
                    value="iterations"
                    className="border-b-2 border-transparent px-0 pb-3 text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground"
                  >
                    Iterations
                  </TabsPrimitive.Trigger>
                </>
              ) : null}
              <TabsPrimitive.Trigger
                value="events"
                className="border-b-2 border-transparent px-0 pb-3 text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground"
              >
                Events
              </TabsPrimitive.Trigger>
              <TabsPrimitive.Trigger
                value="manifest"
                className="border-b-2 border-transparent px-0 pb-3 text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground"
              >
                {workflowManifest ? "Manifest" : "Agent Manifest"}
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
          <TabsPrimitive.Content
            value="manifest"
            className="flex min-h-0 flex-1 flex-col overflow-hidden outline-none"
          >
            <AgentManifestPanel agent={agent} />
          </TabsPrimitive.Content>
        </TabsPrimitive.Root>
      </ResizablePanel>
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
