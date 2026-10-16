import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  AGENT_EVENT_TYPES,
  type AgentEvent,
  type AgentEventType,
  type AgentView,
} from "@nylorun/agents";
import { ChevronLeft, Plus } from "lucide-react";
import { createTenantClient } from "@/proxy-client";
import { messageOf, useRead } from "@/resources/reads";
import type { SessionSummary } from "@/studio-types";
import { agentPath, isAgentTab, manifestPath, type AgentTab } from "@/agent-path";
import { editRequest, labelsText } from "@/agent-form";
import { manifestNameOf } from "@/agent-list";
import { lastActivity, sessionPath, sortSessions } from "@/session-list";
import { agentUnavailable } from "@/credential-coverage";
import { STUDIO_OWNER } from "@/session-open";
import { fullTime, shortTime } from "@/time-format";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Metadata, ReadState } from "@/components/resource-layout";
import {
  AgentState,
  Field,
  ManifestVersion,
  computeOf,
  date,
  otherSessionsNote,
} from "@/components/agents";
import { AgentSecrets } from "@/components/agent-secrets";
import { AgentDisk } from "@/components/agent-disk";
import { ForkSheet } from "@/components/agent-fork";
import { EgressRow, egressOf } from "@/components/agent-egress";
import { useStartSession } from "@/components/new-session";

