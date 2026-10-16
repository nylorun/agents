import { Fragment, useRef, useState, type ReactNode } from "react";
import {
  BookOpen,
  Bot,
  Braces,
  Check,
  Copy,
  Info,
  LayoutList,
  Plug,
  Terminal,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { PluginBadge } from "@/components/tool-trace";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  SANDBOX_TOOLS,
  byPlugin,
  isOutdated,
  manifestStats,
  manifestView,
  pluginText,
  shortHash,
  fieldText,
  type ManifestView,
  type PinnedManifestState,
  type PluginFilter,
  type PluginLabel,
  type ToolView,
} from "@/manifest/model";
import type { AgentManifest } from "@/studio-types";

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

/**
 * A session's Manifest tab: the loop manifest it pinned (`pinned`), named by its agent manifest
 * and version, laid out or as JSON, and whether its Agent has a sandbox.
 */
export function AgentManifestPanel({
  agent,
  pinned,
  hasSandbox,
}: Readonly<{ agent: AgentManifest; pinned: PinnedManifestState; hasSandbox: boolean }>) {
  const [mode, setMode] = useState<"layout" | "json">("layout");
  // Show the manifest the session runs; until it is known, what the definition holds.
  const manifest =
    pinned.kind === "pinned" || pinned.kind === "agent" ? pinned.manifest : (agent.rawManifest ?? agent.manifest);
  const isWorkflow =
    agent.kind === "workflow" || (manifest as { kind?: unknown }).kind === "workflow";
  const view = manifestView(manifest);
  const stats = manifestStats(view);
  // The session's Agent says whether it has a sandbox: its loop manifest holds none (protocol 15).
  const sandboxOn = hasSandbox;
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
              <Stat icon={Plug} value={stats.mcpServers} label="MCP servers" />
              <Stat
                icon={Terminal}
                value={sandboxOn ? "On" : "Off"}
                label="Sandbox"
                muted={!sandboxOn}
              />
            </div>

            <ManifestSections view={view} hasSandbox={hasSandbox} />
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
  const version = pinned.kind === "pinned" || pinned.kind === "agent" ? pinned.version : undefined;
  const hash = pinned.kind === "pinned" ? pinned.manifestHash : undefined;
  return (
    <>
      {version ? (
        <span className="font-mono">
          {version.name}@{version.version}
        </span>
      ) : null}
      {hash ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-default font-mono">manifest {shortHash(hash)}</span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs font-mono break-all">Session manifest {hash}</TooltipContent>
        </Tooltip>
      ) : null}
    </>
  );
}

function VersionAlert({ pinned }: Readonly<{ pinned: PinnedManifestState }>) {
  if (pinned.kind === "failed")
    return (
      <Alert variant="destructive" className="py-2">
        <Info />
        <AlertDescription className="text-xs">
          Could not read the session's manifest: {pinned.message}.
        </AlertDescription>
      </Alert>
    );
  if (pinned.kind === "agent")
    return (
      <Alert className="py-2">
        <Info />
        <AlertDescription className="text-xs">
          Showing the manifest version the session's Agent runs. This Runtime does not report the
          manifest the session pinned.
        </AlertDescription>
      </Alert>
    );
  if (isOutdated(pinned))
    return (
      <Alert className="py-2">
        <Info />
        <AlertDescription className="text-xs">
          This session runs {pinned.version.name} v{pinned.version.version}; v{pinned.latest} is
          the latest. Its next turn runs the version its Agent runs: move the Agent (Track, or
          Move to v{pinned.latest} on its page) to run the newer one.
        </AlertDescription>
      </Alert>
    );
  return null;
}

