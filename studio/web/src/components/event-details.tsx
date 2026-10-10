import { Link } from "react-router-dom";
import { artifactHref, artifactReferences } from "@/resources/artifacts";
import { X } from "lucide-react";
import dayjs from "dayjs";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  eventLabel,
  type StudioEvent,
} from "@/event-presentation";

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
          <h2 className="truncate text-sm font-medium">{eventLabel(event)}</h2>
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
            <h3 className="text-sm font-medium">Payload</h3>
            <pre className="mt-2 w-full max-w-full overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs leading-5">
              {pretty(event.payload)}
            </pre>
          </section>
          <section className="min-w-0 max-w-full">
            <h3 className="text-sm font-medium">Live event</h3>
            <pre className="mt-2 w-full max-w-full overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs leading-5">
              {pretty(event)}
            </pre>
          </section>
        </div>
      </ScrollArea>
    </section>
  );
}
