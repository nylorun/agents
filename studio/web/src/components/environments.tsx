import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { EnvironmentManifestView, EnvironmentView } from "@nylorun/agents";
import {
  Box,
  ChevronDown,
  FileJson,
  LoaderCircle,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { createTenantClient } from "@/proxy-client";
import { messageOf } from "@/resources/reads";
import type { EnvironmentCatalog } from "@/resources/environments";
import {
  EMPTY_ENVIRONMENT_FORM,
  EMPTY_FILE_ROW,
  EMPTY_SETUP_ROW,
  ENVIRONMENT_FORM_KINDS,
  SETUP_MAX,
  environmentForm,
  environmentRequest,
  forkForm,
  isEnvironmentIdText,
  type EnvironmentForm,
  type FileRow,
  type SetupRow,
} from "@/environment-form";
import { environmentPath } from "@/environment-path";
import {
  INLINE_MANIFEST,
  environmentGroups,
  environmentsPath,
  filterEnvironments,
  labelsOf,
  type EnvironmentFilter,
} from "@/environment-list";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ManifestBar,
  ManifestSheet,
  NewFromManifest,
} from "@/components/environment-manifests";

export const date = (value?: string) =>
  value ? new Date(value).toLocaleString() : "—";

/** The state an Environment shows: a pod's observed state, else the Environment's. */
export const stateOf = (environment: EnvironmentView) =>
  environment.pod?.observed ?? environment.state;

/** `3` or `3 (runs 2)` when a pod still runs an older recipe. */
export const versionOf = (environment: EnvironmentView) =>
  environment.appliedVersion === environment.version
    ? String(environment.version)
    : `${environment.version} (runs ${environment.appliedVersion})`;

/** "2 other sessions name it." for a confirmation, or nothing. */
export function otherSessionsNote(
  environment: Pick<EnvironmentView, "sessions">,
  except?: string,
): string {
  const others = environment.sessions.filter((s) => s.id !== except).length;
  return others === 0
    ? ""
    : ` ${others} ${except ? "other " : ""}${others === 1 ? "session names" : "sessions name"} it.`;
}

/**
 * Environments (protocol 11, D55): each is one sandbox (kind `virtual`, `pod` or `none`) with
 * one vault of secrets and versions of its disk, made from an environment manifest's version or
 * from inline fields. Sessions name one by id. One table of every Environment, filtered to a
 * manifest from the table, the menu or the manifests listed under Environments in the sidebar,
 * as the session list is to an agent. Each opens on its own page (`environment-page`).
 */
