import { Fragment, useRef, useState, type ReactNode } from "react";
import {
  BookOpen,
  Bot,
  Box,
  Braces,
  Check,
  Copy,
  Cpu,
  Info,
  LayoutList,
  Plug,
  Puzzle,
  Terminal,
  Webhook,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  SANDBOX_TOOLS,
  isOutdated,
  lifecycle,
  manifestStats,
  manifestView,
  shortHash,
  fieldText,
  type CapabilityView,
  type PinnedManifestState,
  type ToolKind,
  type ToolView,
} from "@/manifest/model";
import { useSessionManifest } from "@/manifest/use-session-manifest";
import type { AgentManifest } from "@/studio-types";

export { hookFrequency } from "@/manifest/model";

const TOOL_GROUPS: readonly {
  kinds: readonly ToolKind[];
  title: string;
  note: string;
  icon: LucideIcon;
}[] = [
  { kinds: ["endpoint"], title: "Tools", note: "run at your Action endpoint", icon: Wrench },
  { kinds: ["subagent", "flow-subagent"], title: "Subagents", note: "take a { task }", icon: Bot },
  { kinds: ["built-in"], title: "Skill tools", note: "added by the engine", icon: BookOpen },
];

/** A segmented control: the active view is raised on the muted track. */
const SEGMENT =
  "size-7 min-w-7 rounded-md! px-0 text-muted-foreground hover:bg-transparent data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm!";