/** A titled block of an Agent's page. */
export function Section({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

/**
 * One Agent's page (`/agents/<id>`): its state, compute and what it runs, the sessions that run
 * on it (none special, D71), the secrets of its vault, its disk versions, a pod's setup and input
 * files and its events, one tab each (`?tab=`).
 */
export function AgentPage({
  tenantId,
  id,
  sessions,
  onChanged,
}: {
  tenantId: string;
  id: string;
  /** The Tenant's sessions as the session list read them, for their last activity. */
  sessions: readonly SessionSummary[];
  /** The Agent was made, forked, changed or deleted: the lists read again. */
  onChanged?: () => void;
}) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const navigate = useNavigate();
  const startSession = useStartSession();
  const [query, setQuery] = useSearchParams();
  const asked = query.get("tab");
  const load = useCallback((signal: AbortSignal) => sdk.agents.get(id, { signal }), [sdk, id]);
  const read = useRead(load);
  const name = read.data ? manifestNameOf(read.data) : undefined;
  // The latest version of its manifest: a newer one reaches it by a fork.
  const loadLatest = useCallback(
    async (signal: AbortSignal) =>
      name === undefined
        ? undefined
        : (await sdk.agentManifests.get(name, undefined, { signal }).catch(() => undefined))?.version,
    [sdk, name],
  );
  const latest = useRead(loadLatest).data;
  const [forking, setForking] = useState(false);
  const [editing, setEditing] = useState(false);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const s = read.data;
  const newer = s !== undefined && latest !== undefined && latest > s.resolvedVersion;
  const unavailable = s ? agentUnavailable(s, STUDIO_OWNER) : undefined;
  // An Agent of kind none has no disk: its Disk tab opens the overview.
  const tab: AgentTab =
    isAgentTab(asked) && !(asked === "disk" && s?.kind === "none") ? asked : "overview";
  function openTab(value: string) {
    const next = new URLSearchParams(query);
    if (value === "overview") next.delete("tab");
    else next.set("tab", value);
    setQuery(next);
  }
  async function act(what: "stop" | "reset" | "delete"): Promise<void> {
    if (!s) return;
    const others = otherSessionsNote(s);
    if (
      what === "reset" &&
      !window.confirm(
        `Reset ${id}? Its pod starts again on a new, empty volume, with its setup and input files; the old volume is deleted.${others}`,
      )
    )
      return;
    if (
      what === "delete" &&
      !window.confirm(
        `Delete ${id}, its vault, its disk and its disk versions? Its sessions can take no new turn.${others} This cannot be undone.`,
      )
    )
      return;
    setActing(true);
    setActionError("");
    setNotice("");
    try {
      if (what === "delete") {
        await sdk.agents.delete(id);
        onChanged?.();
        navigate("/agents");
        return;
      }
      await (what === "stop" ? sdk.agents.stop(id) : sdk.agents.reset(id));
      setNotice(what === "stop" ? `Stopped ${id}.` : `Reset ${id}.`);
      read.reload();
      onChanged?.();
    } catch (cause) {
      setActionError(messageOf(cause));
    } finally {
      setActing(false);
    }
  }
  return (
    <section className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto w-full max-w-5xl space-y-4 p-4">
        <Link
          to="/agents"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
          Agents
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h1 className="break-all font-mono text-xl font-semibold">{id}</h1>
            {s ? (
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <AgentState state={s.state} />
                <Badge variant="outline">{s.kind}</Badge>
                <ManifestVersion agent={s} />
                <span aria-hidden>·</span>
                <span>
                  {s.sessions.length} {s.sessions.length === 1 ? "session" : "sessions"}
                </span>
              </div>
            ) : null}
          </div>
          {s ? (
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={unavailable !== undefined}
                title={unavailable}
                onClick={() => startSession(s)}
              >
                <Plus />
                New session
              </Button>
              <Button variant="outline" onClick={read.reload} disabled={read.pending}>
                Refresh
              </Button>
              <Button variant="outline" disabled={acting} onClick={() => setEditing(true)}>
                Edit labels and owner
              </Button>
              <Button variant={newer ? "default" : "outline"} disabled={acting} onClick={() => setForking(true)}>
                {newer ? `Fork to v${latest}` : "Fork"}
              </Button>
              {s.kind === "pod" ? (
                <>
                  <Button variant="outline" disabled={acting} onClick={() => void act("stop")}>
                    Stop
                  </Button>
                  <Button variant="outline" disabled={acting} onClick={() => void act("reset")}>
                    Reset
                  </Button>
                </>
              ) : null}
              <Button variant="destructive" disabled={acting} onClick={() => void act("delete")}>
                Delete
              </Button>
            </div>
          ) : null}
        </div>
        {actionError ? (
          <p role="alert" className="break-words text-sm text-red-600">
            {actionError}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="text-sm text-muted-foreground">
            {notice}
          </p>
        ) : null}
        <ReadState {...read} onRetry={read.reload} />
        {s ? (
          <Tabs value={tab} onValueChange={openTab} className="gap-4">
            <TabsList aria-label="Agent tabs" className="max-w-full justify-start overflow-x-auto">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="sessions">Sessions</TabsTrigger>
              <TabsTrigger value="secrets">Secrets</TabsTrigger>
              {s.kind === "none" ? null : <TabsTrigger value="disk">Disk</TabsTrigger>}
              <TabsTrigger value="setup">Setup &amp; files</TabsTrigger>
              <TabsTrigger value="events">Events</TabsTrigger>
            </TabsList>
            <TabsContent value="overview">
              <AgentOverview agent={s} {...(latest === undefined ? {} : { latest })} />
            </TabsContent>
            <TabsContent value="sessions">
              <AgentSessions agent={s} known={sessions} />
            </TabsContent>
            <TabsContent value="secrets">
              <AgentSecrets tenantId={tenantId} agent={s} />
            </TabsContent>
            {s.kind === "none" ? null : (
              <TabsContent value="disk">
                <AgentDisk
                  tenantId={tenantId}
                  agent={s}
                  {...(latest === undefined ? {} : { latest })}
                  onChanged={read.reload}
                />
              </TabsContent>
            )}
            <TabsContent value="setup">
              <AgentSetup agent={s} />
            </TabsContent>
            <TabsContent value="events">
              <AgentEvents tenantId={tenantId} id={id} />
            </TabsContent>
          </Tabs>
        ) : null}
      </div>
      {forking && s ? (
        <ForkSheet
          tenantId={tenantId}
          source={s}
          {...(latest === undefined ? {} : { latest })}
          onClose={() => setForking(false)}
          onForked={(agent) => {
            setForking(false);
            onChanged?.();
            navigate(agentPath(agent.id));
          }}
        />
      ) : null}
      {editing && s ? (
        <EditAgentSheet
          tenantId={tenantId}
          agent={s}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            read.reload();
            onChanged?.();
          }}
        />
      ) : null}
    </section>
  );
}

