import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { EnvironmentEvent, EnvironmentView } from "@nylorun/agents";
import { Plus } from "lucide-react";
import { createTenantClient } from "@/proxy-client";
import { messageOf, usePages, useRead } from "@/resources/reads";
import {
  EMPTY_ENVIRONMENT_FORM,
  ENVIRONMENT_FORM_KINDS,
  environmentForm,
  environmentRequest,
  isEnvironmentIdText,
  type EnvironmentForm,
} from "@/environment-form";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Metadata,
  ReadState,
  ResourceHeader,
  ResourceLayout,
} from "@/components/resource-layout";

const date = (value?: string) =>
  value ? new Date(value).toLocaleString() : "—";

const SECRET_TYPES: Record<string, string> = {
  bearer: "Bearer",
  headers: "Headers",
  environment_secret: "Secret",
  environment_variable: "Variable",
};

/** The state a row shows: a pod's observed state, else the Environment's. */
const stateOf = (environment: EnvironmentView) =>
  environment.pod?.observed ?? environment.state;

/** `3` or `3 (runs 2)` when a pod still runs an older recipe. */
const versionOf = (environment: EnvironmentView) =>
  environment.appliedVersion === environment.version
    ? String(environment.version)
    : `${environment.version} (runs ${environment.appliedVersion})`;

/**
 * Environments (protocol 11, D55): each is one sandbox (kind `virtual`, `pod` or `none`) with a
 * recipe that can change, and one vault of secrets. Sessions name one by id.
 */
