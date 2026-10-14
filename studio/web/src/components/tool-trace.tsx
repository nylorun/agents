import { BookOpen, Puzzle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { pluginText, type PluginLabel } from "@/manifest/model";
import type { ToolTrace } from "@/event-presentation";

/** The Agent Plugin that brought a skill or an MCP server: `name version`. */
export function PluginBadge({ plugin }: Readonly<{ plugin: PluginLabel }>) {
  return (
    <Badge variant="outline" className="gap-1 font-normal" title="Agent Plugin">
      <Puzzle className="size-3" />
      {pluginText(plugin)}
    </Badge>
  );
}

/** Where a tool call ran and what brought it: its kind, server or skill, and plugin. */
export function ToolTraceBadges({ trace }: Readonly<{ trace: ToolTrace }>) {
  return (
    <>
      {trace.kind ? (
        <Badge variant="secondary" className="font-normal">
          {trace.kind}
        </Badge>
      ) : null}
      {trace.server ? (
        <span className="font-mono text-xs font-normal text-muted-foreground">{trace.server}</span>
      ) : null}
      {trace.skill ? (
        <Badge variant="outline" className="gap-1 font-normal" title="Skill">
          <BookOpen className="size-3" />
          {trace.skill}
        </Badge>
      ) : null}
      {trace.plugin ? <PluginBadge plugin={trace.plugin} /> : null}
    </>
  );
}
