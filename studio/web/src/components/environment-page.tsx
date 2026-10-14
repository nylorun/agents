import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ENVIRONMENT_EVENT_TYPES, type EnvironmentEvent, type EnvironmentEventType, type EnvironmentView } from "@nylorun/agents";
import { ChevronLeft } from "lucide-react";
import { createTenantClient } from "@/proxy-client";
import { messageOf, usePages, useRead } from "@/resources/reads";
import { isEnvironmentTab, type EnvironmentTab } from "@/environment-path";
import { sessionHref } from "@/session-open";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Metadata, ReadState } from "@/components/resource-layout";
import {
  EnvironmentSheet,
  date,
  otherSessionsNote,
  stateOf,
  versionOf,
} from "@/components/environments";
import { EnvironmentSecrets } from "@/components/environment-secrets";
import { EnvironmentDisk } from "@/components/environment-disk";
import { ForkSheet } from "@/components/environment-fork";
import { environmentPath } from "@/environment-path";
import { EgressRow, egressOf } from "@/components/environment-egress";

/** A titled block of an Environment's page. */
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
 * One Environment's page (`/environments/<id>`): its sandbox and recipe, the secrets of its
 * vault, its disk versions, a pod's setup and input files, the sessions that name it and its
 * lifecycle events, one tab each (`?tab=`).
 */
export function EnvironmentPage({
  tenantId,
  id,
}: {
  tenantId: string;
  id: string;
}) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const navigate = useNavigate();
  const [query, setQuery] = useSearchParams();
  const asked = query.get("tab");
  const load = useCallback(
    (signal: AbortSignal) => sdk.environments.get(id, { signal }),
    [sdk, id],
  );
  const read = useRead(load);
  const manifestName = read.data?.manifestName;
  // The latest version of the manifest it was made from: a newer one reaches it by a fork.
  const loadLatest = useCallback(
    async (signal: AbortSignal) =>
      manifestName === undefined
        ? undefined
        : (await sdk.environments.manifests.get(manifestName, { signal }).catch(() => undefined))?.version,
    [sdk, manifestName],
  );
  const latest = useRead(loadLatest).data;
  const [forking, setForking] = useState(false);
  const [editing, setEditing] = useState(false);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const s = read.data;
  // A vault-only Environment has no disk: its Disk tab opens the overview.
  const tab: EnvironmentTab =
    isEnvironmentTab(asked) && !(asked === "disk" && s?.kind === "none")
      ? asked
      : "overview";
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
        `Delete ${id}, its vault, its disk and its disk versions? Sessions that name it can take no new turn.${others} This cannot be undone.`,
      )
    )
      return;
    setActing(true);
    setActionError("");
    setNotice("");
    try {
      if (what === "delete") {
        await sdk.environments.delete(id);
        navigate("/environments");
        return;
      }
      await (what === "stop"
        ? sdk.environments.stop(id)
        : sdk.environments.reset(id));
      setNotice(what === "stop" ? `Stopped ${id}.` : `Reset ${id}.`);
      read.reload();
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
          to="/environments"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
          Environments
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h1 className="break-all font-mono text-xl font-semibold">{id}</h1>
            {s ? (
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <Badge variant="outline">{s.kind}</Badge>
                <Badge variant="secondary">{stateOf(s)}</Badge>
                <span>Version {versionOf(s)}</span>
                <span aria-hidden>·</span>
                <span>
                  {s.sessions.length}{" "}
                  {s.sessions.length === 1 ? "session" : "sessions"}
                </span>
              </div>
            ) : null}
          </div>
          {s ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={read.reload}
                disabled={read.pending}
              >
                Refresh
              </Button>
              <Button
                variant="outline"
                disabled={acting}
                onClick={() => setEditing(true)}
              >
                Edit labels and owner
              </Button>
              <Button
                variant={latest !== undefined && latest > (s.manifestVersion ?? 0) ? "default" : "outline"}
                disabled={acting}
                onClick={() => setForking(true)}
              >
                {latest !== undefined && latest > (s.manifestVersion ?? 0) ? `Fork to v${latest}` : "Fork"}
              </Button>
              {s.kind === "pod" ? (
                <>
                  <Button
                    variant="outline"
                    disabled={acting}
                    onClick={() => void act("stop")}
                  >
                    Stop
                  </Button>
                  <Button
                    variant="outline"
                    disabled={acting}
                    onClick={() => void act("reset")}
                  >
                    Reset
                  </Button>
                </>
              ) : null}
              <Button
                variant="destructive"
                disabled={acting}
                onClick={() => void act("delete")}
              >
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
            <TabsList aria-label="Environment tabs" className="max-w-full justify-start overflow-x-auto">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="secrets">Secrets</TabsTrigger>
              {s.kind === "none" ? null : (
                <TabsTrigger value="disk">Disk</TabsTrigger>
              )}
              <TabsTrigger value="setup">Setup &amp; files</TabsTrigger>
              <TabsTrigger value="sessions">Sessions</TabsTrigger>
              <TabsTrigger value="events">Events</TabsTrigger>
            </TabsList>
            <TabsContent value="overview">
              <EnvironmentOverview environment={s} {...(latest === undefined ? {} : { latest })} />
            </TabsContent>
            <TabsContent value="secrets">
              <EnvironmentSecrets tenantId={tenantId} environment={s} />
            </TabsContent>
            {s.kind === "none" ? null : (
              <TabsContent value="disk">
                <EnvironmentDisk
                  tenantId={tenantId}
                  environment={s}
                  onChanged={read.reload}
                />
              </TabsContent>
            )}
            <TabsContent value="setup">
              <EnvironmentSetup environment={s} />
            </TabsContent>
            <TabsContent value="sessions">
              <EnvironmentSessions
                tenantId={tenantId}
                id={id}
                active={s.sessions}
              />
            </TabsContent>
            <TabsContent value="events">
              <EnvironmentEvents tenantId={tenantId} id={id} />
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
          onForked={(environment) => {
            setForking(false);
            navigate(environmentPath(environment.id));
          }}
        />
      ) : null}
      {editing && s ? (
        <EnvironmentSheet
          tenantId={tenantId}
          existing={s}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            read.reload();
          }}
        />
      ) : null}
    </section>
  );
}

