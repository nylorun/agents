import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { AgentManifestView } from "@nylorun/agents";
import { Check, ChevronLeft, Copy, FileJson, Plus } from "lucide-react";
import { createTenantClient } from "@/proxy-client";
import { useRead } from "@/resources/reads";
import type { AgentCatalog } from "@/resources/agents";
import { agentPath, manifestPath } from "@/agent-path";
import { isFlowManifest, manifestNameOf } from "@/agent-list";
import { manifestView } from "@/manifest/model";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Metadata, ReadState } from "@/components/resource-layout";
import { AgentState, NewAgentSheet, date } from "@/components/agents";
import { Section } from "@/components/agent-page";

/** What runs a manifest's Agents: `virtual`, `pod`, or `none` without a runtime section. */
const kindOf = (manifest: Pick<AgentManifestView, "manifest">) => manifest.manifest.runtime?.kind ?? "none";

const EDIT_HINT =
  "Agent manifests are read-only here: edit one in its repository and save its next version with nylorun apply.";

/**
 * The Tenant's agent manifests (protocol 16, track T2): each name with its latest version, the
 * kind of Agent it makes and how many Agents were made from it. Read only: a manifest is saved
 * from its repository (`nylorun apply`); each opens on its own page.
 */
export function AgentManifests({ catalog }: Readonly<{ catalog: AgentCatalog }>) {
  const navigate = useNavigate();
  const manifests = [...catalog.manifests].sort((a, b) => a.name.localeCompare(b.name));
  const counts = new Map<string, number>();
  for (const agent of catalog.agents)
    counts.set(manifestNameOf(agent), (counts.get(manifestNameOf(agent)) ?? 0) + 1);
  const message = (text: ReactNode) => (
    <TableRow>
      <TableCell colSpan={5} className="h-28 text-center whitespace-normal text-muted-foreground">
        {text}
      </TableCell>
    </TableRow>
  );
  return (
    <section className="flex min-h-0 w-full flex-1 flex-col overflow-hidden">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b bg-background px-4">
        <h1 className="text-sm font-medium">Agent manifests</h1>
        <span className="text-xs text-muted-foreground">{manifests.length} total</span>
        <span className="ml-auto hidden truncate text-xs text-muted-foreground md:inline">{EDIT_HINT}</span>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <TableHead>Agent manifest</TableHead>
              <TableHead className="w-28">Latest</TableHead>
              <TableHead className="w-28">Kind</TableHead>
              <TableHead className="w-64">Saved</TableHead>
              <TableHead className="w-24 text-right">Agents</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {catalog.status === "Loading"
              ? message("Loading agent manifests…")
              : catalog.manifestsError && manifests.length === 0
                ? message(
                    <span role="alert" className="inline-flex flex-col items-center gap-3">
                      {catalog.manifestsError}
                      <Button variant="outline" size="sm" onClick={catalog.reload} disabled={catalog.pending}>
                        Retry
                      </Button>
                    </span>,
                  )
                : manifests.length === 0
                  ? message(
                      "No agent manifests yet. An agent manifest holds what runs inside the loop (its harness section) and what the Runtime provides around it (its runtime section). Save one with nylorun apply.",
                    )
                  : manifests.map((manifest) => {
                      const href = manifestPath(manifest.name);
                      return (
                        <TableRow key={manifest.name} className="cursor-pointer" onClick={() => void navigate(href)}>
                          <TableCell className="max-w-0">
                            <Link
                              to={href}
                              className="inline-flex max-w-full items-center gap-2 underline-offset-4 hover:underline"
                              onClick={(event) => event.stopPropagation()}
                            >
                              <FileJson className="size-4 shrink-0 text-muted-foreground" />
                              <span className="truncate font-mono text-xs">{manifest.name}</span>
                            </Link>
                            {manifest.manifest.description ? (
                              <p className="truncate text-xs text-muted-foreground">{manifest.manifest.description}</p>
                            ) : null}
                          </TableCell>
                          <TableCell className="tabular-nums">v{manifest.version}</TableCell>
                          <TableCell>
                            <Badge variant="outline">{isFlowManifest(manifest) ? `flow · ${kindOf(manifest)}` : kindOf(manifest)}</Badge>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {date(manifest.createdAt)} by {manifest.savedBy.actor}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{counts.get(manifest.name) ?? 0}</TableCell>
                        </TableRow>
                      );
                    })}
          </TableBody>
        </Table>
      </ScrollArea>
    </section>
  );
}

