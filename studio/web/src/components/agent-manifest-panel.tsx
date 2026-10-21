import { useRef, useState } from "react";
import { Bot, Braces, Check, Copy, Info, LayoutList, Workflow, type LucideIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { flowOf, harnessSpec } from "@/agent-spec";
import { ManifestSpec } from "@/components/manifest-spec";
import { isOutdated, manifestView, shortHash, type PinnedManifestState } from "@/manifest/model";
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
 * A session's Manifest tab, Declared view: the loop manifest it pinned (`pinned`), named by its agent manifest
 * and version, as JSON or laid out as the Agent and Tenant pages lay out a manifest (`ManifestSpec`):
 * its harness, a flow agent's stages drawn atop it, and the sandbox's tools when its Agent has one.
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
  const version = pinned.kind === "pinned" || pinned.kind === "agent" ? pinned.version : undefined;
  return (
    // Radix sizes the viewport's child as a table, which grows to the longest line.
    <ScrollArea className="h-full [&_[data-slot=scroll-area-viewport]>div]:block!">
      <div className="space-y-4 p-4">
        <header className="space-y-2">
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted">
              {isWorkflow ? <Workflow className="size-4" /> : <Bot className="size-4" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm leading-tight font-semibold">{agent.name}</h2>
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

        {mode === "json" ? <ManifestJson manifest={manifest} /> : null}
      </div>
      {mode === "layout" ? (
        <div className="pb-4">
          <ManifestSpec
            sections={harnessSpec(manifest, { sandbox: hasSandbox && !isWorkflow })}
            flow={flowOf(manifest, agent.name)}
            flowHint={version ? `as v${version.version} declares them` : "as the session's manifest declares them"}
            detail="inline"
          />
        </div>
      ) : null}
    </ScrollArea>
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
