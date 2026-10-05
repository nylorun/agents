import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  SANDBOX_TOOLS,
  isOutdated,
  manifestView,
  shortHash,
  type CapabilityView,
  type PinnedManifestState,
  type SchemaField,
  type ToolKind,
  type ToolView,
} from "@/manifest/model";
import { useSessionManifest } from "@/manifest/use-session-manifest";
import { cn } from "@/lib/utils";
import type { AgentManifest } from "@/studio-types";

export { hookFrequency } from "@/manifest/model";

const TOOL_GROUPS: readonly { kinds: readonly ToolKind[]; title: string; note: string }[] = [
  { kinds: ["endpoint"], title: "Tools", note: "run at your Action endpoint" },
  { kinds: ["subagent", "flow-subagent"], title: "Subagents", note: "delegated with { task }" },
  { kinds: ["built-in"], title: "Built-in", note: "added by the engine" },
];

export function AgentManifestPanel({
  agent,
  tenantId,
  sessionId,
}: Readonly<{ agent: AgentManifest; tenantId?: string; sessionId: string }>) {
  const { pinned, hasSandbox } = useSessionManifest(
    tenantId,
    sessionId,
    agent.manifestHash,
  );
  // Show the manifest the session runs; fall back to the registered one until it is known.
  const manifest = pinned.kind === "pinned" ? pinned.manifest : agent.manifest;
  const isWorkflow =
    agent.kind === "workflow" ||
    (manifest as { kind?: unknown }).kind === "workflow";
  const view = manifestView(manifest);
  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 p-4">
        <header className="space-y-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <h3 className="text-sm font-medium">{agent.name}</h3>
            <span className="font-mono text-xs text-muted-foreground">{agent.id}</span>
            <Badge variant="outline">{isWorkflow ? "workflow" : "agent"}</Badge>
          </div>
          {view.description ? (
            <p className="text-sm text-muted-foreground">{view.description}</p>
          ) : null}
          <ManifestVersion pinned={pinned} />
        </header>
        <Separator />
        {isWorkflow ? (
          <p className="text-sm text-muted-foreground">
            Workflow (no agent capabilities). See the Tree tab for its stages.
          </p>
        ) : (
          <>
            <section className="space-y-2">
              <h3 className="text-sm font-medium">Capabilities</h3>
              {view.capabilities.length === 0 ? (
                <p className="text-sm text-muted-foreground">None declared</p>
              ) : (
                view.capabilities.map((capability, index) => (
                  <CapabilityCard
                    key={capability.id}
                    capability={capability}
                    defaultOpen={index === 0}
                  />
                ))
              )}
              {hasSandbox ? <SandboxCard /> : null}
            </section>
            <Separator />
            <section>
              <h3 className="text-sm font-medium">Hooks</h3>
              <ul className="mt-2 space-y-1 text-sm">
                {view.hookPoints.length === 0 ? (
                  <li className="text-muted-foreground">None registered</li>
                ) : (
                  view.hookPoints.map((point) => (
                    <li key={point.method}>
                      <span className="font-mono text-xs">.{point.method}()</span>
                      <span className="text-muted-foreground">
                        {" "}
                        — {point.frequency} · {point.capabilityIds.join(", ")}
                      </span>
                    </li>
                  ))
                )}
              </ul>
            </section>
          </>
        )}
      </div>
    </ScrollArea>
  );
}

function ManifestVersion({ pinned }: Readonly<{ pinned: PinnedManifestState }>) {
  switch (pinned.kind) {
    case "loading":
      return <p className="text-xs text-muted-foreground">Reading the session's manifest…</p>;
    case "failed":
      return (
        <p className="text-xs text-destructive">
          Could not read the session's manifest: {pinned.message}. Showing the registered
          manifest.
        </p>
      );
    case "registered-only":
      return (
        <p className="text-xs text-muted-foreground">
          Registered manifest
          {pinned.registeredHash ? (
            <span className="font-mono"> {shortHash(pinned.registeredHash)}</span>
          ) : null}
          . This Runtime does not report which manifest the session is pinned to.
        </p>
      );
    case "pinned":
      return (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            Session manifest{" "}
            <span className="font-mono">{shortHash(pinned.manifestHash)}</span>
          </span>
          {isOutdated(pinned) ? (
            <Badge variant="secondary">
              Newer registered: {shortHash(pinned.registeredHash!)}
            </Badge>
          ) : null}
        </p>
      );
  }
}

