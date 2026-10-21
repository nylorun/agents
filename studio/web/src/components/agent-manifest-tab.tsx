import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { AgentView } from "@nylorun/agents";
import { manifestNameOf } from "@/agent-list";
import { manifestPath, type AgentTab } from "@/agent-path";
import { flowOf, manifestSections } from "@/agent-spec";
import { withPolicyNotes, type ToolRule } from "@/tenant-spec";
import { ManifestSpec } from "@/components/manifest-spec";
import { ActionMenu, CodeBlock, SidePanel, TableToolbar, type MenuAction } from "@/components/data-table";

/** A move within its manifest (track T3), or applying a pending version. */
export type ManifestMove = "move" | "track" | "pin" | "restart" | "retry";

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
  const [json, setJson] = useState(false);
  const name = manifestNameOf(agent);
  const sections = withPolicyNotes(manifestSections(agent, manifest), rules, name);
  const flow = flowOf((manifest as { harness?: unknown } | undefined)?.harness, name);
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
    ...(manifest ? [{ label: "View JSON", onSelect: () => setJson(true), separated: true }] : []),
    { label: "All versions", onSelect: () => navigate(manifestPath(name)), ...(manifest ? {} : { separated: true }) },
  ];
  const openTab = (tab: AgentTab) => {
    const next = new URLSearchParams(query);
    next.set("tab", tab);
    setQuery(next);
  };
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
      <ManifestSpec
        sections={sections}
        {...(flow ? { flow, flowHint: `as v${agent.resolvedVersion} declares them` } : {})}
        detail="panel"
        nav
        onOpenTab={openTab}
      />
      {json ? (
        <SidePanel
          title={`${name} v${agent.resolvedVersion}`}
          description="The whole manifest"
          onClose={() => setJson(false)}
          wide
        >
          <CodeBlock>{JSON.stringify(manifest, null, 2)}</CodeBlock>
        </SidePanel>
      ) : null}
    </div>
  );
}
