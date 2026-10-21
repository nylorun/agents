import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { AgentManifestView } from "@nylorun/agents";
import { Tabs as TabsPrimitive } from "radix-ui";
import { FolderTree, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { createTenantClient } from "@/proxy-client";
import { useRead } from "@/resources/reads";
import type { AgentCatalog } from "@/resources/agents";
import { agentPath } from "@/agent-path";
import { isFlowManifest, manifestNameOf, stateLabel } from "@/agent-list";
import { flowOf, manifestSpec } from "@/agent-spec";
import { ManifestSpec } from "@/components/manifest-spec";
import { withPolicyNotes } from "@/tenant-spec";
import { useToolRules } from "@/resources/tool-policy";
import { fullTime, shortTime } from "@/time-format";
import { Button } from "@/components/ui/button";
import { ReadState } from "@/components/resource-layout";
import { NewAgentSheet } from "@/components/agents";
import { UploadFolder } from "@/components/folder-upload";
import { ManifestSource } from "@/components/manifest-source";
import { ViewOption, ViewSwitch } from "@/components/view-switch";
import {
  ActionMenu,
  CodeBlock,
  EmptyRow,
  FilterMenu,
  SearchBox,
  TableFrame,
  TableToolbar,
  ToolbarCount,
  cellClass,
  countText,
  headClass,
  menuCellClass,
  rowClass,
} from "@/components/data-table";
import { STATUS_DOT } from "@/lib/status";

/** What runs a manifest's Agents: `virtual`, `pod`, or `none` without a runtime section. */
const kindOf = (manifest: Pick<AgentManifestView, "manifest">) => manifest.manifest.runtime?.kind ?? "none";

const EDIT_HINT =
  "Manifests are not edited here: edit an agent's folder in its repository, then save its next version with Upload folder or nylorun apply.";

/** A version saved from an agent folder (track T6), in words: its compiler and size. */
const fromFolder = (source: NonNullable<AgentManifestView["source"]>) =>
  `Saved from an agent folder: ${source.compiler}, ${source.files === 1 ? "1 file" : `${source.files} files`}`;

/** The pane's views: the version as a readable spec, and the folder it was saved from. */
type PaneView = "spec" | "source";

/** An Agent's state as a dot: darkest when it fails or needs input. */
const stateDot = (state: string) =>
  state === "failing" || state === "input_required" ? STATUS_DOT.attention : STATUS_DOT.running;

type Kind = "any" | "pod" | "virtual" | "none";
type Type = "any" | "agent" | "flow";
type Use = "any" | "used" | "unused";

/**
 * The Tenant's agent manifests (protocol 16, track T2): one line each with its latest version,
 * the kind of Agent it makes, how many Agents were made from it and when it was saved, searched
 * and filtered on top. A manifest is not edited here: its folder is saved from its repository
 * (`nylorun apply`) or uploaded (Upload folder, track T7). A row opens the manifest beside the
 * list (`?selected=<name>&version=<n>`), as a readable spec or, with `&view=source`, the folder
 * it was saved from.
 */
export function AgentManifests({ tenantId, catalog }: Readonly<{ tenantId: string; catalog: AgentCatalog }>) {
  const [query, setQuery] = useSearchParams();
  const selected = query.get("selected") ?? undefined;
  const asked = Number(query.get("version"));
  const version = Number.isSafeInteger(asked) && asked > 0 ? asked : undefined;
  const view: PaneView = query.get("view") === "source" ? "source" : "spec";
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<Kind>("any");
  const [type, setType] = useState<Type>("any");
  const [use, setUse] = useState<Use>("any");
  const [creating, setCreating] = useState<{ name: string; version: number }>();
  const navigate = useNavigate();
  const manifests = [...catalog.manifests].sort((a, b) => a.name.localeCompare(b.name));
  const counts = new Map<string, number>();
  for (const agent of catalog.agents)
    counts.set(manifestNameOf(agent), (counts.get(manifestNameOf(agent)) ?? 0) + 1);
  const needle = search.trim().toLowerCase();
  const shown = manifests.filter(
    (m) =>
      (kind === "any" || kindOf(m) === kind) &&
      (type === "any" || (type === "flow") === isFlowManifest(m)) &&
      (use === "any" || (use === "used") === (counts.get(m.name) ?? 0) > 0) &&
      (needle === "" ||
        m.name.toLowerCase().includes(needle) ||
        (m.manifest.description ?? "").toLowerCase().includes(needle)),
  );
  function open(name?: string, v?: number, nextView: PaneView = view) {
    const next = new URLSearchParams(query);
    if (name === undefined) next.delete("selected");
    else next.set("selected", name);
    // Always in this order: `&version=<n>&view=source`.
    next.delete("version");
    next.delete("view");
    if (v !== undefined) next.set("version", String(v));
    if (name !== undefined && nextView === "source") next.set("view", nextView);
    setQuery(next);
  }
  const wide = selected === undefined;
  const columns = wide ? 7 : 5;
  return (
    <div className="flex min-h-0 w-full flex-1 overflow-hidden">
      <section
        className={cn("min-h-0 min-w-0 flex-1 flex-col overflow-auto", wide ? "flex" : "hidden xl:flex")}
        aria-label="Agent manifests"
      >
        <TableToolbar>
          <h2 className="sr-only">Agent manifests</h2>
          <SearchBox label="Search manifests" value={search} onChange={setSearch} />
          <FilterMenu
            label="Kind"
            value={kind}
            options={[
              { value: "any", label: "Any" },
              { value: "pod", label: "pod" },
              { value: "virtual", label: "virtual" },
              { value: "none", label: "none" },
            ]}
            onChange={setKind}
          />
          <FilterMenu
            label="Type"
            value={type}
            options={[
              { value: "any", label: "Any" },
              { value: "agent", label: "Agent" },
              { value: "flow", label: "Flow" },
            ]}
            onChange={setType}
          />
          <FilterMenu
            label="Agents"
            value={use}
            options={[
              { value: "any", label: "Any" },
              { value: "used", label: "In use" },
              { value: "unused", label: "None yet" },
            ]}
            onChange={setUse}
          />
          <ToolbarCount>{countText(shown.length, manifests.length, "manifest", "manifests")}</ToolbarCount>
          <UploadFolder
            tenantId={tenantId}
            hint={EDIT_HINT}
            onSaved={(name, saved) => {
              catalog.reload();
              open(name, saved, "source");
            }}
          />
        </TableToolbar>
        {/* Beside the pane the list fits its width: no column runs under the pane. */}
        <TableFrame {...(wide ? { minWidth: 900 } : {})}>
          <thead>
            <tr>
              <th className={`${headClass} ${wide ? "w-[22%]" : ""}`}>Manifest</th>
              {wide ? <th className={headClass}>Description</th> : null}
              <th className={`${headClass} w-20`}>Latest</th>
              <th className={`${headClass} w-28`}>Kind</th>
              <th className={`${headClass} w-20 text-right`}>Agents</th>
              {wide ? <th className={`${headClass} w-36`}>Saved</th> : null}
              <th className={`${headClass} w-12`}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {catalog.status === "Loading" ? (
              <EmptyRow columns={columns}>Loading agent manifests…</EmptyRow>
            ) : catalog.manifestsError && manifests.length === 0 ? (
              <EmptyRow columns={columns}>
                <span role="alert" className="inline-flex flex-col items-center gap-3">
                  {catalog.manifestsError}
                  <Button variant="outline" size="sm" onClick={catalog.reload} disabled={catalog.pending}>
                    Retry
                  </Button>
                </span>
              </EmptyRow>
            ) : shown.length === 0 ? (
              <EmptyRow columns={columns}>
                {manifests.length === 0
                  ? "No agent manifests yet. An agent manifest holds what runs inside the loop (its harness section) and what the Runtime provides around it (its runtime section). Save one from its folder with Upload folder or nylorun apply."
                  : "No manifests match these filters."}
              </EmptyRow>
            ) : (
              shown.map((manifest) => {
                const agents = counts.get(manifest.name) ?? 0;
                return (
                  <tr
                    key={manifest.name}
                    className={`${rowClass} cursor-pointer`}
                    data-state={manifest.name === selected ? "selected" : undefined}
                    onClick={() => open(manifest.name)}
                  >
                    <td className={cellClass}>
                      <button
                        type="button"
                        className="max-w-full truncate font-mono text-[13px] underline-offset-4 hover:underline"
                        aria-label={manifest.name}
                        onClick={(event) => {
                          event.stopPropagation();
                          open(manifest.name);
                        }}
                      >
                        {manifest.name}
                      </button>
                    </td>
                    {wide ? (
                      <td className={`${cellClass} text-muted-foreground`} title={manifest.manifest.description}>
                        {manifest.manifest.description ?? "—"}
                      </td>
                    ) : null}
                    <td className={`${cellClass} tabular-nums`}>
                      <span className="inline-flex items-center gap-1.5">
                        <span>v{manifest.version}</span>
                        {manifest.source ? (
                          <span title={fromFolder(manifest.source)} className="inline-flex text-muted-foreground">
                            <FolderTree className="size-3.5 shrink-0" aria-hidden />
                            <span className="sr-only">from folder</span>
                          </span>
                        ) : null}
                      </span>
                    </td>
                    <td className={`${cellClass} text-muted-foreground`}>
                      {isFlowManifest(manifest) ? `flow · ${kindOf(manifest)}` : kindOf(manifest)}
                    </td>
                    <td className={`${cellClass} text-right tabular-nums ${agents ? "" : "text-muted-foreground/60"}`}>
                      {agents}
                    </td>
                    {wide ? (
                      <td
                        className={`${cellClass} text-muted-foreground tabular-nums`}
                        title={`${fullTime(manifest.createdAt)} by ${manifest.savedBy.actor}`}
                      >
                        {shortTime(manifest.createdAt)}
                      </td>
                    ) : null}
                    <td className={menuCellClass}>
                      <ActionMenu
                        label={`Actions for ${manifest.name}`}
                        actions={[
                          { label: "Open", onSelect: () => open(manifest.name) },
                          {
                            label: `New Agent from v${manifest.version}…`,
                            onSelect: () => setCreating({ name: manifest.name, version: manifest.version }),
                          },
                          { label: "Copy name", onSelect: () => void navigator.clipboard.writeText(manifest.name) },
                        ]}
                      />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </TableFrame>
      </section>
      {selected !== undefined ? (
        <ManifestPane
          key={selected}
          tenantId={tenantId}
          name={selected}
          {...(version === undefined ? {} : { version })}
          view={view}
          catalog={catalog}
          onVersion={(v) => open(selected, v)}
          onView={(v) => open(selected, version, v)}
          onCreate={(v) => setCreating({ name: selected, version: v })}
          onClose={() => open()}
        />
      ) : null}
      {creating ? (
        <NewAgentSheet
          tenantId={tenantId}
          manifests={catalog.manifests}
          manifest={creating.name}
          version={creating.version}
          onClose={() => setCreating(undefined)}
          onCreated={(agent) => {
            setCreating(undefined);
            catalog.reload();
            void navigate(agentPath(agent.id));
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * One manifest beside the list: a version (its latest unless `version` names one), its
 * description, the Agents made from it, and two views of the version: **Spec**, the version as a
 * readable spec, its harness section then its runtime section, one line each (a line opens its
 * part of the manifest), and **Source**, the agent folder it was saved from (track T7).
 */
function ManifestPane({
  tenantId,
  name,
  version,
  view,
  catalog,
  onVersion,
  onView,
  onCreate,
  onClose,
}: Readonly<{
  tenantId: string;
  name: string;
  version?: number;
  view: PaneView;
  catalog: AgentCatalog;
  onVersion: (version: number) => void;
  onView: (view: PaneView) => void;
  onCreate: (version: number) => void;
  onClose: () => void;
}>) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const loadVersions = useCallback((signal: AbortSignal) => sdk.agentManifests.versions(name, { signal }), [sdk, name]);
  const versions = useRead(loadVersions);
  const loadVersion = useCallback(
    (signal: AbortSignal) => sdk.agentManifests.get(name, version, { signal }),
    [sdk, name, version],
  );
  const read = useRead(loadVersion);
  const shown = read.data;
  const [json, setJson] = useState(false);
  const agents = catalog.agents.filter((agent) => manifestNameOf(agent) === name);
  const latest = versions.data?.latest;
  // Each tool the policy may decide calls of notes its rules, which the Tool policy tab edits.
  const rules = useToolRules(tenantId);
  const sections = shown ? withPolicyNotes(manifestSpec(shown.manifest), rules, name) : [];
  const flow = shown ? flowOf((shown.manifest as { harness?: unknown }).harness, name) : undefined;
  return (
    <aside
      aria-label={name}
      className="flex min-h-0 w-full shrink-0 flex-col border-l bg-background xl:w-[560px]"
    >
      <div className="flex items-center gap-1.5 border-b py-3 pr-2.5 pl-5">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-mono text-sm font-semibold">{name}</h2>
          {shown ? (
            <p className="truncate text-xs text-muted-foreground" title={fullTime(shown.createdAt)}>
              v{shown.version}
              {latest !== undefined ? (shown.version === latest ? " · latest" : ` of ${latest}`) : ""}
              {shown.source ? <span title={fromFolder(shown.source)}> · from folder</span> : null} · saved{" "}
              {shortTime(shown.createdAt)} by {shown.savedBy.actor}
            </p>
          ) : null}
        </div>
        {versions.data ? (
          <FilterMenu
            label="Version"
            value={String(shown?.version ?? versions.data.latest)}
            options={versions.data.versions.map((v) => ({
              value: String(v.version),
              label: `v${v.version}${v.version === versions.data!.latest ? " · latest" : ""}`,
            }))}
            onChange={(value) => {
              onVersion(Number(value));
            }}
          />
        ) : null}
        <ActionMenu
          label={`${name} actions`}
          actions={
            shown
              ? [
                  { label: `New Agent from v${shown.version}…`, onSelect: () => onCreate(shown.version) },
                  { label: json ? "Hide JSON" : "View JSON", onSelect: () => setJson((on) => !on) },
                  { label: "Copy name", onSelect: () => void navigator.clipboard.writeText(name) },
                ]
              : []
          }
        />
        <Button variant="ghost" size="icon-sm" aria-label="Close manifest" title="Close" onClick={onClose}>
          <X />
        </Button>
      </div>
      <TabsPrimitive.Root
        value={view}
        onValueChange={(value) => onView(value === "source" ? "source" : "spec")}
        className="flex min-h-0 flex-1 flex-col"
      >
        <ViewSwitch label="Manifest views">
          <ViewOption value="spec">Spec</ViewOption>
          <ViewOption value="source">Source</ViewOption>
        </ViewSwitch>
        <TabsPrimitive.Content value="source" className="min-h-0 flex-1 overflow-y-auto pb-8 outline-none">
          <ReadState {...read} onRetry={read.reload} />
          {shown ? (
            <ManifestSource
              key={shown.version}
              tenantId={tenantId}
              name={name}
              version={shown.version}
              {...(shown.source ? { summary: shown.source } : {})}
            />
          ) : null}
        </TabsPrimitive.Content>
        <TabsPrimitive.Content value="spec" className="min-h-0 flex-1 overflow-y-auto pb-8 outline-none">
          <ReadState {...read} onRetry={read.reload} />
          {shown ? (
            <>
              <div className="space-y-3 px-5 pt-4 pb-1">
                {shown.manifest.description ? <p className="text-sm">{shown.manifest.description}</p> : null}
                <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
                  <span className="mr-1 text-muted-foreground">Agents</span>
                  {agents.length ? (
                    agents.map((agent) => (
                      <Link
                        key={agent.id}
                        to={agentPath(agent.id)}
                        title={`${agent.id} · ${stateLabel(agent.state)} · runs v${agent.resolvedVersion}, ${agent.tracking === "tracking" ? "tracking" : "pinned"}`}
                        className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border px-2 text-xs hover:bg-muted"
                      >
                        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", stateDot(agent.state))} />
                        <span className="truncate font-mono">{agent.id}</span>
                        <span className="text-muted-foreground">v{agent.resolvedVersion}</span>
                      </Link>
                    ))
                  ) : (
                    <span className="text-muted-foreground">None yet</span>
                  )}
                </div>
              </div>
              {json ? (
                <div className="px-5 pt-3">
                  <CodeBlock label="The whole manifest">{JSON.stringify(shown.manifest, null, 2)}</CodeBlock>
                </div>
              ) : null}
              <div className="pt-3">
                <ManifestSpec
                  // A version's rows are its own: none stays open across versions.
                  key={shown.version}
                  sections={sections}
                  {...(flow ? { flow, flowHint: `as v${shown.version} declares them` } : {})}
                  detail="inline"
                  gutter="px-5"
                />
              </div>
            </>
          ) : null}
        </TabsPrimitive.Content>
      </TabsPrimitive.Root>
    </aside>
  );
}