/**
 * One agent manifest's page (`/agent-manifests/<name>?version=n`): its versions, the version's
 * harness and runtime sections side by side, and the Agents made from it. A new Agent is made
 * from the version shown.
 */
export function AgentManifestPage({
  tenantId,
  name,
  version,
  catalog,
}: Readonly<{ tenantId: string; name: string; version?: number; catalog: AgentCatalog }>) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const loadVersions = useCallback((signal: AbortSignal) => sdk.agentManifests.versions(name, { signal }), [sdk, name]);
  const versions = useRead(loadVersions);
  const loadVersion = useCallback(
    (signal: AbortSignal) => sdk.agentManifests.get(name, version, { signal }),
    [sdk, name, version],
  );
  const read = useRead(loadVersion);
  const shown = read.data;
  const agents = catalog.agents.filter((agent) => manifestNameOf(agent) === name);
  return (
    <section className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto w-full max-w-6xl space-y-4 p-4">
        <Link
          to={manifestPath()}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
          Agent manifests
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h1 className="break-all font-mono text-xl font-semibold">{name}</h1>
            {shown ? (
              <p className="text-sm text-muted-foreground">
                v{shown.version}
                {versions.data && shown.version === versions.data.latest ? " (latest)" : ""} · saved{" "}
                {date(shown.createdAt)} by {shown.savedBy.actor}
                {shown.manifest.description ? ` · ${shown.manifest.description}` : ""}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">{EDIT_HINT}</p>
          </div>
          {shown ? (
            <Button onClick={() => setCreating(true)}>
              <Plus />
              New Agent from v{shown.version}
            </Button>
          ) : null}
        </div>
        <ReadState {...read} onRetry={read.reload} />
        <div className="grid gap-4 lg:grid-cols-[14rem_minmax(0,1fr)]">
          <Section title="Versions">
            <ReadState {...versions} onRetry={versions.reload} />
            <ol className="grid gap-1">
              {versions.data?.versions.map((v) => (
                <li key={v.version}>
                  <Link
                    to={manifestPath(name, v.version)}
                    aria-current={shown?.version === v.version ? "page" : undefined}
                    className={
                      "flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-muted " +
                      (shown?.version === v.version ? "bg-muted font-medium" : "")
                    }
                  >
                    <span className="tabular-nums">v{v.version}</span>
                    {v.version === versions.data?.latest ? <Badge variant="outline">latest</Badge> : null}
                    <span className="ml-auto text-xs tabular-nums text-muted-foreground" title="Agents made from it">
                      {v.agents}
                    </span>
                  </Link>
                </li>
              ))}
            </ol>
          </Section>
          {shown ? (
            <div className="grid min-w-0 gap-4 xl:grid-cols-2">
              <HarnessSection manifest={shown} />
              <RuntimeSection manifest={shown} />
            </div>
          ) : null}
        </div>
        <Section title={`Agents made from ${name}`}>
          {agents.length ? (
            <ul className="grid gap-1 text-sm">
              {agents.map((agent) => (
                <li key={agent.id} className="flex flex-wrap items-center gap-2 border-b py-2">
                  <Link className="break-all font-mono text-xs underline" to={agentPath(agent.id)}>
                    {agent.id}
                  </Link>
                  <Badge variant={agent.resolvedVersion === shown?.version ? "secondary" : "outline"}>
                    v{agent.resolvedVersion}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {agent.tracking === "tracking" ? "tracks" : "pinned"}
                  </span>
                  <span className="ml-auto">
                    <AgentState state={agent.state} />
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No Agent was made from it yet.</p>
          )}
        </Section>
      </div>
      {creating && shown ? (
        <NewAgentSheet
          tenantId={tenantId}
          manifests={catalog.manifests.some((m) => m.name === name) ? catalog.manifests : [...catalog.manifests, shown]}
          manifest={name}
          version={shown.version}
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

/** A section's JSON, folded, to copy. */
function SectionJson({ label, value }: Readonly<{ label: string; value: unknown }>) {
  const json = JSON.stringify(value ?? null, null, 2);
  const [copied, setCopied] = useState(false);
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-muted-foreground">{label}, as JSON</summary>
      <div className="relative mt-2">
        <Button
          variant="outline"
          size="sm"
          className="absolute top-2 right-2 h-7 bg-background px-2 text-xs"
          onClick={() =>
            void navigator.clipboard?.writeText(json).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <pre
          aria-label={`${label} JSON`}
          className="max-h-96 overflow-auto whitespace-pre rounded-md border bg-muted/40 p-3 pr-20 font-mono text-xs"
        >
          {json}
        </pre>
      </div>
    </details>
  );
}

const list = (items: readonly string[]) => (items.length ? items.join(", ") : "None");

/** What runs inside the loop: the version's harness section. */
function HarnessSection({ manifest }: Readonly<{ manifest: AgentManifestView }>) {
  const harness = manifest.manifest.harness as unknown as Record<string, unknown>;
  const flow = isFlowManifest(manifest);
  const view = manifestView(harness);
  const agents = flow && typeof harness.agents === "object" && harness.agents !== null ? Object.keys(harness.agents) : [];
  return (
    <Section title="Harness">
      <p className="text-xs text-muted-foreground">What runs inside the agent loop.</p>
      <Metadata
        entries={[
          ["Harness", typeof harness.id === "string" ? harness.id : "nylorun"],
          ...(flow
            ? ([["Flow agents", list(agents)]] as [string, ReactNode][])
            : ([
                ["Instructions", view.instructions.length],
                ["Tools", list(view.tools.map((tool) => tool.name))],
                ["Skills", list(view.skills.map((skill) => skill.name))],
                ["MCP servers", list(view.mcpServers.map((server) => server.name))],
              ] as [string, ReactNode][])),
          ...(Array.isArray(harness.plugins) && harness.plugins.length
            ? ([["Plugins", harness.plugins.length]] as [string, ReactNode][])
            : []),
        ]}
      />
      <SectionJson label="The harness section" value={harness} />
    </Section>
  );
}

/** What the Runtime provides around the loop: the version's runtime section. */
function RuntimeSection({ manifest }: Readonly<{ manifest: AgentManifestView }>) {
  const runtime = manifest.manifest.runtime;
  if (!runtime)
    return (
      <Section title="Runtime">
        <p className="text-sm text-muted-foreground">
          No runtime section: an Agent made from it is kind none, a vault with no compute.
        </p>
      </Section>
    );
  return (
    <Section title="Runtime">
      <p className="text-xs text-muted-foreground">What the Runtime provides around the loop.</p>
      <Metadata
        entries={[
          ["Kind", runtime.kind],
          ...(runtime.kind === "pod" ? ([["Image", runtime.image ?? "The Tenant's"]] as [string, ReactNode][]) : []),
          [
            "Resources",
            runtime.resources ? `${runtime.resources.cpus} CPU · ${runtime.resources.memory}` : "The Tenant's",
          ],
          ["Allowed hosts", list(runtime.network?.allowedHosts ?? [])],
          ["Idle", runtime.lifecycle?.idle ?? "The Tenant's"],
          ["Delete after", runtime.lifecycle?.deleteAfter ?? "Never"],
          ["Setup commands", runtime.setup?.length ?? 0],
          ["Input files", runtime.files?.length ?? 0],
          ["Secret slots", list(Object.keys(runtime.secrets ?? {}))],
        ]}
      />
      <SectionJson label="The runtime section" value={runtime} />
    </Section>
  );
}
