import { Link } from "react-router-dom";
import { artifactHref, artifactReferences } from "@/resources/artifacts";
import { X } from "lucide-react";
import dayjs from "dayjs";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  eventLabel,
  pluginLabel,
  toolName,
  toolTrace,
  type StudioEvent,
} from "@/event-presentation";
import { PluginBadge, ToolTraceBadges } from "@/components/tool-trace";

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "Unserializable value";
  }
}

export function EventDetails({
  event,
  onClose,
}: Readonly<{ event: StudioEvent; onClose: () => void }>) {
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-background px-4">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">{eventLabel(event)}</h2>
          <p className="font-mono text-xs text-muted-foreground">
            {event.eventId.slice(0, 8)}…
          </p>
        </div>
        <Button
          className="ml-auto"
          size="icon"
          variant="ghost"
          onClick={onClose}
        >
          <X className="size-4" />
          <span className="sr-only">Close event details</span>
        </Button>
      </header>
      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <div className="min-w-0 max-w-full space-y-4 overflow-hidden p-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Event ID</dt>
            <dd className="break-all font-mono text-xs">{event.eventId}</dd>
            <dt className="text-muted-foreground">Cursor</dt>
            <dd className="break-all font-mono text-xs">{event.cursor}</dd>
            <dt className="text-muted-foreground">Created</dt>
            <dd>{dayjs(event.time).format("YYYY-MM-DD HH:mm:ss")}</dd>
            <dt className="text-muted-foreground">Type</dt>
            <dd className="font-mono text-xs">{event.type}</dd>
            <dt className="text-muted-foreground">Turn</dt>
            <dd className="font-mono text-xs">{event.turnId ?? "—"}</dd>
            <dt className="text-muted-foreground">Delivery</dt>
            <dd>{event.committed ? "History (/items)" : "Live SSE (/events)"}</dd>
          </dl>
          {event.type === "tool.completed" ? <ToolTraceSection payload={event.payload} /> : null}
          {event.type === "mcp.discovered" ? <McpServersSection payload={event.payload} /> : null}
          {artifactReferences(event).map(ref => (
            <Link
              key={`${ref.artifactId}:${ref.version}`}
              className="block break-all text-sm underline"
              to={artifactHref(ref.artifactId, ref.version, event.sessionId)}
            >
              Open {ref.name} · v{ref.version}
            </Link>
          ))}
          <section className="min-w-0 max-w-full">
            <h3 className="text-sm font-semibold">Payload</h3>
            <pre className="mt-2 w-full max-w-full overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs leading-5">
              {pretty(event.payload)}
            </pre>
          </section>
          <section className="min-w-0 max-w-full">
            <h3 className="text-sm font-semibold">Live event</h3>
            <pre className="mt-2 w-full max-w-full overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs leading-5">
              {pretty(event)}
            </pre>
          </section>
        </div>
      </ScrollArea>
    </section>
  );
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

/** The tool a `tool.completed` ran, where it ran, and what brought it. */
function ToolTraceSection({ payload }: Readonly<{ payload: unknown }>) {
  const call = record(payload);
  const trace = toolTrace(payload);
  return (
    <section className="min-w-0 max-w-full">
      <h3 className="text-sm font-semibold">Tool call</h3>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-xs">
          {toolName(call)}
        </span>
        <ToolTraceBadges trace={trace} />
      </div>
    </section>
  );
}

/** Each server `mcp.discovered` readied, with the plugin that brought it. */
function McpServersSection({ payload }: Readonly<{ payload: unknown }>) {
  const servers = Array.isArray(record(payload).servers)
    ? (record(payload).servers as unknown[]).map(record)
    : [];
  if (servers.length === 0) return null;
  return (
    <section className="min-w-0 max-w-full">
      <h3 className="text-sm font-semibold">MCP servers</h3>
      <ul className="mt-2 divide-y rounded-md border">
        {servers.map((server, index) => {
          const plugin = pluginLabel(server.plugin);
          return (
            <li key={index} className="flex flex-wrap items-center gap-1.5 px-3 py-2 text-xs">
              <span className="font-mono font-medium">
                {typeof server.serverName === "string" ? server.serverName : "server"}
              </span>
              {plugin ? <PluginBadge plugin={plugin} /> : null}
              <span className="text-muted-foreground">
                {server.outcome === "connected"
                  ? `connected · ${Number(server.tools ?? 0)} tool${Number(server.tools ?? 0) === 1 ? "" : "s"}`
                  : typeof server.outcome === "string"
                    ? server.outcome
                    : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