function count(n: number, noun: string): string {
  return n === 0 ? "" : `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function CapabilityCard({
  capability,
  defaultOpen,
}: Readonly<{ capability: CapabilityView; defaultOpen: boolean }>) {
  const counts = [
    count(capability.tools.length, "tool"),
    count(capability.hooks.length, "hook"),
    count(capability.skills.length, "skill"),
    count(capability.mcpServers.length, "MCP server"),
  ].filter(Boolean);
  return (
    <Collapsible defaultOpen={defaultOpen} className="rounded-md border">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 text-left">
        <ChevronRight className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
        <span className="font-mono text-xs">{capability.id}</span>
        {capability.type === "agent-plugin" ? <Badge variant="outline">plugin</Badge> : null}
        <span className="ml-auto text-xs text-muted-foreground">{counts.join(" · ")}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 border-t px-3 py-3">
        {capability.description ? (
          <p className="text-sm text-muted-foreground">{capability.description}</p>
        ) : null}
        {capability.instructions.length ? (
          <Instructions instructions={capability.instructions} />
        ) : null}
        {TOOL_GROUPS.map((group) => {
          const tools = capability.tools.filter((tool) => group.kinds.includes(tool.kind));
          return tools.length ? (
            <div key={group.title}>
              <h4 className="text-xs font-medium">
                {group.title}{" "}
                <span className="font-normal text-muted-foreground">— {group.note}</span>
              </h4>
              <ul className="mt-1 space-y-1">
                {tools.map((tool) => (
                  <ToolRow key={tool.name} tool={tool} />
                ))}
              </ul>
            </div>
          ) : null;
        })}
        {capability.skills.length ? (
          <div>
            <h4 className="text-xs font-medium">Skills</h4>
            <ul className="mt-1 space-y-1 text-sm">
              {capability.skills.map((skill) => (
                <li key={skill.name}>
                  <span className="font-mono text-xs">{skill.name}</span>
                  {skill.description ? (
                    <span className="text-muted-foreground"> — {skill.description}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {capability.hooks.length ? (
          <p className="text-xs text-muted-foreground">
            Hooks:{" "}
            {capability.hooks.map((hook) => (
              <span key={hook.method} className="mr-2 font-mono">
                .{hook.method}()
              </span>
            ))}
          </p>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Instructions collapse after a few lines; skill catalogs and plugins make them long. */
function Instructions({ instructions }: Readonly<{ instructions: readonly string[] }>) {
  const [open, setOpen] = useState(false);
  const text = instructions.join("\n\n");
  const long = text.split("\n").length > 4 || text.length > 320;
  return (
    <div>
      <h4 className="text-xs font-medium">Instructions</h4>
      <pre
        className={cn(
          "mt-1 whitespace-pre-wrap break-words rounded bg-muted px-2 py-1.5 font-mono text-xs",
          long && !open && "max-h-24 overflow-hidden",
        )}
      >
        {text}
      </pre>
      {long ? (
        <button
          type="button"
          className="mt-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => setOpen(!open)}
        >
          {open ? "Show less" : "Show all"}
        </button>
      ) : null}
    </div>
  );
}

function ToolRow({ tool }: Readonly<{ tool: ToolView }>) {
  return (
    <li>
      <Collapsible>
        <CollapsibleTrigger className="group flex w-full items-start gap-1 text-left text-sm">
          <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
          <span>
            <span className="font-mono text-xs">{tool.name}</span>
            {tool.kind === "flow-subagent" ? (
              <Badge variant="outline" className="ml-1">
                flow
              </Badge>
            ) : null}
            {tool.output ? (
              <Badge variant="outline" className="ml-1">
                output schema
              </Badge>
            ) : null}
            {tool.description ? (
              <span className="text-muted-foreground"> — {tool.description}</span>
            ) : null}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="ml-5 mt-1 space-y-1">
          <Fields title="Input" fields={tool.input} />
          {tool.output ? <Fields title="Output" fields={tool.output} /> : null}
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

function Fields({ title, fields }: Readonly<{ title: string; fields: readonly SchemaField[] }>) {
  return (
    <div className="text-xs">
      <span className="text-muted-foreground">{title}: </span>
      {fields.length === 0 ? (
        <span className="text-muted-foreground">none</span>
      ) : (
        <span className="font-mono">
          {fields
            .map((field) =>
              field.name
                ? `${field.name}${field.required ? "" : "?"}: ${field.type}`
                : field.type,
            )
            .join(", ")}
        </span>
      )}
    </div>
  );
}

function SandboxCard() {
  return (
    <div className="rounded-md border px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs">sandbox</span>
        <Badge variant="outline">session</Badge>
        <span className="ml-auto text-xs text-muted-foreground">
          {count(SANDBOX_TOOLS.length, "tool")}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Run in the Runtime on this session's /workspace:{" "}
        <span className="font-mono">{SANDBOX_TOOLS.join(", ")}</span>
      </p>
    </div>
  );
}