/** The agent's parts, flat: instructions, tools, skills, MCP servers, then its sandbox's tools. */
function ManifestSections({
  view,
  hasSandbox,
}: Readonly<{ view: ManifestView; hasSandbox: boolean }>) {
  const [filter, setFilter] = useState<PluginFilter>("all");
  const skills = byPlugin(view.skills, filter);
  const servers = byPlugin(view.mcpServers, filter);
  return (
    <>
      <Section title="Instructions" hint="The agent's own, in order.">
        {view.instructions.length ? (
          <Instructions instructions={view.instructions} label={false} />
        ) : (
          <p className="text-sm text-muted-foreground">None</p>
        )}
      </Section>

      <Section title="Tools" hint="The Runtime makes an HTTP tool's request and runs an agent tool; it runs no code tool.">
        {view.tools.length ? (
          <ul className="divide-y rounded-md border">
            {view.tools.map((tool) => (
              <ToolRow key={tool.name} tool={tool} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">None</p>
        )}
      </Section>

      {view.plugins.length ? (
        <PluginFilterBar plugins={view.plugins} value={filter} onChange={setFilter} />
      ) : null}

      <Section title="Skills" hint="Loaded on demand with load_skill.">
        {skills.length ? (
          <ul className="divide-y rounded-md border">
            {skills.map((skill) => (
              <li key={skill.name} className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[13px] font-medium">{skill.name}</span>
                  {skill.plugin ? <PluginBadge plugin={skill.plugin} /> : null}
                </div>
                {skill.description ? (
                  <p className="text-xs text-muted-foreground">{skill.description}</p>
                ) : null}
                {skill.files.length ? (
                  <ul className="mt-1 font-mono text-[11px] text-muted-foreground">
                    {skill.files.map((path) => (
                      <li key={path}>{path}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">None</p>
        )}
      </Section>

      <Section title="MCP servers" hint="Their tools are discovered on the first turn.">
        {servers.length ? (
          <ul className="divide-y rounded-md border">
            {servers.map((server) => (
              <li key={server.name} className="space-y-0.5 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[13px] font-medium">{server.name}</span>
                  {server.plugin ? <PluginBadge plugin={server.plugin} /> : null}
                  {server.approval ? <Badge variant="outline">approval</Badge> : null}
                </div>
                {server.url ? (
                  <p className="font-mono text-[11.5px] break-all text-muted-foreground">
                    {server.url}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">None</p>
        )}
      </Section>

      {hasSandbox ? <SandboxSection /> : null}
    </>
  );
}

/** Narrows the skills and servers to the agent's own or one plugin's. */
function PluginFilterBar({
  plugins,
  value,
  onChange,
}: Readonly<{ plugins: readonly PluginLabel[]; value: PluginFilter; onChange: (value: PluginFilter) => void }>) {
  return (
    <div className="flex flex-wrap items-center gap-2 pt-2">
      <span className="text-xs text-muted-foreground">Skills and servers from</span>
      <ToggleGroup
        type="single"
        size="sm"
        value={value}
        onValueChange={(next) => {
          if (next) onChange(next);
        }}
        aria-label="Filter by plugin"
        className="flex-wrap gap-0.5 rounded-lg bg-muted p-0.5"
      >
        <ToggleGroupItem value="all" className={FILTER}>
          All
        </ToggleGroupItem>
        <ToggleGroupItem value="own" className={FILTER}>
          Own
        </ToggleGroupItem>
        {plugins.map((plugin) => (
          <ToggleGroupItem key={pluginText(plugin)} value={pluginText(plugin)} className={FILTER}>
            {pluginText(plugin)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

const FILTER =
  "h-6 rounded-md! px-2 text-xs text-muted-foreground hover:bg-transparent data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm!";

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
function Instructions({
  instructions,
  label = true,
}: Readonly<{ instructions: readonly string[]; label?: boolean }>) {
  const [open, setOpen] = useState(false);
  const text = instructions.join("\n\n");
  const long = text.split("\n").length > 4 || text.length > 320;
  return (
    <div className="space-y-1">
      {label ? <div className="text-xs font-medium">Instructions</div> : null}
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
        <ToolKindBadge tool={tool} />
        {tool.approval ? <Badge variant="outline">approval</Badge> : null}
      </div>
      {tool.http ? (
        <p className="font-mono text-[11.5px] break-all text-muted-foreground">
          {tool.http.method} {tool.http.url}
        </p>
      ) : null}
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

function ToolKindBadge({ tool }: Readonly<{ tool: ToolView }>) {
  if (tool.kind === "http")
    return (
      <Badge variant="outline" className="font-normal">
        HTTP
      </Badge>
    );
  if (tool.kind === "subagent")
    return (
      <Badge variant="outline" className="gap-1 font-normal">
        <Bot className="size-3" />
        agent
      </Badge>
    );
  if (tool.kind === "flow-subagent")
    return (
      <Badge variant="outline" className="gap-1 font-normal">
        <Workflow className="size-3" />
        flow agent
      </Badge>
    );
  if (tool.kind === "code")
    return (
      <Badge variant="secondary" className="gap-1 font-normal">
        <Wrench className="size-3" />
        code
      </Badge>
    );
  return null;
}

/** The session's Agent has a sandbox: the harness offers its tools with the agent's. */
function SandboxSection() {
  return (
    <Section title="Sandbox" hint="The session's Agent has a sandbox; the harness offers these tools.">
      <Group icon={Terminal} title="Sandbox tools" note={`on the session's persistent /workspace`}>
        <div className="flex flex-wrap gap-1">
          {SANDBOX_TOOLS.map((name) => (
            <Badge key={name} variant="outline" className="font-mono">
              {name}
            </Badge>
          ))}
        </div>
      </Group>
    </Section>
  );
}