/** An icon-only view switch; the tooltip and label name it. */
function ViewToggle({
  value,
  label,
  icon: Icon,
}: Readonly<{ value: "layout" | "json"; label: string; icon: LucideIcon }>) {
  return (
    <Tooltip>
      {/* A wrapper triggers the tooltip so the item keeps its own data-state (on/off). */}
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <ToggleGroupItem value={value} aria-label={label} className={SEGMENT}>
            <Icon className="size-3.5" />
          </ToggleGroupItem>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

const HOOK_HELP: Record<string, string> = {
  beforeTurn: "Patches the turn before its first model call.",
  beforeModel: "Patches every model call.",
  afterModel: "Decides on every model response before tools run.",
  afterTurn: "Decides on the final answer.",
};

export function AgentManifestPanel({
  agent,
  tenantId,
  sessionId,
}: Readonly<{ agent: AgentManifest; tenantId?: string; sessionId: string }>) {
  const { pinned, hasSandbox } = useSessionManifest(tenantId, sessionId, agent.manifestHash);
  const [mode, setMode] = useState<"layout" | "json">("layout");
  // Show the manifest the session runs; fall back to the registered one until it is known.
  const manifest =
    pinned.kind === "pinned" ? pinned.manifest : (agent.rawManifest ?? agent.manifest);
  const isWorkflow =
    agent.kind === "workflow" || (manifest as { kind?: unknown }).kind === "workflow";
  const view = manifestView(manifest);
  const stats = manifestStats(view);
  return (
    // Radix sizes the viewport's child as a table, which grows to the longest line.
    <ScrollArea className="h-full [&_[data-slot=scroll-area-viewport]>div]:block!">
      <div className="space-y-5 p-4">
        <header className="space-y-2">
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted">
              {isWorkflow ? <Workflow className="size-4" /> : <Bot className="size-4" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base leading-tight font-semibold">{agent.name}</h2>
                <Badge variant="secondary">{isWorkflow ? "Flow agent" : "Agent"}</Badge>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                <span className="font-mono">{agent.id}</span>
                <VersionTag pinned={pinned} />
              </div>
            </div>
            <ToggleGroup
              type="single"
              size="sm"
              value={mode}
              onValueChange={(value) => {
                if (value === "layout" || value === "json") setMode(value);
              }}
              aria-label="Manifest view"
              className="shrink-0 gap-0.5 rounded-lg bg-muted p-0.5"
            >
              <ViewToggle value="layout" label="Layout view" icon={LayoutList} />
              <ViewToggle value="json" label="JSON view" icon={Braces} />
            </ToggleGroup>
          </div>
          {view.description ? (
            <p className="text-sm text-muted-foreground">{view.description}</p>
          ) : null}
          <VersionAlert pinned={pinned} />
        </header>

        {mode === "json" ? (
          <ManifestJson manifest={manifest} />
        ) : isWorkflow ? (
          <p className="text-sm text-muted-foreground">
            A flow agent's stages are on the Tree tab.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2">
              <Stat icon={Wrench} value={stats.tools} label="Tools" />
              <Stat icon={Bot} value={stats.subagents} label="Subagents" />
              <Stat icon={BookOpen} value={stats.skills} label="Skills" />
              <Stat icon={Webhook} value={stats.hooks} label="Hooks" />
              <Stat icon={Plug} value={stats.mcpServers} label="MCP servers" />
              <Stat
                icon={Terminal}
                value={hasSandbox ? "On" : "Off"}
                label="Sandbox"
                muted={!hasSandbox}
              />
            </div>

            <Section title="Turn lifecycle" hint="Where each hook runs in one turn.">
              <Lifecycle stages={lifecycle(view)} />
            </Section>

            <Section
              title="Capabilities"
              hint="Applied in this order. Each bundles instructions, tools, skills and hooks."
            >
              {view.capabilities.length === 0 ? (
                <p className="text-sm text-muted-foreground">None declared</p>
              ) : (
                <Accordion
                  type="multiple"
                  defaultValue={view.capabilities[0] ? [view.capabilities[0].id] : []}
                  className="rounded-lg border"
                >
                  {view.capabilities.map((capability) => (
                    <CapabilityItem key={capability.id} capability={capability} />
                  ))}
                  {hasSandbox ? <SandboxItem /> : null}
                </Accordion>
              )}
            </Section>
          </>
        )}
      </div>
    </ScrollArea>
  );
}

function Section({
  title,
  hint,
  children,
}: Readonly<{ title: string; hint: string; children: ReactNode }>) {
  return (
    <section className="space-y-2">
      <Separator />
      <div className="pt-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      {children}
    </section>
  );
}

function Stat({
  icon: Icon,
  value,
  label,
  muted,
}: Readonly<{ icon: LucideIcon; value: number | string; label: string; muted?: boolean }>) {
  const empty = muted || value === 0;
  return (
    <Card className={cn("gap-0.5 px-3 py-2 shadow-none", empty && "bg-muted/40")}>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <div className={cn("text-lg leading-tight font-semibold", empty && "text-muted-foreground")}>
        {value}
      </div>
    </Card>
  );
}

function VersionTag({ pinned }: Readonly<{ pinned: PinnedManifestState }>) {
  const hash =
    pinned.kind === "pinned"
      ? pinned.manifestHash
      : pinned.kind === "registered-only"
        ? pinned.registeredHash
        : undefined;
  if (!hash) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-default font-mono">manifest {shortHash(hash)}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs font-mono break-all">
        {pinned.kind === "pinned" ? "Session manifest " : "Registered manifest "}
        {hash}
      </TooltipContent>
    </Tooltip>
  );
}

function VersionAlert({ pinned }: Readonly<{ pinned: PinnedManifestState }>) {
  if (pinned.kind === "failed")
    return (
      <Alert variant="destructive" className="py-2">
        <Info />
        <AlertDescription className="text-xs">
          Could not read the session's manifest: {pinned.message}. Showing the registered one.
        </AlertDescription>
      </Alert>
    );
  if (pinned.kind === "registered-only")
    return (
      <Alert className="py-2">
        <Info />
        <AlertDescription className="text-xs">
          Showing the registered manifest. This Runtime does not report which manifest the session
          is pinned to.
        </AlertDescription>
      </Alert>
    );
  if (isOutdated(pinned))
    return (
      <Alert className="py-2">
        <Info />
        <AlertDescription className="text-xs">
          This session runs an older manifest. A newer one (
          <span className="font-mono">{shortHash(pinned.registeredHash)}</span>) is registered;
          new sessions use it.
        </AlertDescription>
      </Alert>
    );
  return null;
}

function Lifecycle({ stages }: Readonly<{ stages: ReturnType<typeof lifecycle> }>) {
  return (
    <div className="flex flex-wrap items-stretch gap-1.5">
      {stages.map((stage, index) => (
        <Fragment key={stage.kind === "model" ? "model" : stage.method}>
          {index > 0 ? <span className="self-center text-xs text-muted-foreground">→</span> : null}
          {stage.kind === "model" ? (
            <div className="flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground">
              <Cpu className="size-3.5" />
              Model call
            </div>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-xs",
                    stage.capabilityIds.length === 0 && "border-dashed text-muted-foreground",
                  )}
                >
                  <div className="font-mono">{stage.method}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {stage.capabilityIds.length ? stage.capabilityIds.join(", ") : "none"}
                  </div>
                </div>
              </TooltipTrigger>
              <TooltipContent>
                {HOOK_HELP[stage.method]}{" "}
                {stage.perModelCall ? "Runs on every model call." : "Runs once per turn."}
              </TooltipContent>
            </Tooltip>
          )}
        </Fragment>
      ))}
    </div>
  );
}

