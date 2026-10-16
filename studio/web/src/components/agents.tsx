import { useCallback, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { AgentManifestView, AgentView } from "@nylorun/agents";
import { ChevronDown, FileJson, LoaderCircle, Plus, X } from "lucide-react";
import { createTenantClient } from "@/proxy-client";
import { messageOf, useRead } from "@/resources/reads";
import type { AgentCatalog } from "@/resources/agents";
import { EMPTY_AGENT_FORM, agentRequest, type AgentForm } from "@/agent-form";
import { agentPath, manifestPath } from "@/agent-path";
import {
  AGENT_STATE_ORDER,
  NO_OWNER,
  agentActivity,
  agentGroups,
  agentsPath,
  filterAgents,
  labelsOf,
  manifestNameOf,
  ownerOf,
  sortAgents,
  stateLabel,
  type AgentFilter,
  type SessionActivity,
} from "@/agent-list";
import { STUDIO_OWNER } from "@/session-open";
import { fullTime, shortTime } from "@/time-format";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
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

export const date = (value?: string) =>
  value ? new Date(value).toLocaleString() : "—";

/** "2 other sessions run on it." for a confirmation, or nothing. */
export function otherSessionsNote(
  agent: Pick<AgentView, "sessions">,
  except?: string,
): string {
  const others = agent.sessions.filter((s) => s.id !== except).length;
  return others === 0
    ? ""
    : ` ${others} ${except ? "other " : ""}${others === 1 ? "session runs" : "sessions run"} on it.`;
}

/** The compute state an Agent shows: a pod's observed state, else its compute's. */
export const computeOf = (agent: Pick<AgentView, "compute">) =>
  agent.compute.pod?.observed ?? agent.compute.state;

/** Why an Agent is in its state, for a tooltip: the reasons behind it. */
export const attentionOf = (agent: Pick<AgentView, "attention" | "state">) =>
  agent.attention
    .filter((item) => item.state === agent.state)
    .map((item) => (item.sessionId ? `${item.sessionId}: ${item.reason}` : item.reason))
    .join("\n");

/** An Agent's state with a dot, or a spinner while it works. */
export function AgentState({ state, title }: Readonly<{ state: string; title?: string }>) {
  const label = stateLabel(state);
  if (state === "working")
    return (
      <span className="inline-flex items-center gap-1.5" title={title || undefined}>
        <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
        {label}
      </span>
    );
  const dot =
    state === "failing"
      ? "bg-red-500"
      : state === "input_required"
        ? "bg-amber-500"
        : state === "sleeping"
          ? "bg-emerald-500"
          : "bg-muted-foreground";
  return (
    <span className="inline-flex items-center gap-1.5" title={title || undefined}>
      <span className={"size-1.5 shrink-0 rounded-full " + dot} />
      {label}
    </span>
  );
}

/** The manifest version an Agent runs (`triage@3`), and whether it tracks or pins it. */
export function ManifestVersion({
  agent,
  onFilter,
}: Readonly<{ agent: AgentView; onFilter?: (manifest: string) => void }>) {
  const name = manifestNameOf(agent);
  const label = (
    <>
      <FileJson className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate font-mono text-xs">
        {name}@{agent.resolvedVersion}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {agent.tracking === "tracking" ? "tracks" : "pinned"}
      </span>
    </>
  );
  return onFilter ? (
    <button
      type="button"
      title={`Only Agents from ${name}`}
      className="inline-flex max-w-full min-w-0 items-center gap-2 underline-offset-4 hover:underline"
      onClick={(event) => {
        event.stopPropagation();
        onFilter(name);
      }}
    >
      {label}
    </button>
  ) : (
    <Link
      to={manifestPath(name, agent.resolvedVersion)}
      className="inline-flex max-w-full min-w-0 items-center gap-2 underline-offset-4 hover:underline"
    >
      {label}
    </Link>
  );
}

/** One filter menu of the Agents list: every value, or one of `options`. */
function FilterMenu({
  label,
  all,
  value,
  options,
  onPick,
}: Readonly<{
  label: string;
  all: string;
  value?: string;
  options: readonly { value: string; label: string; count: number }[];
  onPick: (value?: string) => void;
}>) {
  const [open, setOpen] = useState(false);
  const picked = options.find((option) => option.value === value);
  const pick = (next?: string) => {
    setOpen(false);
    onPick(next);
  };
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="w-36 justify-between font-normal" aria-label={label}>
          <span className="truncate">{value === undefined ? all : (picked?.label ?? value)}</span>
          <ChevronDown className="size-4 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuCheckboxItem checked={value === undefined} onCheckedChange={() => pick()}>
          {all}
        </DropdownMenuCheckboxItem>
        {options.map((option) => (
          <DropdownMenuCheckboxItem
            key={option.value}
            checked={option.value === value}
            onCheckedChange={() => pick(option.value)}
          >
            <span className="truncate">{option.label}</span>
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">{option.count}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** How many of `agents` have each value of `of`, in first-seen order unless `order` is given. */
function counted(agents: readonly AgentView[], of: (agent: AgentView) => string, order?: readonly string[]) {
  const counts = new Map<string, number>((order ?? []).map((value) => [value, 0]));
  for (const agent of agents) counts.set(of(agent), (counts.get(of(agent)) ?? 0) + 1);
  return [...counts].filter(([, count]) => order === undefined || count > 0);
}

/**
 * Agents (protocol 16): each is the live instance of one agent manifest version, with its
 * compute, its vault of secrets, its disk versions and the sessions that run on it. One table of
 * every Agent, those that need input or fail first, filtered by state, manifest, owner and label,
 * as the session list is by Agent. Each opens on its own page (`agent-page`).
 */
export function Agents({
  tenantId,
  catalog,
  sessions,
  filter,
}: Readonly<{
  tenantId: string;
  catalog: AgentCatalog;
  sessions: readonly SessionActivity[];
  filter: AgentFilter;
}>) {
  const navigate = useNavigate();
  const activity = useMemo(() => agentActivity(catalog.agents, sessions), [catalog.agents, sessions]);
  const agents = sortAgents(filterAgents(catalog.agents, filter), activity);
  const [creating, setCreating] = useState(false);
  const go = (patch: Partial<AgentFilter>) => void navigate(agentsPath({ ...filter, ...patch }));
  const withLabels = (labels: readonly string[]) => go({ labels });
  const groups = agentGroups(catalog.manifests, catalog.agents);
  const columns = 6;
  const message = (text: ReactNode) => (
    <TableRow>
      <TableCell colSpan={columns} className="h-28 text-center whitespace-normal text-muted-foreground">
        {text}
      </TableCell>
    </TableRow>
  );
  return (
    <section className="flex min-h-0 w-full flex-1 flex-col overflow-hidden">
      <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-3 border-b bg-background px-4 py-2">
        <h1 className="text-sm font-medium">Agents</h1>
        <span className="text-xs text-muted-foreground">{agents.length} total</span>
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
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <FilterMenu
            label="Filter by state"
            all="All states"
            value={filter.state}
            options={counted(catalog.agents, (agent) => agent.state, AGENT_STATE_ORDER).map(([value, count]) => ({
              value,
              label: stateLabel(value),
              count,
            }))}
            onPick={(state) => go({ state })}
          />
          <FilterMenu
            label="Filter by manifest"
            all="All manifests"
            value={filter.manifest}
            options={groups.map((group) => ({ value: group.name, label: group.name, count: group.agents.length }))}
            onPick={(manifest) => go({ manifest })}
          />
          <FilterMenu
            label="Filter by owner"
            all="All owners"
            value={filter.owner}
            options={counted(catalog.agents, ownerOf).map(([value, count]) => ({
              value,
              label: value === NO_OWNER ? "No owner guard" : value,
              count,
            }))}
            onPick={(owner) => go({ owner })}
          />
          <Button size="sm" onClick={() => setCreating(true)} disabled={catalog.manifests.length === 0}>
            <Plus />
            New Agent
          </Button>
        </div>
      </div>
      {catalog.manifestsError ? (
        <p role="status" className="shrink-0 border-b px-4 py-2 text-xs text-muted-foreground">
          Agent manifests unavailable: {catalog.manifestsError}
        </p>
      ) : null}
      <ScrollArea className="min-h-0 flex-1">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead className="w-60">Agent manifest</TableHead>
              <TableHead className="w-40">Owner</TableHead>
              <TableHead className="w-36">State</TableHead>
              <TableHead className="w-24 text-right">Sessions</TableHead>
              <TableHead className="w-40">Last activity</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {catalog.status === "Loading"
              ? message("Loading Agents…")
              : catalog.status === "Failed" && catalog.agents.length === 0
                ? message(
                    <span role="alert" className="inline-flex flex-col items-center gap-3">
                      {catalog.error}
                      <Button variant="outline" size="sm" onClick={catalog.reload} disabled={catalog.pending}>
                        Retry
                      </Button>
                    </span>,
                  )
                : agents.length === 0
                  ? message(
                      catalog.agents.length === 0
                        ? "No Agents yet. An Agent is the live instance of an agent manifest version: its compute, its secrets, its disk and its sessions. Save a manifest with nylorun apply, then make one from it."
                        : "No Agents match these filters.",
                    )
                  : agents.map((agent) => {
                      const href = agentPath(agent.id);
                      const at = activity.get(agent.id);
                      const labels = labelsOf(agent);
                      return (
                        <TableRow key={agent.id} className="cursor-pointer" onClick={() => void navigate(href)}>
                          <TableCell className="max-w-0">
                            <Link
                              to={href}
                              title={agent.id}
                              className="block truncate font-mono text-xs underline-offset-4 hover:underline"
                              onClick={(event) => event.stopPropagation()}
                            >
                              {agent.id}
                            </Link>
                            {labels.length ? (
                              <span className="mt-1 flex min-w-0 flex-wrap gap-1">
                                {labels.map((label) =>
                                  filter.labels.includes(label) ? (
                                    <Badge key={label} variant="secondary" className="max-w-full font-mono">
                                      <span className="truncate">{label}</span>
                                    </Badge>
                                  ) : (
                                    <button
                                      key={label}
                                      type="button"
                                      title={`Only Agents labelled ${label}`}
                                      className="max-w-full"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        withLabels([...filter.labels, label]);
                                      }}
                                    >
                                      <Badge variant="outline" className="max-w-full font-mono hover:bg-accent">
                                        <span className="truncate">{label}</span>
                                      </Badge>
                                    </button>
                                  ),
                                )}
                              </span>
                            ) : null}
                          </TableCell>
                          <TableCell className="max-w-0 truncate">
                            <ManifestVersion agent={agent} onFilter={(manifest) => go({ manifest })} />
                          </TableCell>
                          <TableCell className="max-w-0 truncate text-xs text-muted-foreground">
                            {agent.owner ?? "—"}
                          </TableCell>
                          <TableCell>
                            <AgentState state={agent.state} title={attentionOf(agent)} />
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{agent.sessions.length}</TableCell>
                          <TableCell className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                            {at ? (
                              <time dateTime={at} title={fullTime(at)}>
                                {shortTime(at)}
                              </time>
                            ) : (
                              "—"
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
          </TableBody>
        </Table>
      </ScrollArea>
      {creating ? (
        <NewAgentSheet
          tenantId={tenantId}
          manifests={catalog.manifests}
          {...(filter.manifest === undefined ? {} : { manifest: filter.manifest })}
          onClose={() => setCreating(false)}
          onCreated={(agent) => {
            setCreating(false);
            catalog.reload();
            void navigate(agentPath(agent.id));
          }}
        />
      ) : null}
    </section>
  );
}

/** One labelled field of a form, with an optional hint. */
export function Field({
  label,
  hint,
  children,
}: Readonly<{ label: string; hint?: string; children: ReactNode }>) {
  return (
    <div className="grid gap-1 text-sm">
      <label className="grid gap-1">
        {label}
        {children}
      </label>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

/**
 * Makes an Agent from a saved agent manifest (`PUT /v1/agents/{id}` with `manifest`): the
 * manifest and the version it pins, or none to track the manifest, its id, owner guard and
 * labels. Creating it opens no session.
 */
export function NewAgentSheet({
  tenantId,
  manifests,
  manifest,
  version,
  onClose,
  onCreated,
}: Readonly<{
  tenantId: string;
  manifests: readonly AgentManifestView[];
  /** The manifest picked first. */
  manifest?: string;
  /** The version picked first; none tracks the manifest. */
  version?: number;
  onClose: () => void;
  onCreated: (agent: AgentView) => void;
}>) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const sorted = [...manifests].sort((a, b) => a.name.localeCompare(b.name));
  const [form, setForm] = useState<AgentForm>({
    ...EMPTY_AGENT_FORM,
    manifest: manifest ?? sorted[0]?.name ?? "",
    version: version === undefined ? "" : String(version),
    owner: STUDIO_OWNER,
  });
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const set = (patch: Partial<AgentForm>) => setForm((current) => ({ ...current, ...patch }));
  const loadVersions = useCallback(
    (signal: AbortSignal) =>
      form.manifest ? sdk.agentManifests.versions(form.manifest, { signal }) : Promise.resolve(undefined),
    [sdk, form.manifest],
  );
  const versions = useRead(loadVersions).data;
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setPending(true);
    try {
      const { id, input } = agentRequest(form);
      onCreated(await sdk.agents.put(id, input));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <Sheet open onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent className="w-full sm:max-w-md">
        <form className="flex min-h-full flex-col" onSubmit={(event) => void submit(event)}>
          <SheetHeader>
            <SheetTitle>New Agent</SheetTitle>
            <SheetDescription>
              Made from a saved agent manifest: tracking it, it runs the latest version when it is
              made; pinned, the version picked. It keeps that version; a newer one reaches it by a
              fork. Write its secrets on its Secrets tab once it exists.
            </SheetDescription>
          </SheetHeader>
          <div className="grid gap-4 px-4">
            <Field label="Agent manifest">
              <select
                aria-label="Agent manifest"
                className="h-9 rounded-md border bg-transparent px-3"
                value={form.manifest}
                onChange={(event) => set({ manifest: event.target.value, version: "" })}
              >
                {sorted.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Version">
              <select
                aria-label="Version"
                className="h-9 rounded-md border bg-transparent px-3"
                value={form.version}
                onChange={(event) => set({ version: event.target.value })}
              >
                <option value="">Track the latest{versions ? ` (v${versions.latest})` : ""}</option>
                {(versions?.versions ?? []).map((v) => (
                  <option key={v.version} value={String(v.version)}>
                    Pin v{v.version}
                  </option>
                ))}
                {form.version && !versions?.versions.some((v) => String(v.version) === form.version) ? (
                  <option value={form.version}>Pin v{form.version}</option>
                ) : null}
              </select>
            </Field>
            <Field label="ID" hint="Such as users/alice/triage or team/build: segments of letters, digits, '.', '_' and '-'.">
              <Input
                value={form.id}
                onChange={(event) => set({ id: event.target.value })}
                className="font-mono"
                required
                autoFocus
              />
            </Field>
            <Field
              label="Owner (optional)"
              hint="The owner guard: only this owner's sessions may run on it. Studio's sessions are local-developer's."
            >
              <Input value={form.owner} onChange={(event) => set({ owner: event.target.value })} />
            </Field>
            <Field label="Labels" hint="One key=value per line.">
              <textarea
                aria-label="Labels"
                className="min-h-16 rounded-md border bg-background p-2 font-mono text-sm"
                value={form.labels}
                onChange={(event) => set({ labels: event.target.value })}
                placeholder="team=support"
              />
            </Field>
            {error ? (
              <p role="alert" className="break-words text-sm text-red-600">
                {error}
              </p>
            ) : null}
          </div>
          <SheetFooter className="mt-auto flex-row justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating" : "Create Agent"}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