/** Its sandbox, its recipe and who uses it, as fields rather than JSON. */
function EnvironmentOverview({ environment: s, latest }: { environment: EnvironmentView; latest?: number }) {
  const recipe = s.manifest;
  const hosts = recipe.network?.allowedHosts ?? [];
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Section title="Sandbox">
        {s.kind === "none" ? (
          <p className="text-sm text-muted-foreground">
            No sandbox: sessions on it get only its credentials, for remote MCP
            servers and HTTP tools.
          </p>
        ) : (
          <Metadata
            entries={[
              ["Kind", s.kind === "pod" ? "Pod, with its own volume" : "Virtual workspace in the harness"],
              ["State", stateOf(s)],
              ...(s.pod
                ? ([
                    ["Desired", s.pod.desired],
                    ["Volume generation", s.pod.volumeGeneration],
                    ["Host epoch", s.pod.hostEpoch],
                    ...(s.pod.reason ? ([["Reason", s.pod.reason]] as [string, ReactNode][]) : []),
                  ] as [string, ReactNode][])
                : []),
              ...(s.kind === "pod" ? ([["Image", recipe.image ?? "The Tenant's"]] as [string, ReactNode][]) : []),
              ...(s.pod?.imageDigest
                ? ([["Image digest", <span className="break-all font-mono text-xs">{s.pod.imageDigest}</span>]] as [string, ReactNode][])
                : []),
              [
                "Resources",
                recipe.resources
                  ? `${recipe.resources.cpus} CPU · ${recipe.resources.memory}`
                  : "The Tenant's",
              ],
              ...(s.kind === "pod" ? ([["Storage", recipe.storage ?? "—"]] as [string, ReactNode][]) : []),
              ["Allowed hosts", hosts.length ? hosts.join(", ") : "None"],
            ]}
          />
        )}
        {s.kind === "virtual" ? (
          <p className="text-xs text-muted-foreground">
            A virtual workspace has no pod to stop or reset.
          </p>
        ) : null}
      </Section>
      <Section title="What it runs">
        <Metadata
          entries={[
            [
              "Made from",
              s.manifestName === undefined
                ? "Its own fields (an inline manifest)"
                : `Environment manifest ${s.manifestName} v${s.manifestVersion}${
                    latest !== undefined && latest > (s.manifestVersion ?? 0) ? ` (v${latest} available: fork to move)` : ""
                  }`,
            ],
            ["Changes", "Never: a new version reaches an agent through a fork"],
            ...(s.forkedFrom
              ? ([
                  [
                    "Forked from",
                    <Link className="underline underline-offset-4" to={environmentPath(s.forkedFrom.environment)}>
                      {s.forkedFrom.environment}
                      {s.forkedFrom.disk === null ? " (empty disk)" : ` (disk v${s.forkedFrom.disk})`}
                    </Link>,
                  ],
                ] as [string, ReactNode][])
              : []),
            ...(s.slots?.length
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
            ["Harness", recipe.harness],
            ["Idle", recipe.lifecycle.idle ?? "The Tenant's"],
            ["Delete after", recipe.lifecycle.deleteAfter ?? "Never"],
            ...(s.kind === "pod"
              ? ([
                  ["Setup commands", recipe.setup?.length ?? 0],
                  ["Input files", recipe.files?.length ?? 0],
                ] as [string, ReactNode][])
              : []),
          ]}
        />
      </Section>
      <Section title="Use">
        <Metadata
          entries={[
            ["Owner guard", s.ownerUserId ?? "None: any owner's sessions"],
            ["Sessions", s.sessions.length],
            ...(s.disk
              ? ([
                  [
                    "Latest disk version",
                    s.disk.latestVersion === null ? "None" : `v${s.disk.latestVersion}`,
                  ],
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
          <summary className="cursor-pointer text-muted-foreground">What it runs, as JSON</summary>
          <pre className="mt-2 whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">
            {JSON.stringify(recipe, null, 2)}
          </pre>
        </details>
      </Section>
    </div>
  );
}

/** A pod's setup commands and input files (R2d step 2), as the recipe holds them. */
function EnvironmentSetup({ environment: s }: { environment: EnvironmentView }) {
  if (s.kind !== "pod")
    return (
      <p className="rounded-lg border p-4 text-sm text-muted-foreground">
        Setup commands and input files are a pod's: they run when its disk is made
        or reset. A {s.kind === "virtual" ? "virtual" : "vault-only"} Environment has
        none.
      </p>
    );
  const setup = s.manifest.setup ?? [];
  const files = s.manifest.files ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-muted-foreground">
          On a new disk (when the pod is first made, and at every reset) the input
          files are copied in, then the setup commands run in order, before any turn.
          They never change: an Environment keeps what it was made with.
        </p>
      </div>
      {s.pod?.reason ? (
        <p role="alert" className="text-sm text-red-600">
          {s.pod.reason}
        </p>
      ) : null}
      <Section title="Input files">
        {files.length ? (
          <ol className="grid gap-2">
            {files.map((file, index) => (
              <li
                key={`${index}:${file.path}`}
                className="grid gap-1 rounded-md border p-3 text-sm"
              >
                <span className="font-mono text-xs text-muted-foreground">
                  {index + 1}. → {file.path}
                </span>
                {"files" in file ? (
                  // Files by content hash (Q6): definition files, listed by path.
                  <span className="break-all font-mono text-xs">
                    {Object.keys(file.files).sort().join(", ")}
                  </span>
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
                <code className="whitespace-pre-wrap break-all font-mono text-xs">
                  {command.command}
                </code>
                <span className="text-xs text-muted-foreground">
                  {index + 1}. in {command.cwd ?? "/workspace"} · timeout{" "}
                  {command.timeout ?? "10m"}
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

function EnvironmentSessions({
  tenantId,
  id,
  active,
}: {
  tenantId: string;
  id: string;
  active: { id: string; activeTurnId: string | null }[];
}) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const load = useCallback(
    async (signal: AbortSignal, cursor?: string) => {
      const page = await sdk.sessions.page({
        environmentId: id,
        limit: 50,
        cursor,
        signal,
      });
      return { items: page.sessions, nextCursor: page.nextCursor };
    },
    [sdk, id],
  );
  const page = usePages(load);
  return (
    <div className="space-y-3">
      <ReadState
        {...page}
        onRetry={page.reload}
        empty={page.items.length ? undefined : "No sessions name it."}
      />
      {page.items.map((s) => {
        const turn = active.find((a) => a.id === s.id)?.activeTurnId;
        return (
          <div key={s.id} className="space-y-1 border-b py-3 text-sm">
            <Link className="break-all font-medium underline" to={sessionHref(s.id)}>
              {s.id}
            </Link>
            <p className="break-all text-muted-foreground">
              {s.agentId} · {s.status}
              {s.lastEventAt ? ` · last event ${date(s.lastEventAt)}` : ""}
            </p>
            {turn ? <p className="break-all text-xs">Active turn: {turn}</p> : null}
            <Link
              className="inline-block text-xs underline"
              to={`${sessionHref(s.id)}?inspector=artifacts`}
            >
              Outputs
            </Link>
          </div>
        );
      })}
      {page.more ? (
        <Button
          variant="outline"
          disabled={page.pending}
          onClick={page.loadMore}
        >
          Load more sessions
        </Button>
      ) : null}
    </div>
  );
}

/** The Environment's events: all of them, its lifecycle, or the connections its sandbox opened. */
type EventsView = "all" | "lifecycle" | "connections";

/** Every type but egress: what happened to the Environment itself. */
const LIFECYCLE_TYPES: readonly EnvironmentEventType[] = ENVIRONMENT_EVENT_TYPES.filter(
  (type) => type !== "environment.egress",
);

function EnvironmentEvents({ tenantId, id }: { tenantId: string; id: string }) {
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
          Every connection the sandbox opened through egress-gate. A connection is the
          Environment's: sessions on it run their turns at once, so the turns listed were running
          when it opened.
        </p>
      ) : null}
      <EnvironmentEventList key={view} tenantId={tenantId} id={id} view={view} />
    </div>
  );
}

function EnvironmentEventList({ tenantId, id, view }: { tenantId: string; id: string; view: EventsView }) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const accumulated = useRef<EnvironmentEvent[]>([]);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const from = accumulated.current.reduce(
        (n, e) => Math.max(n, e.seq + 1),
        0,
      );
      const types =
        view === "connections" ? (["environment.egress"] as const) : view === "lifecycle" ? LIFECYCLE_TYPES : undefined;
      const next = await sdk.environments.events(id, { from, ...(types ? { types } : {}), signal });
      signal.throwIfAborted();
      accumulated.current = Array.from(
        new Map(
          [...accumulated.current, ...next].map((e) => [e.seq, e]),
        ).values(),
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
              <span className="block text-xs text-muted-foreground">
                {date(e.time)}
              </span>
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
