import { Fragment, useCallback, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { AgentManifestView } from "@nylorun/agents";
import { Lock, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { createTenantClient } from "@/proxy-client";
import { useRead } from "@/resources/reads";
import type { AgentCatalog } from "@/resources/agents";
import { agentPath } from "@/agent-path";
import { isFlowManifest, manifestNameOf, stateLabel } from "@/agent-list";
import { manifestSpec } from "@/agent-spec";
import { withPolicyNotes } from "@/tenant-spec";
import { useToolRules } from "@/resources/tool-policy";
import { fullTime, shortTime } from "@/time-format";
import { Button } from "@/components/ui/button";
import { ReadState } from "@/components/resource-layout";
import { NewAgentSheet } from "@/components/agents";
import {
  ActionMenu,
  CodeBlock,
  EmptyRow,
  FilterMenu,
  SearchBox,
  StatusDot,
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
  "Agent manifests are read only here: edit one in its repository and save its next version with nylorun apply.";

/** An Agent's state as a dot: darkest when it fails or needs input. */
const stateDot = (state: string) =>
  state === "failing" || state === "input_required" ? STATUS_DOT.attention : STATUS_DOT.running;

type Kind = "any" | "pod" | "virtual" | "none";
type Type = "any" | "agent" | "flow";
type Use = "any" | "used" | "unused";

/**
 * The Tenant's agent manifests (protocol 16, track T2): one line each with its latest version,
 * the kind of Agent it makes, how many Agents were made from it and when it was saved, searched
 * and filtered on top. Read only: a manifest is saved from its repository (`nylorun apply`). A
 * row opens the manifest beside the list (`?selected=<name>&version=<n>`), as a readable spec.
 */
export function AgentManifests({ tenantId, catalog }: Readonly<{ tenantId: string; catalog: AgentCatalog }>) {
  const [query, setQuery] = useSearchParams();
  const selected = query.get("selected") ?? undefined;
  const asked = Number(query.get("version"));
  const version = Number.isSafeInteger(asked) && asked > 0 ? asked : undefined;
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
  function open(name?: string, v?: number) {
    const next = new URLSearchParams(query);
    if (name === undefined) next.delete("selected");
    else next.set("selected", name);
    if (v === undefined) next.delete("version");
    else next.set("version", String(v));
    setQuery(next);
  }
  const wide = selected === undefined;
  const columns = wide ? 7 : 5;
  return (
    <div className="flex min-h-0 w-full flex-1 overflow-hidden">
      <section
        className={cn("min-h-0 min-w-0 flex-1 flex-col overflow-auto", wide ? "flex" : "hidden lg:flex")}
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
          <span
            title={EDIT_HINT}
            className="inline-flex h-8 shrink-0 cursor-help items-center gap-1.5 rounded-md border px-2.5 text-[13px] text-muted-foreground"
          >
            <Lock className="size-3.5" aria-hidden />
            Read only · <span className="font-mono text-xs">nylorun apply</span>
            <span className="sr-only">{EDIT_HINT}</span>
          </span>
        </TableToolbar>
        <TableFrame minWidth={wide ? 900 : 480}>
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
                  ? "No agent manifests yet. An agent manifest holds what runs inside the loop (its harness section) and what the Runtime provides around it (its runtime section). Save one with nylorun apply."
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
                    <td className={`${cellClass} tabular-nums`}>v{manifest.version}</td>
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
          catalog={catalog}
          onVersion={(v) => open(selected, v)}
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
 * description, the Agents made from it, and the version as a readable spec, its harness section
 * then its runtime section, one line each. A line opens its part of the manifest.
 */
function ManifestPane({
  tenantId,
  name,
  version,
  catalog,
  onVersion,
  onCreate,
  onClose,
}: Readonly<{
  tenantId: string;
  name: string;
  version?: number;
  catalog: AgentCatalog;
  onVersion: (version: number) => void;
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
  const [open, setOpen] = useState<string>();
  const [json, setJson] = useState(false);
  const agents = catalog.agents.filter((agent) => manifestNameOf(agent) === name);
  const latest = versions.data?.latest;
  // Each tool the policy may decide calls of notes its rules, which the Tool policy tab edits.
  const rules = useToolRules(tenantId);
  const sections = shown ? withPolicyNotes(manifestSpec(shown.manifest), rules, name) : [];
  return (
    <aside
      aria-label={name}
      className="flex min-h-0 w-full shrink-0 flex-col border-l bg-background lg:w-[560px]"
    >
      <div className="flex items-center gap-1.5 border-b py-3 pr-2.5 pl-5">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-mono text-sm font-semibold">{name}</h2>
          {shown ? (
            <p className="truncate text-xs text-muted-foreground" title={fullTime(shown.createdAt)}>
              v{shown.version}
              {latest !== undefined ? (shown.version === latest ? " · latest" : ` of ${latest}`) : ""} · saved{" "}
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
              setOpen(undefined);
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
      <div className="min-h-0 flex-1 overflow-y-auto pb-8">
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
            {sections.map((section, index) => (
              <Fragment key={section.id}>
                {index === 0 || sections[index - 1]!.group !== section.group ? (
                  <div className="flex items-baseline gap-2.5 px-5 pt-5 pb-0.5">
                    <h3 className="text-[15px] font-semibold">{section.group === "harness" ? "Harness" : "Runtime"}</h3>
                    <span className="text-xs text-muted-foreground">
                      {section.group === "harness" ? "What runs inside the loop" : "What the Runtime provides around it"}
                    </span>
                  </div>
                ) : null}
                <section aria-label={section.title} className="pt-3">
                  <div className="flex items-baseline gap-2 border-b px-5 pb-1.5">
                    <h4 className="text-[13px] font-semibold">{section.title}</h4>
                    <span className="truncate text-xs text-muted-foreground/80">{section.hint}</span>
                  </div>
                  {section.rows.map((row) => {
                    const expanded = open === row.id;
                    return (
                      <div key={row.id}>
                        <button
                          type="button"
                          aria-expanded={expanded}
                          onClick={() => setOpen(expanded ? undefined : row.id)}
                          className={cn(
                            "grid h-9 w-full grid-cols-[9.5rem_minmax(0,1fr)_auto] items-center gap-3.5 border-b border-border/60 px-5 text-left text-[13px] hover:bg-muted/50",
                            expanded && "bg-muted",
                          )}
                        >
                          <span
                            className={cn(
                              "truncate",
                              row.mono ? "font-mono text-xs text-foreground" : "text-muted-foreground",
                            )}
                            title={row.label}
                          >
                            {row.label}
                          </span>
                          <span className="truncate" title={row.value}>
                            {row.value}
                          </span>
                          <span className="max-w-40 truncate text-xs text-muted-foreground" title={row.note}>
                            {row.tone && row.note ? <StatusDot tone={row.tone}>{row.note}</StatusDot> : row.note}
                          </span>
                        </button>
                        {expanded ? (
                          <pre className="border-b border-border/60 bg-muted/40 px-5 py-2.5 font-mono text-xs leading-5 whitespace-pre-wrap break-all">
                            {typeof row.json === "string" ? row.json : JSON.stringify(row.json, null, 2)}
                          </pre>
                        ) : null}
                      </div>
                    );
                  })}
                </section>
              </Fragment>
            ))}
          </>
        ) : null}
      </div>
    </aside>
  );
}