function capabilityIcon(capability: CapabilityView): LucideIcon {
  if (capability.type === "agent-plugin") return Puzzle;
  if (capability.id === "agent") return Bot;
  if (capability.tools.length === 0 && capability.mcpServers.length) return Plug;
  if (capability.tools.every((tool) => tool.kind === "built-in") && capability.skills.length)
    return BookOpen;
  return Box;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function CapabilityItem({ capability }: Readonly<{ capability: CapabilityView }>) {
  const Icon = capabilityIcon(capability);
  const counts = [
    capability.tools.length ? plural(capability.tools.length, "tool") : "",
    capability.skills.length ? plural(capability.skills.length, "skill") : "",
    capability.mcpServers.length ? plural(capability.mcpServers.length, "server") : "",
    capability.hooks.length ? plural(capability.hooks.length, "hook") : "",
  ].filter(Boolean);
  return (
    <AccordionItem value={capability.id} className="px-3">
      <AccordionTrigger className="items-center py-3 hover:no-underline">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="font-mono text-[13px]">{capability.id}</span>
          {capability.id === "agent" ? (
            <span className="text-xs font-normal text-muted-foreground">own</span>
          ) : null}
          {capability.type === "agent-plugin" ? <Badge variant="outline">plugin</Badge> : null}
          <span className="ml-auto flex shrink-0 gap-1">
            {counts.map((label) => (
              <Badge key={label} variant="secondary" className="font-normal">
                {label}
              </Badge>
            ))}
          </span>
        </div>
      </AccordionTrigger>
      <AccordionContent className="space-y-4">
        {capability.description ? (
          <p className="text-sm text-muted-foreground">{capability.description}</p>
        ) : null}
        {capability.instructions.length ? (
          <Instructions instructions={capability.instructions} />
        ) : null}
        {TOOL_GROUPS.map((group) => {
          const tools = capability.tools.filter((tool) => group.kinds.includes(tool.kind));
          return tools.length ? (
            <Group key={group.title} icon={group.icon} title={group.title} note={group.note}>
              <ul className="divide-y rounded-md border">
                {tools.map((tool) => (
                  <ToolRow key={tool.name} tool={tool} />
                ))}
              </ul>
            </Group>
          ) : null;
        })}
        {capability.skills.length ? (
          <Group icon={BookOpen} title="Skills" note="loaded on demand">
            <ul className="divide-y rounded-md border">
              {capability.skills.map((skill) => (
                <li key={skill.name} className="px-3 py-2">
                  <div className="font-mono text-[13px] font-medium">{skill.name}</div>
                  {skill.description ? (
                    <p className="text-xs text-muted-foreground">{skill.description}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </Group>
        ) : null}
        {capability.mcpServers.length ? (
          <Group icon={Plug} title="MCP servers" note="tools discovered on the first turn">
            <div className="flex flex-wrap gap-1">
              {capability.mcpServers.map((name) => (
                <Badge key={name} variant="outline" className="font-mono">
                  {name}
                </Badge>
              ))}
            </div>
          </Group>
        ) : null}
      </AccordionContent>
    </AccordionItem>
  );
}

function Group({
  icon: Icon,
  title,
  note,
  children,
}: Readonly<{ icon: LucideIcon; title: string; note: string; children: ReactNode }>) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-xs">
        <Icon className="size-3.5 text-muted-foreground" />
        <span className="font-medium">{title}</span>
        <span className="text-muted-foreground">— {note}</span>
      </div>
      {children}
    </div>
  );
}

/** Instructions fold after a few lines; skill catalogs and plugins make them long. */
function Instructions({ instructions }: Readonly<{ instructions: readonly string[] }>) {
  const [open, setOpen] = useState(false);
  const text = instructions.join("\n\n");
  const long = text.split("\n").length > 4 || text.length > 320;
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium">Instructions</div>
      <div className="rounded-md border-l-2 bg-muted/50 px-3 py-2">
        <p
          className={cn(
            "text-xs leading-relaxed whitespace-pre-wrap break-words",
            long && !open && "line-clamp-4",
          )}
        >
          {text}
        </p>
      </div>
      {long ? (
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs text-muted-foreground"
          onClick={() => setOpen(!open)}
        >
          {open ? "Show less" : "Show all"}
        </Button>
      ) : null}
    </div>
  );
}

function ToolRow({ tool }: Readonly<{ tool: ToolView }>) {
  return (
    <li className="space-y-1.5 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <code className="font-mono text-[13px] font-medium">{tool.name}</code>
        {tool.kind === "flow-subagent" ? <Badge variant="outline">flow</Badge> : null}
      </div>
      {tool.description ? (
        <p className="text-xs text-muted-foreground">{tool.description}</p>
      ) : null}
      <TypeBlock tool={tool} />
    </li>
  );
}

/** A tool's input and output as TypeScript-like members, one per line. */
function TypeBlock({ tool }: Readonly<{ tool: ToolView }>) {
  const rows: [string, ToolView["input"]][] = [["input", tool.input]];
  if (tool.output) rows.push(["output", tool.output]);
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md bg-muted px-2.5 py-2 font-mono text-[11.5px] leading-5">
      {rows.map(([label, fields]) => (
        <Fragment key={label}>
          <span className="text-muted-foreground select-none">{label}</span>
          <span className="min-w-0 break-words">
            {fields.length === 0 ? (
              <span className="text-muted-foreground">none</span>
            ) : (
              fields.map((field) => (
                <span key={field.name || field.type} className="block">
                  {fieldText(field)}
                </span>
              ))
            )}
          </span>
        </Fragment>
      ))}
    </div>
  );
}

/** The manifest exactly as the Runtime returned it. */
function ManifestJson({ manifest }: Readonly<{ manifest: unknown }>) {
  const [copy, setCopy] = useState<"idle" | "copied" | "selected">("idle");
  const pre = useRef<HTMLPreElement>(null);
  const json = JSON.stringify(manifest, null, 2);
  const reset = () => window.setTimeout(() => setCopy("idle"), 2000);
  return (
    <div className="relative">
      <Button
        variant="outline"
        size="sm"
        className="absolute top-2 right-2 h-7 bg-background px-2 text-xs"
        onClick={() => {
          navigator.clipboard.writeText(json).then(
            () => setCopy("copied"),
            // The clipboard can be refused (an embedded frame, no permission): select the text.
            () => {
              if (pre.current) window.getSelection()?.selectAllChildren(pre.current);
              setCopy("selected");
            },
          );
          reset();
        }}
      >
        {copy === "copied" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        {copy === "copied" ? "Copied" : copy === "selected" ? "Selected — press ⌘C" : "Copy"}
      </Button>
      <pre
        ref={pre}
        className="overflow-x-auto rounded-lg border bg-muted/50 p-3 pr-20 font-mono text-[11.5px] leading-5"
      >
        {json}
      </pre>
    </div>
  );
}

function SandboxItem() {
  return (
    <AccordionItem value="sandbox" className="px-3">
      <AccordionTrigger className="items-center py-3 hover:no-underline">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Terminal className="size-4 shrink-0 text-muted-foreground" />
          <span className="font-mono text-[13px]">sandbox</span>
          <span className="text-xs font-normal text-muted-foreground">from the session</span>
          <span className="ml-auto">
            <Badge variant="secondary" className="font-normal">
              {plural(SANDBOX_TOOLS.length, "tool")}
            </Badge>
          </span>
        </div>
      </AccordionTrigger>
      <AccordionContent className="space-y-2">
        <p className="text-xs text-muted-foreground">
          The Runtime runs these on the session's persistent <code>/workspace</code>, not your
          Action endpoint.
        </p>
        <div className="flex flex-wrap gap-1">
          {SANDBOX_TOOLS.map((name) => (
            <Badge key={name} variant="outline" className="font-mono">
              {name}
            </Badge>
          ))}
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}