/** Its state and what made it, its compute, what it runs and who uses it, as fields. */
function AgentOverview({ agent: s, latest }: { agent: AgentView; latest?: number }) {
  const runtime = s.runtime;
  const hosts = runtime.network?.allowedHosts ?? [];
  const name = manifestNameOf(s);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Section title="State">
        <AgentState state={s.state} />
        {s.attention.length ? (
          <ul className="grid gap-1 text-sm">
            {s.attention.map((item, index) => (
              <li key={`${item.state}:${item.sessionId ?? ""}:${index}`} className="break-words">
                <Badge variant={item.state === "failing" ? "destructive" : "outline"} className="mr-2">
                  {item.state.replace(/_/gu, " ")}
                </Badge>
                {item.sessionId ? (
                  <Link className="font-mono text-xs underline" to={sessionPath(s.id, item.sessionId)}>
                    {item.sessionId}
                  </Link>
                ) : (
                  <span className="text-xs">its compute</span>
                )}
                <span className="text-muted-foreground"> · {item.reason}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Nothing waits on a person, and nothing fails.</p>
        )}
      </Section>
      <Section title="Compute">
        {s.kind === "none" ? (
          <p className="text-sm text-muted-foreground">
            No sandbox: sessions on it get only its credentials, for remote MCP servers and HTTP
            tools.
          </p>
        ) : (
          <Metadata
            entries={[
              ["Kind", s.kind === "pod" ? "Pod, with its own volume" : "Virtual workspace in the harness"],
              ["Compute", computeOf(s)],
              ...(s.compute.pod
                ? ([
                    ["Desired", s.compute.pod.desired],
                    ["Volume generation", s.compute.pod.volumeGeneration],
                    ["Host epoch", s.compute.pod.hostEpoch],
                    ...(s.compute.pod.reason ? ([["Reason", s.compute.pod.reason]] as [string, ReactNode][]) : []),
                  ] as [string, ReactNode][])
                : []),
              ...(s.kind === "pod" ? ([["Image", runtime.image ?? "The Tenant's"]] as [string, ReactNode][]) : []),
              ...(s.compute.pod?.imageDigest
                ? ([
                    ["Image digest", <span className="break-all font-mono text-xs">{s.compute.pod.imageDigest}</span>],
                  ] as [string, ReactNode][])
                : []),
              [
                "Resources",
                runtime.resources ? `${runtime.resources.cpus} CPU · ${runtime.resources.memory}` : "The Tenant's",
              ],
              ...(s.kind === "pod" ? ([["Storage", runtime.storage ?? "—"]] as [string, ReactNode][]) : []),
              ["Allowed hosts", hosts.length ? hosts.join(", ") : "None"],
            ]}
          />
        )}
        {s.kind === "virtual" ? (
          <p className="text-xs text-muted-foreground">A virtual workspace has no pod to stop or reset.</p>
        ) : null}
      </Section>
      <Section title="What it runs">
        <Metadata
          entries={[
            [
              "Agent manifest",
              <span>
                <Link className="font-mono underline underline-offset-4" to={manifestPath(name, s.resolvedVersion)}>
                  {name}@{s.resolvedVersion}
                </Link>{" "}
                {s.tracking === "tracking" ? "(tracks the manifest)" : "(pinned)"}
                {latest !== undefined && latest > s.resolvedVersion ? ` · v${latest} available: fork to move` : ""}
              </span>,
            ],
            ["Changes", "Never: a newer version reaches it through a fork"],
            ...(s.forkedFrom
              ? ([
                  [
                    "Forked from",
                    <Link className="underline underline-offset-4" to={agentPath(s.forkedFrom.agent)}>
                      {s.forkedFrom.agent}
                      {s.forkedFrom.disk === null ? " (empty disk)" : ` (disk v${s.forkedFrom.disk})`}
                    </Link>,
                  ],
                ] as [string, ReactNode][])
              : []),
            ["Harness", s.harness],
            ["Idle", runtime.lifecycle.idle ?? "The Tenant's"],
            ["Delete after", runtime.lifecycle.deleteAfter ?? "Never"],
            ...(s.kind === "pod"
              ? ([
                  ["Setup commands", runtime.setup?.length ?? 0],
                  ["Input files", runtime.files?.length ?? 0],
                ] as [string, ReactNode][])
              : []),
            ["Manifest hash", <span className="break-all font-mono text-xs">{s.manifestHash}</span>],
          ]}
        />
      </Section>
      <Section title="Use">
        <Metadata
          entries={[
            ["Owner guard", s.owner ?? "None: any owner's sessions"],
            ["Sessions", s.sessions.length],
            ...(s.slots.length
              ? ([
                  [
                    "Secret slots",
                    <span className="flex flex-wrap gap-1">
                      {s.slots.map((slot) => (
                        <Badge key={slot.name} variant={slot.set ? "secondary" : slot.required ? "destructive" : "outline"}>
                          {slot.name}
                          {slot.set ? "" : slot.required ? " · missing" : " · not set"}
                        </Badge>
                      ))}
                    </span>,
                  ],
                ] as [string, ReactNode][])
              : []),
            ...(s.disk
              ? ([
                  ["Latest disk version", s.disk.latestVersion === null ? "None" : `v${s.disk.latestVersion}`],
                ] as [string, ReactNode][])
              : []),
            ["Last used", date(s.lastUsedAt)],
            ["Created", date(s.createdAt)],
            ["Updated", date(s.updatedAt)],
          ]}
        />
      </Section>
      <Section title="Labels">
        {Object.keys(s.labels).length ? (
          <div className="flex flex-wrap gap-1">
            {Object.entries(s.labels).map(([key, value]) => (
              <Badge key={key} variant="outline" className="font-mono">
                {key}={value}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No labels.</p>
        )}
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Its runtime, as JSON</summary>
          <pre className="mt-2 whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">
            {JSON.stringify(runtime, null, 2)}
          </pre>
        </details>
      </Section>
    </div>
  );
}

/** A pod's setup commands and input files (R2d step 2), as its runtime holds them. */
function AgentSetup({ agent: s }: { agent: AgentView }) {
  if (s.kind !== "pod")
    return (
      <p className="rounded-lg border p-4 text-sm text-muted-foreground">
        Setup commands and input files are a pod's: they run when its disk is made or reset. A{" "}
        {s.kind === "virtual" ? "virtual" : "vault-only"} Agent has none.
      </p>
    );
  const setup = s.runtime.setup ?? [];
  const files = s.runtime.files ?? [];
  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-muted-foreground">
        On a new disk (when the pod is first made, and at every reset) the input files are copied
        in, then the setup commands run in order, before any turn. They never change: an Agent
        keeps the manifest version it was made from.
      </p>
      {s.compute.pod?.reason ? (
        <p role="alert" className="text-sm text-red-600">
          {s.compute.pod.reason}
        </p>
      ) : null}
      <Section title="Input files">
        {files.length ? (
          <ol className="grid gap-2">
            {files.map((file, index) => (
              <li key={`${index}:${file.path}`} className="grid gap-1 rounded-md border p-3 text-sm">
                <span className="font-mono text-xs text-muted-foreground">
                  {index + 1}. → {file.path}
                </span>
                {"files" in file ? (
                  // Files by content hash (Q6): the manifest's files, listed by path.
                  <span className="break-all font-mono text-xs">{Object.keys(file.files).sort().join(", ")}</span>
                ) : (
                  <Link
                    className="break-all font-mono underline underline-offset-4"
                    to={`/artifacts?${new URLSearchParams({
                      selected: file.artifactId,
                      version: String(file.version),
                    })}`}
                  >
                    {file.artifactId} · v{file.version}
                  </Link>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">No input files.</p>
        )}
      </Section>
      <Section title="Setup commands">
        {setup.length ? (
          <ol className="grid gap-2">
            {setup.map((command, index) => (
              <li key={index} className="grid gap-1 rounded-md border p-3 text-sm">
                <code className="whitespace-pre-wrap break-all font-mono text-xs">{command.command}</code>
                <span className="text-xs text-muted-foreground">
                  {index + 1}. in {command.cwd ?? "/workspace"} · timeout {command.timeout ?? "10m"}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">No setup commands.</p>
        )}
      </Section>
    </div>
  );
}

/**
 * The sessions that run on the Agent (its view lists them), by last activity as the session list
 * read it: none is special (D71).
 */
function AgentSessions({
  agent,
  known,
}: {
  agent: AgentView;
  /** The Tenant's sessions as the session list read them, with their times. */
  known: readonly SessionSummary[];
}) {
  const startSession = useStartSession();
  const unavailable = agentUnavailable(agent, STUDIO_OWNER);
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
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Every session on this Agent shares its compute, its disk and its vault; none is
          special. A session pins the manifest version the Agent runs when it opens.
        </p>
        <Button size="sm" disabled={unavailable !== undefined} title={unavailable} onClick={() => startSession(agent)}>
          <Plus />
          New session
        </Button>
      </div>
      {sorted.length === 0 ? (
        <p className="text-sm text-muted-foreground">No sessions run on it yet.</p>
      ) : null}
      {sorted.map((s) => {
        const at = lastActivity(s);
        return (
          <div key={s.id} className="space-y-1 border-b py-3 text-sm">
            <Link className="break-all font-mono font-medium underline" to={sessionPath(agent.id, s.id)}>
              {s.id}
            </Link>
            <p className="break-all text-muted-foreground">
              {s.ownerUserId} · {s.status}
              {at ? (
                <>
                  {" · "}
                  <time dateTime={at} title={fullTime(at)}>
                    {shortTime(at)}
                  </time>
                </>
              ) : null}
            </p>
            {s.activeTurnId ? <p className="break-all text-xs">Active turn: {s.activeTurnId}</p> : null}
            <Link className="inline-block text-xs underline" to={`${sessionPath(agent.id, s.id)}?inspector=artifacts`}>
              Outputs
            </Link>
          </div>
        );
      })}
    </div>
  );
}

/** Changes an Agent's labels and owner guard (`PUT /v1/agents/{id}`); what it runs stays. */
function EditAgentSheet({
  tenantId,
  agent,
  onClose,
  onSaved,
}: {
  tenantId: string;
  agent: AgentView;
  onClose: () => void;
  onSaved: (agent: AgentView) => void;
}) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const [labels, setLabels] = useState(() => labelsText(agent.labels));
  const [owner, setOwner] = useState(agent.owner ?? "");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setPending(true);
    try {
      onSaved(await sdk.agents.put(agent.id, editRequest(agent, { labels, owner })));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Edit {agent.id}</SheetTitle>
          <SheetDescription>
            An Agent never changes what it runs: here only its labels and owner guard change. To
            run another manifest version, fork it.
          </SheetDescription>
        </SheetHeader>
        <form className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4" onSubmit={(event) => void submit(event)}>
          <Field label="Labels" hint="One key=value per line.">
            <textarea
              aria-label="Labels"
              className="min-h-16 rounded-md border bg-background p-2 font-mono text-sm"
              value={labels}
              onChange={(event) => setLabels(event.target.value)}
            />
          </Field>
          <Field
            label="Owner (optional)"
            hint="The owner guard: only this owner's sessions may run on it. Empty: any owner's."
          >
            <Input value={owner} onChange={(event) => setOwner(event.target.value)} placeholder={STUDIO_OWNER} />
          </Field>
          {error ? (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          ) : null}
          <SheetFooter className="px-0">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving" : "Save labels and owner"}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

/** The Agent's events: all of them, its lifecycle, or the connections its sandbox opened. */
type EventsView = "all" | "lifecycle" | "connections";

/** Every type but egress: what happened to the Agent itself. */
const LIFECYCLE_TYPES: readonly AgentEventType[] = AGENT_EVENT_TYPES.filter((type) => type !== "agent.egress");

function AgentEvents({ tenantId, id }: { tenantId: string; id: string }) {
  const [view, setView] = useState<EventsView>("all");
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Which events">
        {(
          [
            ["all", "All"],
            ["lifecycle", "Lifecycle"],
            ["connections", "Connections"],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            size="sm"
            variant={view === value ? "secondary" : "outline"}
            aria-pressed={view === value}
            onClick={() => setView(value)}
          >
            {label}
          </Button>
        ))}
      </div>
      {view === "connections" ? (
        <p className="text-xs text-muted-foreground">
          Every connection the sandbox opened through egress-gate. A connection is the Agent's:
          its sessions run their turns at once, so the turns listed were running when it opened.
        </p>
      ) : null}
      <AgentEventList key={view} tenantId={tenantId} id={id} view={view} />
    </div>
  );
}

function AgentEventList({ tenantId, id, view }: { tenantId: string; id: string; view: EventsView }) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const accumulated = useRef<AgentEvent[]>([]);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const from = accumulated.current.reduce((n, e) => Math.max(n, e.seq + 1), 0);
      const types =
        view === "connections" ? (["agent.egress"] as const) : view === "lifecycle" ? LIFECYCLE_TYPES : undefined;
      const next = await sdk.agents.events(id, { from, ...(types ? { types } : {}), signal });
      signal.throwIfAborted();
      accumulated.current = Array.from(
        new Map([...accumulated.current, ...next].map((e) => [e.seq, e])).values(),
      ).sort((a, b) => a.seq - b.seq);
      return accumulated.current;
    },
    [sdk, id, view],
  );
  const read = useRead(load);
  return (
    <div className="space-y-3">
      <Button variant="outline" disabled={read.pending} onClick={read.reload}>
        Refresh events
      </Button>
      <ReadState
        {...read}
        onRetry={read.reload}
        empty={read.data?.length ? undefined : view === "connections" ? "No connections." : "No events."}
      />
      {read.data?.map((e) => {
        const egress = egressOf(e);
        return (
          <details key={e.eventId} className="border-b py-2 text-sm">
            <summary className="break-all">
              {e.seq} · {e.type}
              {egress ? ` · ${egress.host}:${egress.port} · ${egress.outcome}` : ""}
              <span className="block text-xs text-muted-foreground">{date(e.time)}</span>
            </summary>
            {egress ? <EgressRow egress={egress} /> : null}
            <pre className="mt-2 whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">
              {JSON.stringify(e.payload, null, 2)}
            </pre>
          </details>
        );
      })}
    </div>
  );
}
