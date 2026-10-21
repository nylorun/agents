import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { AgentView } from "@nylorun/agents";
import { cn } from "@/lib/utils";
import { manifestNameOf } from "@/agent-list";
import { manifestPath } from "@/agent-path";
import { manifestSections, type SpecRow } from "@/agent-spec";
import { withPolicyNotes, type ToolRule } from "@/tenant-spec";
import { Button } from "@/components/ui/button";
import { FlowDiagram } from "@/components/flow-diagram";
import { isWorkflowManifest, type WorkflowManifest } from "@/workflow";
import {
  ActionMenu,
  CodeBlock,
  SidePanel,
  StatusDot,
  TableToolbar,
  type MenuAction,
} from "@/components/data-table";

/** A move within its manifest (track T3), or applying a pending version. */
export type ManifestMove = "move" | "track" | "pin" | "restart" | "retry";

/** A flow agent's harness section, as a workflow manifest; it takes the manifest's name for an id. */
function flowOf(manifest: unknown, name: string): WorkflowManifest | undefined {
  const harness = (manifest as { harness?: unknown } | undefined)?.harness;
  if (!harness || typeof harness !== "object") return undefined;
  const flow = { id: name, ...harness };
  return isWorkflowManifest(flow) ? flow : undefined;
}

/** The anchor of a flow's diagram; `spec-flow` is its agents' section. */
const STAGES = "spec-stages";

const TAB_NAMES: Record<string, string> = {
  vault: "Vault",
  triggers: "Triggers",
  memory: "Memory",
  artifacts: "Artifacts",
  disk: "Disk",
  activity: "Activity",
};

/**
 * The manifest version the Agent is an instance of, as a readable spec: its harness section
 * (instructions, tools, skills, MCP servers, memory), then its runtime section (compute,
 * lifecycle, network, setup, vault slots, triggers, limits), each item on one line with a quiet
 * note of what it is now. A row opens its part of the manifest; the ⋯ menu moves the Agent
 * within its manifest.
 */