export function Environments({
  tenantId,
  catalog,
  filter,
}: Readonly<{
  tenantId: string;
  catalog: EnvironmentCatalog;
  filter: EnvironmentFilter;
}>) {
  const navigate = useNavigate();
  const groups = environmentGroups(catalog.manifests, catalog.environments);
  const byId = new Map(groups.map((group) => [group.id, group]));
  const environments = filterEnvironments(catalog.environments, filter);
  const active = filter.manifest === undefined ? undefined : byId.get(filter.manifest);
  const [filterOpen, setFilterOpen] = useState(false);
  const [creating, setCreating] = useState<EnvironmentManifestView | "inline">();
  const [editing, setEditing] = useState<EnvironmentManifestView | "new">();
  // One manifest at a time: picking one closes the menu; the labels stay.
  const filterOn = (manifest?: string): void => {
    setFilterOpen(false);
    void navigate(environmentsPath({ manifest, labels: filter.labels }));
  };
  const withLabels = (labels: readonly string[]) =>
    void navigate(environmentsPath({ manifest: filter.manifest, labels }));
  const filterLabel =
    filter.manifest === undefined
      ? "All manifests"
      : (active?.name ?? filter.manifest);
  const columns = 8;
  const message = (text: ReactNode) => (
    <TableRow>
      <TableCell colSpan={columns} className="h-28 text-center whitespace-normal text-muted-foreground">
        {text}
      </TableCell>
    </TableRow>
  );
  return (
    <section className="flex min-h-0 w-full flex-1 flex-col overflow-hidden">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b bg-background px-4">
        <h1 className="text-sm font-medium">Environments</h1>
        <span className="text-xs text-muted-foreground">
          {environments.length} total
        </span>
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          {filter.labels.map((label) => (
            <Badge key={label} variant="secondary" className="max-w-48 gap-1 font-mono">
              <span className="truncate">{label}</span>
              <button
                type="button"
                className="-mr-1 rounded-sm opacity-60 hover:opacity-100"
                aria-label={`Remove label filter ${label}`}
                onClick={() => withLabels(filter.labels.filter((l) => l !== label))}
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
        <DropdownMenu open={filterOpen} onOpenChange={setFilterOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto w-44 justify-between font-normal"
              aria-label="Filter by manifest"
            >
              <span className="truncate">{filterLabel}</span>
              <ChevronDown className="size-4 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuCheckboxItem
              checked={filter.manifest === undefined}
              onCheckedChange={() => filterOn()}
            >
              All manifests
              <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                {catalog.environments.length}
              </span>
            </DropdownMenuCheckboxItem>
            {groups.map((group) => (
              <DropdownMenuCheckboxItem
                key={group.id}
                checked={group.id === filter.manifest}
                onCheckedChange={() => filterOn(group.id)}
              >
                <span className="truncate">{group.name}</span>
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                  {group.count}
                </span>
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem inset onSelect={() => setEditing("new")}>
              <Plus />
              New manifest
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <NewEnvironmentButton
          manifests={catalog.manifests}
          filtered={filter.manifest}
          onPick={setCreating}
        />
      </div>
      {active?.manifest ? (
        <ManifestBar
          manifest={active.manifest}
          onNewVersion={() => setEditing(active.manifest)}
        />
      ) : null}
      {catalog.manifestsError ? (
        <p role="status" className="shrink-0 border-b px-4 py-2 text-xs text-muted-foreground">
          Environment manifests unavailable: {catalog.manifestsError}
        </p>
      ) : null}
      <ScrollArea className="min-h-0 flex-1">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <TableHead>Environment</TableHead>
              <TableHead className="w-56">Manifest</TableHead>
              <TableHead className="w-24">Kind</TableHead>
              <TableHead className="w-32">State</TableHead>
              <TableHead className="w-40">Owner</TableHead>
              <TableHead className="w-56">Labels</TableHead>
              <TableHead className="w-24 text-right">Sessions</TableHead>
              <TableHead className="w-48">Last used</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {catalog.status === "Loading"
              ? message("Loading Environments…")
              : catalog.status === "Failed" && catalog.environments.length === 0
                ? message(
                    <span role="alert" className="inline-flex flex-col items-center gap-3">
                      {catalog.error}
                      <Button variant="outline" size="sm" onClick={catalog.reload} disabled={catalog.pending}>
                        Retry
                      </Button>
                    </span>,
                  )
                : environments.length === 0
                  ? message(
                      catalog.environments.length === 0
                        ? "No Environments yet. An Environment is where sessions run: one sandbox, one vault of secrets and versions of its disk. Create one, then name it when you start a session."
                        : filter.labels.length
                          ? "No Environments match these filters."
                          : `No Environments from ${filterLabel}.`,
                    )
                  : environments.map((environment) => {
                      const href = environmentPath(environment.id);
                      return (
                        <TableRow
                          key={environment.id}
                          className="cursor-pointer"
                          onClick={() => void navigate(href)}
                        >
                          <TableCell className="max-w-0 truncate font-mono text-xs">
                            <Link
                              to={href}
                              title={environment.id}
                              className="underline-offset-4 hover:underline"
                              onClick={(event) => event.stopPropagation()}
                            >
                              {environment.id}
                            </Link>
                          </TableCell>
                          <TableCell className="max-w-0 truncate">
                            <ManifestName
                              environment={environment}
                              onFilter={(manifest) => filterOn(manifest)}
                            />
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">{environment.kind}</Badge>
                          </TableCell>
                          <TableCell>
                            <EnvironmentState state={stateOf(environment)} />
                          </TableCell>
                          <TableCell className="max-w-0 truncate text-xs text-muted-foreground">
                            {environment.ownerUserId ?? "—"}
                          </TableCell>
                          <TableCell className="max-w-0">
                            <EnvironmentLabels
                              labels={labelsOf(environment)}
                              active={filter.labels}
                              onFilter={(label) => withLabels([...filter.labels, label])}
                            />
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {environment.sessions.length}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {date(environment.lastUsedAt)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
          </TableBody>
        </Table>
      </ScrollArea>
      {creating === "inline" ? (
        <EnvironmentSheet
          tenantId={tenantId}
          onClose={() => setCreating(undefined)}
          onSaved={(environment) => {
            setCreating(undefined);
            catalog.reload();
            void navigate(environmentPath(environment.id));
          }}
        />
      ) : creating ? (
        <NewFromManifest
          tenantId={tenantId}
          manifest={creating}
          onClose={() => setCreating(undefined)}
          onCreated={() => catalog.reload()}
        />
      ) : null}
      {editing ? (
        <ManifestSheet
          tenantId={tenantId}
          {...(editing === "new" ? {} : { from: editing })}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            catalog.reload();
          }}
        />
      ) : null}
    </section>
  );
}

/** The manifest and version an Environment was made from, which filters the list to it. */
function ManifestName({
  environment,
  onFilter,
}: Readonly<{ environment: EnvironmentView; onFilter: (manifest: string) => void }>) {
  if (environment.manifestName === undefined)
    return <span className="text-xs text-muted-foreground">Inline fields</span>;
  const name = environment.manifestName;
  return (
    <button
      type="button"
      title={`Only Environments from ${name}`}
      className="inline-flex max-w-full min-w-0 items-center gap-2 underline-offset-4 hover:underline"
      onClick={(event) => {
        event.stopPropagation();
        onFilter(name);
      }}
    >
      <FileJson className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate">{name}</span>
      {environment.manifestVersion === undefined ? null : (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          v{environment.manifestVersion}
        </span>
      )}
    </button>
  );
}

/** An Environment's labels; one not filtered on yet adds itself to the filter. */
function EnvironmentLabels({
  labels,
  active,
  onFilter,
}: Readonly<{
  labels: readonly string[];
  active: readonly string[];
  onFilter: (label: string) => void;
}>) {
  if (labels.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {labels.map((label) =>
        active.includes(label) ? (
          <Badge key={label} variant="secondary" className="max-w-full font-mono">
            <span className="truncate">{label}</span>
          </Badge>
        ) : (
          <button
            key={label}
            type="button"
            title={`Only Environments labelled ${label}`}
            className="max-w-full"
            onClick={(event) => {
              event.stopPropagation();
              onFilter(label);
            }}
          >
            <Badge variant="outline" className="max-w-full font-mono hover:bg-accent">
              <span className="truncate">{label}</span>
            </Badge>
          </button>
        ),
      )}
    </span>
  );
}

/** An Environment's state with a dot, or a spinner while it changes. */
function EnvironmentState({ state }: Readonly<{ state: string }>) {
  const label = state.charAt(0).toUpperCase() + state.slice(1);
  if (state === "creating" || state === "starting" || state === "stopping")
    return (
      <span className="inline-flex items-center gap-1.5">
        <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
        {label}
      </span>
    );
  const dot =
    state === "failed"
      ? "bg-red-500"
      : state === "running" || state === "ready"
        ? "bg-emerald-500"
        : state === "stopped" || state === "suspended" || state === "deleted"
          ? "bg-muted-foreground"
          : "bg-amber-500";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={"size-1.5 shrink-0 rounded-full " + dot} />
      {label}
    </span>
  );
}

/**
 * Makes an Environment from the filtered manifest (or inline fields), or from the manifest
 * picked from a menu.
 */
function NewEnvironmentButton({
  manifests,
  filtered,
  onPick,
}: Readonly<{
  manifests: readonly EnvironmentManifestView[];
  filtered?: string;
  onPick: (from: EnvironmentManifestView | "inline") => void;
}>) {
  const manifest = manifests.find((m) => m.name === filtered);
  if (manifest || filtered === INLINE_MANIFEST || manifests.length === 0)
    return (
      <Button size="sm" onClick={() => onPick(manifest ?? "inline")}>
        <Plus />
        New Environment
      </Button>
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm">
          <Plus />
          New Environment
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          From a manifest
        </DropdownMenuLabel>
        {[...manifests]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((m) => (
            <DropdownMenuItem key={m.name} onSelect={() => onPick(m)}>
              <FileJson />
              <span className="truncate">{m.name}</span>
              <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                v{m.version}
              </span>
            </DropdownMenuItem>
          ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onPick("inline")}>
          <Box />
          From inline fields
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
 * starts from stopped, and setup and files at its next reset. With `fork`, the new Environment's
 * disk starts from that version of the source's disk (its vault starts empty).
 */
export function EnvironmentSheet({
  tenantId,
  existing,
  fork,
  onClose,
  onSaved,
}: {
  tenantId: string;
  existing?: EnvironmentView;
  fork?: { source: EnvironmentView; version: number };
  onClose: () => void;
  onSaved: (environment: EnvironmentView) => void;
}) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const [form, setForm] = useState<EnvironmentForm>(() =>
    existing
      ? environmentForm(existing)
      : fork
        ? forkForm(fork.source, `${fork.source.id}-v${fork.version}`)
        : EMPTY_ENVIRONMENT_FORM,
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
        await sdk.environments.put(
          id,
          environmentRequest(
            form,
            existing,
            fork ? { environment: fork.source.id, version: fork.version } : undefined,
          ),
        ),
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
            {existing
              ? `Edit ${existing.id}`
              : fork
                ? `New Environment from ${fork.source.id} v${fork.version}`
                : "New Environment"}
          </SheetTitle>
          <SheetDescription>
            {existing
              ? "An Environment never changes what it runs: here only its labels and owner guard change. To run something else, make a new Environment, from a version of this one's disk on its Disk tab."
              : fork
                ? `Its disk starts as version ${fork.version} of ${fork.source.id}'s disk, with the same recipe. Its vault starts empty: write its secrets once it exists.`
                : "Empty fields take this Tenant's defaults. Write its secrets on its Secrets tab once it exists."}
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
          <fieldset disabled={existing !== undefined} className="contents">
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
          <Field label="Harness" hint="The harness that runs its sessions. Default: nylorun, ours.">
            <Input
              value={form.harness}
              onChange={(event) => set({ harness: event.target.value })}
              placeholder="nylorun"
              className="font-mono"
            />
          </Field>
          {pod ? (
            <>
              <SetupRows
                rows={form.setup}
                onChange={(setup) => set({ setup })}
              />
              <FileRows rows={form.files} onChange={(files) => set({ files })} />
            </>
          ) : null}
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
          </fieldset>
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
                  ? "Save labels and owner"
                  : fork
                    ? "Create from version"
                    : "Create Environment"}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

/** A list of rows the recipe form edits: add, change and remove, in order. */
function Rows<Row>({
  legend,
  hint,
  rows,
  empty,
  add,
  onChange,
  render,
}: {
  legend: string;
  hint: string;
  rows: readonly Row[];
  empty: Row;
  add: string;
  onChange: (rows: Row[]) => void;
  render: (row: Row, n: number, set: (patch: Partial<Row>) => void) => ReactNode;
}) {
  const set = (index: number, patch: Partial<Row>) =>
    onChange(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  return (
    <fieldset className="grid gap-2 text-sm">
      <legend className="mb-1">{legend}</legend>
      <span className="-mt-1 text-xs text-muted-foreground">{hint}</span>
      {rows.map((row, index) => (
        <div key={index} className="flex items-start gap-2 rounded-md border p-2">
          <div className="grid min-w-0 flex-1 gap-2">
            {render(row, index + 1, (patch) => set(index, patch))}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${legend.toLowerCase().replace(/s$/u, "")} ${index + 1}`}
            onClick={() => onChange(rows.filter((_, at) => at !== index))}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="justify-self-start"
        disabled={rows.length >= SETUP_MAX}
        onClick={() => onChange([...rows, empty])}
      >
        <Plus />
        {add}
      </Button>
    </fieldset>
  );
}

/** A pod's setup commands: run in order when its disk is made or reset, before any turn. */
function SetupRows({
  rows,
  onChange,
}: {
  rows: readonly SetupRow[];
  onChange: (rows: SetupRow[]) => void;
}) {
  return (
    <Rows
      legend="Setup commands"
      hint="Run in order on a new disk (created or reset), after the input files, before any turn."
      rows={rows}
      empty={EMPTY_SETUP_ROW}
      add="Add setup command"
      onChange={onChange}
      render={(row, n, set) => (
        <>
          <Input
            aria-label={`Setup command ${n}`}
            value={row.command}
            onChange={(event) => set({ command: event.target.value })}
            placeholder="pip install -r requirements.txt"
            className="font-mono"
          />
          <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-2">
            <Input
              aria-label={`Setup command ${n} directory`}
              value={row.cwd}
              onChange={(event) => set({ cwd: event.target.value })}
              placeholder="/workspace"
              className="font-mono"
            />
            <Input
              aria-label={`Setup command ${n} timeout`}
              value={row.timeout}
              onChange={(event) => set({ timeout: event.target.value })}
              placeholder="10m"
              className="font-mono"
            />
          </div>
        </>
      )}
    />
  );
}

/** A pod's input files: versions of Tenant-wide artifacts, copied in on a new disk. */
function FileRows({
  rows,
  onChange,
}: {
  rows: readonly FileRow[];
  onChange: (rows: FileRow[]) => void;
}) {
  return (
    <Rows
      legend="Input files"
      hint="A version of a Tenant-wide artifact, copied in on a new disk: a file at the path, a folder unpacked under it."
      rows={rows}
      empty={EMPTY_FILE_ROW}
      add="Add input file"
      onChange={onChange}
      render={(row, n, set) => (
        <>
          <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,1fr)] gap-2">
            <Input
              aria-label={`Input file ${n} artifact`}
              value={row.artifactId}
              onChange={(event) => set({ artifactId: event.target.value })}
              placeholder="af_01k…"
              className="font-mono"
            />
            <Input
              aria-label={`Input file ${n} version`}
              value={row.version}
              onChange={(event) => set({ version: event.target.value })}
              placeholder="1"
              inputMode="numeric"
            />
          </div>
          <Input
            aria-label={`Input file ${n} path`}
            value={row.path}
            onChange={(event) => set({ path: event.target.value })}
            placeholder="/workspace/data"
            className="font-mono"
          />
        </>
      )}
    />
  );
}
