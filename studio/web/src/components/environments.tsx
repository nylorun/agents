import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { EnvironmentView } from "@nylorun/agents";
import { Plus, Trash2 } from "lucide-react";
import { createTenantClient } from "@/proxy-client";
import { messageOf, usePages } from "@/resources/reads";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ReadState } from "@/components/resource-layout";
import { EnvironmentManifests } from "@/components/environment-manifests";

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
 * Environments (protocol 11, D55): each is one sandbox (kind `virtual`, `pod` or `none`) with a
 * recipe that can change, one vault of secrets, and versions of its disk. Sessions name one by
 * id. Each opens on its own page (`environment-page`).
 */
export function Environments({ tenantId }: { tenantId: string }) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const navigate = useNavigate();
  const [query, setQuery] = useSearchParams();
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
      const page = await sdk.environments
        .page({ labels, limit: 50, cursor, signal })
        .catch((cause: unknown) => {
          // A body without the list (`{}`) fails the page's schema: say what is missing.
          if (cause instanceof Error && cause.name === "ZodError")
            throw new Error("The Runtime did not return the Tenant's Environments.");
          throw cause;
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
  return (
    <section className="min-h-0 flex-1 overflow-auto">
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
        <p className="max-w-3xl text-sm text-muted-foreground">
          An Environment is where sessions run: one sandbox, one vault of secrets, and
          versions of its disk. A session that names it runs in its sandbox and sends its
          credentials; a session without one has neither. Who shares an Environment is
          the app's choice: one per session, per person or per project.
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
                className="cursor-pointer"
                onClick={() => navigate(environmentPath(s.id))}
              >
                <TableCell className="whitespace-normal break-all">
                  <Link
                    className="font-medium underline-offset-4 hover:underline"
                    to={environmentPath(s.id)}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {s.id}
                  </Link>
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
        <EnvironmentManifests tenantId={tenantId} />
      </div>
      {creating ? (
        <EnvironmentSheet
          tenantId={tenantId}
          onClose={() => setCreating(false)}
          onSaved={(environment) => {
            setCreating(false);
            navigate(environmentPath(environment.id));
          }}
        />
      ) : null}
    </section>
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