export function Environments({ tenantId }: { tenantId: string }) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const [query, setQuery] = useSearchParams();
  const selected = query.get("selected") ?? "";
  const labelValues = query.getAll("label");
  const labelKey = JSON.stringify(labelValues);
  const [labelInput, setLabelInput] = useState(labelValues.join("\n"));
  const [labelError, setLabelError] = useState("");
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    setLabelInput((JSON.parse(labelKey) as string[]).join("\n"));
    setLabelError("");
  }, [labelKey]);
  const load = useCallback(
    async (signal: AbortSignal, cursor?: string) => {
      const labels: Record<string, string> = {};
      for (const value of JSON.parse(labelKey) as string[]) {
        const at = value.indexOf("=");
        if (at <= 0) throw new Error("Labels must use key=value.");
        labels[value.slice(0, at)] = value.slice(at + 1);
      }
      const page = await sdk.environments.page({
        labels,
        limit: 50,
        cursor,
        signal,
      });
      return { items: page.environments, nextCursor: page.nextCursor };
    },
    [sdk, labelKey],
  );
  const page = usePages(load);
  function filter(event: FormEvent) {
    event.preventDefault();
    const labels = labelInput
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (labels.some((s) => s.indexOf("=") <= 0))
      return setLabelError("Use one key=value label per line.");
    setLabelError("");
    const next = new URLSearchParams(query);
    next.delete("label");
    for (const label of labels) next.append("label", label);
    setQuery(next);
  }
  function select(id?: string) {
    const next = new URLSearchParams(query);
    if (id) next.set("selected", id);
    else next.delete("selected");
    next.delete("tab");
    setQuery(next);
  }
  return (
    <ResourceLayout
      title="Environment details"
      onClose={() => select()}
      inspector={
        selected ? (
          <EnvironmentInspector
            key={selected}
            tenantId={tenantId}
            id={selected}
            onClose={() => select()}
            onChanged={page.reload}
            onDeleted={() => {
              select();
              page.reload();
            }}
          />
        ) : undefined
      }
    >
      <div className="space-y-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold">Environments</h1>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={page.reload}
              disabled={page.pending}
            >
              Refresh Environments
            </Button>
            <Button onClick={() => setCreating(true)}>
              <Plus />
              New Environment
            </Button>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          An Environment is one sandbox and one vault of secrets. A session that names it
          runs in its sandbox and sends its credentials; a session without one has neither.
        </p>
        <form className="flex flex-wrap items-end gap-2" onSubmit={filter}>
          <label className="flex flex-1 flex-col gap-1 text-sm">
            Labels
            <textarea
              aria-label="Environment labels"
              className="min-h-10 rounded-md border bg-background p-2"
              placeholder="project=build"
              value={labelInput}
              onChange={(e) => setLabelInput(e.target.value)}
            />
          </label>
          <Button type="submit" variant="outline">
            Apply labels
          </Button>
        </form>
        {labelError ? (
          <p role="alert" className="text-sm">
            {labelError}
          </p>
        ) : null}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Kind / state</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Labels</TableHead>
              <TableHead>Sessions</TableHead>
              <TableHead>Last used</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.items.map((s) => (
              <TableRow
                key={s.id}
                data-state={selected === s.id ? "selected" : undefined}
                onClick={() => select(s.id)}
              >
                <TableCell className="whitespace-normal break-all">
                  <button
                    className="text-left underline-offset-4 hover:underline"
                    onClick={(e) => {
                      e.stopPropagation();
                      select(s.id);
                    }}
                  >
                    {s.id}
                  </button>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{s.kind}</Badge>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {stateOf(s)}
                  </p>
                </TableCell>
                <TableCell>{versionOf(s)}</TableCell>
                <TableCell className="whitespace-normal break-all">
                  {s.ownerUserId ?? "—"}
                </TableCell>
                <TableCell className="whitespace-normal break-all text-xs">
                  {Object.entries(s.labels)
                    .map(([key, value]) => `${key}=${value}`)
                    .join(", ") || "—"}
                </TableCell>
                <TableCell>{s.sessions.length}</TableCell>
                <TableCell>{date(s.lastUsedAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <ReadState
          {...page}
          onRetry={page.reload}
          empty={
            page.items.length
              ? undefined
              : labelValues.length
                ? "No Environments match these labels."
                : "No Environments yet. Create one, then name it when you start a session."
          }
        />
        {page.more ? (
          <Button
            variant="outline"
            disabled={page.pending}
            onClick={page.loadMore}
          >
            Load more Environments
          </Button>
        ) : null}
      </div>
      {creating ? (
        <EnvironmentSheet
          tenantId={tenantId}
          onClose={() => setCreating(false)}
          onSaved={(environment) => {
            setCreating(false);
            page.reload();
            select(environment.id);
          }}
        />
      ) : null}
    </ResourceLayout>
  );
}

/** One labelled field of the recipe form, with an optional hint. */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1 text-sm">
      <label className="grid gap-1">
        {label}
        {children}
      </label>
      {hint ? (
        <span className="text-xs text-muted-foreground">{hint}</span>
      ) : null}
    </div>
  );
}

/**
 * Creates an Environment, or changes the recipe of `existing` (`PUT /v1/environments/{id}`). On
 * an existing one the kind and storage are fixed; image and resources reach a pod when it next
 * starts from stopped.
 */
function EnvironmentSheet({
  tenantId,
  existing,
  onClose,
  onSaved,
}: {
  tenantId: string;
  existing?: EnvironmentView;
  onClose: () => void;
  onSaved: (environment: EnvironmentView) => void;
}) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const [form, setForm] = useState<EnvironmentForm>(() =>
    existing ? environmentForm(existing) : EMPTY_ENVIRONMENT_FORM,
  );
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const set = (patch: Partial<EnvironmentForm>) =>
    setForm((current) => ({ ...current, ...patch }));
  const kind = existing?.kind ?? form.kind;
  const compute = kind !== "none";
  const pod = kind === "pod";
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setPending(true);
    try {
      const id = existing?.id ?? form.id.trim();
      if (!isEnvironmentIdText(id))
        throw new Error(
          "An Environment id is up to 200 characters: /-separated segments of letters, digits, '.', '_' and '-', such as team/build.",
        );
      onSaved(
        await sdk.environments.put(id, environmentRequest(form, existing)),
      );
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
          <SheetTitle>
            {existing ? `Edit ${existing.id}` : "New Environment"}
          </SheetTitle>
          <SheetDescription>
            {existing
              ? "Changing the recipe bumps its version. Kind and storage are fixed; a pod takes a new image or resources when it next starts."
              : "Empty fields take this Tenant's defaults. Write its secrets on the Credentials page once it exists."}
          </SheetDescription>
        </SheetHeader>
        <form
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4"
          onSubmit={(event) => void submit(event)}
        >
          <Field
            label="ID"
            hint={
              existing
                ? undefined
                : "Such as team/build or users/alice/web: segments of letters, digits, '.', '_' and '-'."
            }
          >
            <Input
              value={form.id}
              onChange={(event) => set({ id: event.target.value })}
              className="font-mono"
              required
              readOnly={existing !== undefined}
              autoFocus={existing === undefined}
            />
          </Field>
          <Field
            label="Kind"
            hint={
              kind === "virtual"
                ? "A workspace in the harness, no cluster."
                : kind === "pod"
                  ? "A sandbox pod with its own volume (needs sandbox pods)."
                  : "No sandbox: only the vault, for remote MCP servers and HTTP tools."
            }
          >
            {existing ? (
              <Input value={existing.kind} readOnly />
            ) : (
              <select
                aria-label="Kind"
                className="h-9 rounded-md border bg-transparent px-3"
                value={form.kind}
                onChange={(event) =>
                  set({ kind: event.target.value as EnvironmentForm["kind"] })
                }
              >
                {ENVIRONMENT_FORM_KINDS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {pod ? (
            <Field label="Image" hint="Default: the Tenant's.">
              <Input
                value={form.image}
                onChange={(event) => set({ image: event.target.value })}
                placeholder="python:3.13-slim"
                className="font-mono"
              />
            </Field>
          ) : null}
          {compute ? (
            <div className="grid grid-cols-2 gap-2">
              <Field label="CPUs">
                <Input
                  value={form.cpus}
                  onChange={(event) => set({ cpus: event.target.value })}
                  inputMode="numeric"
                  placeholder="1"
                />
              </Field>
              <Field label="Memory">
                <Input
                  value={form.memory}
                  onChange={(event) => set({ memory: event.target.value })}
                  placeholder="1GiB"
                  className="font-mono"
                />
              </Field>
            </div>
          ) : null}
          {pod ? (
            <Field label="Storage" hint={existing ? "Fixed." : "Default 5GiB. Fixed once created."}>
              <Input
                value={form.storage}
                onChange={(event) => set({ storage: event.target.value })}
                placeholder="5GiB"
                className="font-mono"
                readOnly={existing !== undefined}
              />
            </Field>
          ) : null}
          {compute ? (
            <Field
              label="Allowed hosts"
              hint={
                pod
                  ? "Hosts the sandbox may reach, separated by commas; pods also take *.suffix."
                  : "Exact host names the sandbox may reach, separated by commas."
              }
            >
              <Input
                value={form.allowedHosts}
                onChange={(event) => set({ allowedHosts: event.target.value })}
                placeholder="api.github.com, pypi.org"
                className="font-mono"
              />
            </Field>
          ) : null}
          <Field label="Labels" hint="One key=value per line.">
            <textarea
              aria-label="Labels"
              className="min-h-16 rounded-md border bg-background p-2 font-mono text-sm"
              value={form.labels}
              onChange={(event) => set({ labels: event.target.value })}
              placeholder="project=build"
            />
          </Field>
          <Field
            label="Owner (optional)"
            hint="The owner guard: only this owner's sessions may name it. Studio's sessions are local-developer's."
          >
            <Input
              value={form.ownerUserId}
              onChange={(event) => set({ ownerUserId: event.target.value })}
              placeholder="local-developer"
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Idle" hint="Stop compute after; default the Tenant's.">
              <Input
                value={form.idle}
                onChange={(event) => set({ idle: event.target.value })}
                placeholder="15m"
                className="font-mono"
              />
            </Field>
            <Field label="Delete after" hint="Unused this long; default never.">
              <Input
                value={form.deleteAfter}
                onChange={(event) => set({ deleteAfter: event.target.value })}
                placeholder="30d"
                className="font-mono"
              />
            </Field>
          </div>
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
              {pending
                ? "Saving"
                : existing
                  ? "Save recipe"
                  : "Create Environment"}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function EnvironmentInspector({
  tenantId,
  id,
  onClose,
  onChanged,
  onDeleted,
}: {
  tenantId: string;
  id: string;
  onClose: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const [query, setQuery] = useSearchParams();
  const tab = ["details", "secrets", "sessions", "events"].includes(
    query.get("tab") ?? "",
  )
    ? query.get("tab")!
    : "details";
  const load = useCallback(
    (signal: AbortSignal) => sdk.environments.get(id, { signal }),
    [sdk, id],
  );
  const read = useRead(load);
  const [editing, setEditing] = useState(false);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const s = read.data;
  async function act(
    what: "stop" | "reset" | "delete",
  ): Promise<void> {
    if (
      what === "reset" &&
      !window.confirm(
        `Reset ${id}? Its pod starts again on a new, empty volume; the old volume is deleted.`,
      )
    )
      return;
    if (
      what === "delete" &&
      !window.confirm(
        `Delete ${id}, its vault and its files? Sessions that name it can take no new turn. This cannot be undone.`,
      )
    )
      return;
    setActing(true);
    setActionError("");
    setNotice("");
    try {
      if (what === "delete") {
        await sdk.environments.delete(id);
        onDeleted();
        return;
      }
      await (what === "stop"
        ? sdk.environments.stop(id)
        : sdk.environments.reset(id));
      setNotice(what === "stop" ? `Stopped ${id}.` : `Reset ${id}.`);
      read.reload();
      onChanged();
    } catch (cause) {
      setActionError(messageOf(cause));
    } finally {
      setActing(false);
    }
  }
  return (
    <section className="flex h-full min-h-0 flex-col">
      <ResourceHeader title={id} onClose={onClose}>
        <Button
          size="sm"
          variant="outline"
          onClick={read.reload}
          disabled={read.pending}
        >
          Refresh details
        </Button>
      </ResourceHeader>
      {s ? (
        <div className="flex shrink-0 flex-wrap gap-2 border-b px-4 py-2">
          <Button
            size="sm"
            variant="outline"
            disabled={acting}
            onClick={() => setEditing(true)}
          >
            Edit recipe
          </Button>
          {s.kind === "pod" ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={acting}
                onClick={() => void act("stop")}
              >
                Stop
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={acting}
                onClick={() => void act("reset")}
              >
                Reset
              </Button>
            </>
          ) : null}
          <Button
            size="sm"
            variant="destructive"
            disabled={acting}
            onClick={() => void act("delete")}
          >
            Delete
          </Button>
        </div>
      ) : null}
      {actionError ? (
        <p role="alert" className="break-words px-4 pt-3 text-sm text-red-600">
          {actionError}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="px-4 pt-3 text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
      <Tabs
        value={tab}
        onValueChange={(value) => {
          const next = new URLSearchParams(query);
          next.set("tab", value);
          setQuery(next);
        }}
        className="min-h-0 flex-1 overflow-auto p-4"
      >
        <TabsList aria-label="Environment tabs">
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="secrets">Secrets</TabsTrigger>
          <TabsTrigger value="sessions">Sessions</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
        </TabsList>
        <ReadState {...read} onRetry={read.reload} />
        {s ? (
          <>
            <TabsContent value="details" className="space-y-4">
              <Metadata
                entries={[
                  ["ID", s.id],
                  ["Kind", s.kind],
                  ["State", s.state],
                  ["Version", s.version],
                  ["Applied version", s.appliedVersion],
                  ["Owner guard", s.ownerUserId ?? "None"],
                  ["Last used", date(s.lastUsedAt)],
                  ["Created", date(s.createdAt)],
                  ["Updated", date(s.updatedAt)],
                ]}
              />
              {s.pod ? (
                <Metadata
                  entries={[
                    ["Desired", s.pod.desired],
                    ["Observed", s.pod.observed],
                    ["Volume generation", s.pod.volumeGeneration],
                    ["Host epoch", s.pod.hostEpoch],
                    ["Reason", s.pod.reason],
                  ]}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {s.kind === "none"
                    ? "No sandbox: sessions on it get only its credentials."
                    : "Virtual workspace; there is no pod to stop or reset."}
                </p>
              )}
              <h3 className="text-sm font-medium">Labels</h3>
              <pre className="whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">
                {JSON.stringify(s.labels, null, 2)}
              </pre>
              <h3 className="text-sm font-medium">Recipe</h3>
              <pre className="whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">
                {JSON.stringify(s.recipe, null, 2)}
              </pre>
            </TabsContent>
            <TabsContent value="secrets">
              <EnvironmentSecrets tenantId={tenantId} id={id} />
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
          </>
        ) : null}
      </Tabs>
      {editing && s ? (
        <EnvironmentSheet
          tenantId={tenantId}
          existing={s}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            read.reload();
            onChanged();
          }}
        />
      ) : null}
    </section>
  );
}

/** The Environment's secrets: names, types and bindings, never a value. */
function EnvironmentSecrets({ tenantId, id }: { tenantId: string; id: string }) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const load = useCallback(
    (signal: AbortSignal) => sdk.environments.secrets.list(id, { signal }),
    [sdk, id],
  );
  const read = useRead(load);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={read.pending} onClick={read.reload}>
          Refresh secrets
        </Button>
        <Button variant="outline" asChild>
          <Link
            to={`/settings/credentials?${new URLSearchParams({ environment: id })}`}
          >
            Manage credentials
          </Link>
        </Button>
      </div>
      <ReadState
        {...read}
        onRetry={read.reload}
        empty={read.data?.length ? undefined : "No secrets."}
      />
      {read.data?.map((secret) => (
        <div key={secret.name} className="space-y-1 border-b py-3 text-sm">
          <div className="flex items-center gap-2">
            <span className="break-all font-medium">{secret.name}</span>
            <Badge variant="outline">
              {SECRET_TYPES[secret.type] ?? secret.type}
            </Badge>
            {secret.via ? <Badge variant="outline">Gateway</Badge> : null}
          </div>
          <p className="break-all font-mono text-xs text-muted-foreground">
            {secret.binding.url ??
              (secret.binding.allowedHosts
                ? `→ ${secret.binding.allowedHosts.join(", ")}${secret.binding.inject ? ` · ${secret.binding.inject.header}` : ""}`
                : `$${secret.name}`)}
          </p>
          {secret.headerNames?.length ? (
            <p className="break-all text-xs text-muted-foreground">
              Headers: {secret.headerNames.join(", ")}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Created {date(secret.createdAt)}
            {secret.rotatedAt ? ` · Rotated ${date(secret.rotatedAt)}` : ""}
          </p>
        </div>
      ))}
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
      {page.items.map((s) => (
        <div key={s.id} className="space-y-2 border-b py-3 text-sm">
          <Link
            className="break-all underline"
            to={`/sessions/${encodeURIComponent(s.id)}`}
          >
            {s.id}
          </Link>
          <p className="break-all text-muted-foreground">
            {s.agentId} · {s.status}
          </p>
          {active.find((a) => a.id === s.id)?.activeTurnId ? (
            <p className="break-all text-xs">
              Active turn: {active.find((a) => a.id === s.id)!.activeTurnId}
            </p>
          ) : null}
          <Link
            className="inline-block underline"
            to={`/artifacts?${new URLSearchParams({ sessionId: s.id })}`}
          >
            View artifacts
          </Link>
        </div>
      ))}
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

function EnvironmentEvents({ tenantId, id }: { tenantId: string; id: string }) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const accumulated = useRef<EnvironmentEvent[]>([]);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const from = accumulated.current.reduce(
        (n, e) => Math.max(n, e.seq + 1),
        0,
      );
      const next = await sdk.environments.events(id, { from, signal });
      signal.throwIfAborted();
      accumulated.current = Array.from(
        new Map(
          [...accumulated.current, ...next].map((e) => [e.seq, e]),
        ).values(),
      ).sort((a, b) => a.seq - b.seq);
      return accumulated.current;
    },
    [sdk, id],
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
        empty={read.data?.length ? undefined : "No lifecycle events."}
      />
      {read.data?.map((e) => (
        <details key={e.eventId} className="border-b py-2 text-sm">
          <summary className="break-all">
            {e.seq} · {e.type}
            <span className="block text-xs text-muted-foreground">
              {date(e.time)}
            </span>
          </summary>
          <pre className="mt-2 whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">
            {JSON.stringify(e.payload, null, 2)}
          </pre>
        </details>
      ))}
    </div>
  );
}