export function AgentManifestTab({
  agent,
  manifest,
  latest,
  acting,
  onMove,
  rules = [],
}: {
  agent: AgentView;
  /** The version's whole manifest; without it the runtime section comes from the Agent's view. */
  manifest?: unknown;
  latest?: number;
  acting: boolean;
  onMove: (what: ManifestMove) => void;
  /** The Tenant's tool policy: each tool it may decide calls of notes its rules. */
  rules?: readonly ToolRule[];
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useSearchParams();
  const [open, setOpen] = useState<SpecRow | "json">();
  const name = manifestNameOf(agent);
  const sections = withPolicyNotes(manifestSections(agent, manifest), rules, name);
  const flow = flowOf(manifest, name);
  const newer = latest !== undefined && latest > agent.resolvedVersion;
  const actions: MenuAction[] = [
    ...(newer && agent.tracking === "pinned" && !agent.targetVersion
      ? [{ label: `Move to v${latest}`, onSelect: () => onMove("move"), disabled: acting }]
      : []),
    agent.tracking === "tracking"
      ? { label: `Pin to v${agent.resolvedVersion}`, onSelect: () => onMove("pin"), disabled: acting }
      : { label: "Track the manifest", onSelect: () => onMove("track"), disabled: acting },
    ...(agent.kind === "pod" && agent.waitingFor === "start"
      ? [{ label: `Restart on v${agent.targetVersion}`, onSelect: () => onMove("restart"), disabled: acting }]
      : []),
    ...(agent.kind === "pod" && agent.failedVersion && !agent.targetVersion
      ? [{ label: `Retry v${agent.failedVersion}`, onSelect: () => onMove("retry"), disabled: acting }]
      : []),
    ...(manifest ? [{ label: "View JSON", onSelect: () => setOpen("json" as const), separated: true }] : []),
    { label: "All versions", onSelect: () => navigate(manifestPath(name)), ...(manifest ? {} : { separated: true }) },
  ];
  const openTab = (tab: string) => {
    const next = new URLSearchParams(query);
    next.set("tab", tab);
    setQuery(next);
  };
  const groups = (["harness", "runtime"] as const).map((group) => ({
    group,
    title: group === "harness" ? "Harness" : "Runtime",
    hint: group === "harness" ? "What the agent is" : "Where and how it runs",
    sections: sections.filter((section) => section.group === group),
  }));
  return (
    <div>
      <TableToolbar>
        <span className="text-sm">
          <span className="font-mono text-[13px]">
            {name} v{agent.resolvedVersion}
          </span>
          <span className="text-muted-foreground">
            {" · "}
            {agent.tracking === "tracking" ? "tracking latest" : "pinned"}
            {newer && !agent.targetVersion ? ` · v${latest} is the latest` : ""}
            {agent.targetVersion
              ? agent.waitingFor === "secrets"
                ? ` · v${agent.targetVersion} waits for its required secrets`
                : ` · v${agent.targetVersion} applies at its pod's next start`
              : ""}
          </span>
        </span>
        <span className="ml-auto" />
        <ActionMenu label="Manifest actions" actions={actions} bordered />
      </TableToolbar>
      <div className="flex">
        <nav aria-label="Manifest sections" className="sticky top-0 hidden w-48 shrink-0 self-start border-r py-4 md:block">
          {groups.map((g) =>
            g.sections.length || (flow && g.group === "harness") ? (
              <div key={g.group} className="mb-4">
                <p className="px-4 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{g.title}</p>
                {flow && g.group === "harness" ? (
                  <a
                    href={`#${STAGES}`}
                    onClick={(event) => {
                      event.preventDefault();
                      document.getElementById(STAGES)?.scrollIntoView({ block: "start" });
                    }}
                    className="block truncate px-4 py-1 text-sm text-muted-foreground hover:text-foreground"
                  >
                    Flow
                  </a>
                ) : null}
                {g.sections.map((section) => (
                  <a
                    key={section.id}
                    href={`#spec-${section.id}`}
                    onClick={(event) => {
                      event.preventDefault();
                      document.getElementById(`spec-${section.id}`)?.scrollIntoView({ block: "start" });
                    }}
                    className="block truncate px-4 py-1 text-sm text-muted-foreground hover:text-foreground"
                  >
                    {section.title}
                  </a>
                ))}
              </div>
            ) : null,
          )}
        </nav>
        <div className="min-w-0 flex-1">
          {groups.map((g) =>
            g.sections.length || (flow && g.group === "harness") ? (
              <div key={g.group}>
                <div className="flex items-baseline gap-2 border-b bg-muted/40 px-4 py-2">
                  <h2 className="text-sm font-semibold">{g.title}</h2>
                  <span className="text-xs text-muted-foreground">{g.hint}</span>
                </div>
                {flow && g.group === "harness" ? (
                  <FlowDiagram
                    manifest={flow}
                    variant="spec"
                    id={STAGES}
                    hint={`Its stages, top to bottom, as v${agent.resolvedVersion} declares them`}
                  />
                ) : null}
                {g.sections.map((section) => (
                  <section key={section.id} id={`spec-${section.id}`} aria-label={section.title} className="scroll-mt-2">
                    <div className="flex items-baseline gap-2 px-4 pt-4 pb-1.5">
                      <h3 className="text-[13px] font-medium">{section.title}</h3>
                      <span className="truncate text-xs text-muted-foreground">{section.hint}</span>
                    </div>
                    <ul>
                      {section.rows.map((row) => (
                        <li key={row.id}>
                          <button
                            type="button"
                            onClick={() => setOpen(row)}
                            className={cn(
                              "flex h-10 w-full items-center gap-3 border-b px-4 text-left text-sm hover:bg-muted/50",
                              open !== "json" && open?.id === row.id && "bg-muted",
                            )}
                          >
                            <span
                              className={cn("w-40 shrink-0 truncate text-muted-foreground", row.mono && "font-mono text-[13px] text-foreground")}
                              title={row.label}
                            >
                              {row.label}
                            </span>
                            <span className="min-w-0 flex-1 truncate" title={row.value}>
                              {row.value}
                            </span>
                            {row.note ? (
                              <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground" title={row.note}>
                                {row.tone ? <StatusDot tone={row.tone}>{row.note}</StatusDot> : row.note}
                              </span>
                            ) : null}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            ) : null,
          )}
        </div>
      </div>
      {open === "json" ? (
        <SidePanel
          title={`${name} v${agent.resolvedVersion}`}
          description="The whole manifest"
          onClose={() => setOpen(undefined)}
          wide
        >
          <CodeBlock>{JSON.stringify(manifest, null, 2)}</CodeBlock>
        </SidePanel>
      ) : open ? (
        <SidePanel
          title={open.label}
          description={open.note ? `${open.value} · ${open.note}` : open.value}
          onClose={() => setOpen(undefined)}
          footer={
            open.tab ? (
              <Button variant="outline" onClick={() => openTab(open.tab!)}>
                Open the {TAB_NAMES[open.tab] ?? open.tab} tab
              </Button>
            ) : undefined
          }
          wide
        >
          <p className="text-sm whitespace-pre-wrap">{open.value}</p>
          <CodeBlock label="In the manifest">
            {typeof open.json === "string" ? open.json : JSON.stringify(open.json, null, 2)}
          </CodeBlock>
        </SidePanel>
      ) : null}
    </div>
  );
}
