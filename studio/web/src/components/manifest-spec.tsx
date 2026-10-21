import { Fragment, useState } from "react";
import type { AgentTab } from "@/agent-path";
import type { SpecRow, SpecSection } from "@/agent-spec";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { CodeBlock, SidePanel, StatusDot } from "@/components/data-table";
import { FlowDiagram } from "@/components/flow-diagram";
import type { WorkflowManifest } from "@/workflow";

const GROUPS = {
  harness: { title: "Harness", hint: "What the agent is" },
  runtime: { title: "Runtime", hint: "Where and how it runs" },
} as const;

const TAB_NAMES: Partial<Record<AgentTab, string>> = {
  vault: "Vault",
  triggers: "Triggers",
  memory: "Memory",
  artifacts: "Artifacts",
  disk: "Disk",
  activity: "Activity",
};

/** The anchor of a flow's diagram; `spec-flow` is its agents' section. */
const STAGES = "spec-stages";

const json = (row: SpecRow) => (typeof row.json === "string" ? row.json : JSON.stringify(row.json, null, 2));

/**
 * A manifest as a readable spec, the same on a session's Manifest tab, an Agent's and the
 * Tenant's Manifests pane: the harness section, then the runtime section, each item one line
 * with a quiet note of what it uses or is now, and a flow agent's stages drawn atop its harness.
 * A row opens its part of the manifest in a side panel (`detail="panel"`, where there is room)
 * or below it (`inline`, in a narrow pane); `nav` adds the sections' outline on the left.
 */
export function ManifestSpec({
  sections,
  flow,
  flowHint,
  detail,
  nav = false,
  gutter = "px-4",
  onOpenTab,
}: Readonly<{
  sections: readonly SpecSection[];
  /** A flow agent's harness, drawn as its stages. */
  flow?: WorkflowManifest;
  /** Which version the flow is, such as "as v4 declares them". */
  flowHint?: string;
  detail: "panel" | "inline";
  nav?: boolean;
  gutter?: "px-4" | "px-5";
  /** The tab that holds a row's part (the Agent page): its panel links there. */
  onOpenTab?: (tab: AgentTab) => void;
}>) {
  const [open, setOpen] = useState<SpecRow>();
  const groups = (["harness", "runtime"] as const)
    .map((group) => ({ group, ...GROUPS[group], sections: sections.filter((section) => section.group === group) }))
    .filter((g) => g.sections.length > 0 || (flow && g.group === "harness"));
  const jump = (id: string) => (event: { preventDefault(): void }) => {
    event.preventDefault();
    document.getElementById(id)?.scrollIntoView({ block: "start" });
  };

  const body = (
    <div className="min-w-0 flex-1">
      {groups.map((g) => (
        <div key={g.group}>
          <div className={cn("flex items-baseline gap-2 border-b bg-muted/40 py-2", gutter)}>
            <h2 className="text-sm font-semibold">{g.title}</h2>
            <span className="text-xs text-muted-foreground">{g.hint}</span>
          </div>
          {flow && g.group === "harness" ? (
            <FlowDiagram
              manifest={flow}
              id={STAGES}
              gutter={gutter}
              {...(flowHint ? { hint: `Its stages, top to bottom, ${flowHint}` } : {})}
            />
          ) : null}
          {g.sections.map((section) => (
            <section key={section.id} id={`spec-${section.id}`} aria-label={section.title} className="scroll-mt-2">
              <div className={cn("flex items-baseline gap-2 border-b pt-4 pb-1.5", gutter)}>
                <h3 className="text-[13px] font-medium">{section.title}</h3>
                <span className="truncate text-xs text-muted-foreground">{section.hint}</span>
              </div>
              {section.rows.map((row) => {
                const selected = open?.id === row.id;
                return (
                  <Fragment key={row.id}>
                    <button
                      type="button"
                      aria-expanded={detail === "inline" ? selected : undefined}
                      onClick={() => setOpen(selected && detail === "inline" ? undefined : row)}
                      className={cn(
                        "grid h-10 w-full grid-cols-[7rem_minmax(0,1fr)_auto] items-center gap-3.5 border-b text-left text-sm hover:bg-muted/50 sm:grid-cols-[9.5rem_minmax(0,1fr)_auto]",
                        gutter,
                        selected && "bg-muted",
                      )}
                    >
                      <span
                        className={cn("truncate", row.mono ? "font-mono text-[13px] text-foreground" : "text-muted-foreground")}
                        title={row.label}
                      >
                        {row.label}
                      </span>
                      <span className="truncate" title={row.value}>
                        {row.value}
                      </span>
                      <span className="max-w-28 truncate text-xs text-muted-foreground sm:max-w-40" title={row.note}>
                        {row.tone && row.note ? <StatusDot tone={row.tone}>{row.note}</StatusDot> : row.note}
                      </span>
                    </button>
                    {detail === "inline" && selected ? (
                      <pre
                        className={cn(
                          "border-b bg-muted/40 py-2.5 font-mono text-xs leading-5 whitespace-pre-wrap break-all",
                          gutter,
                        )}
                      >
                        {json(row)}
                      </pre>
                    ) : null}
                  </Fragment>
                );
              })}
            </section>
          ))}
        </div>
      ))}
    </div>
  );

  return (
    <>
      {nav ? (
        <div className="flex">
          <nav
            aria-label="Manifest sections"
            className="sticky top-0 hidden w-48 shrink-0 self-start border-r py-4 md:block"
          >
            {groups.map((g) => (
              <div key={g.group} className="mb-4">
                <p className="px-4 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{g.title}</p>
                {flow && g.group === "harness" ? (
                  <a
                    href={`#${STAGES}`}
                    onClick={jump(STAGES)}
                    className="block truncate px-4 py-1 text-sm text-muted-foreground hover:text-foreground"
                  >
                    Flow
                  </a>
                ) : null}
                {g.sections.map((section) => (
                  <a
                    key={section.id}
                    href={`#spec-${section.id}`}
                    onClick={jump(`spec-${section.id}`)}
                    className="block truncate px-4 py-1 text-sm text-muted-foreground hover:text-foreground"
                  >
                    {section.title}
                  </a>
                ))}
              </div>
            ))}
          </nav>
          {body}
        </div>
      ) : (
        body
      )}
      {detail === "panel" && open ? (
        <SidePanel
          title={open.label}
          description={open.note ? `${open.value} · ${open.note}` : open.value}
          onClose={() => setOpen(undefined)}
          footer={
            open.tab && onOpenTab ? (
              <Button variant="outline" onClick={() => onOpenTab(open.tab!)}>
                Open the {TAB_NAMES[open.tab] ?? open.tab} tab
              </Button>
            ) : undefined
          }
          wide
        >
          <p className="text-sm whitespace-pre-wrap">{open.value}</p>
          <CodeBlock label="In the manifest">{json(open)}</CodeBlock>
        </SidePanel>
      ) : null}
    </>
  );
}
