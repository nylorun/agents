import { useMemo, useState } from "react";
import dayjs from "dayjs";
import { ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  agentOf,
  eventLabel,
  eventSummary,
  type StudioEvent,
} from "@/event-presentation";

const ROOT = "root";

function time(value: string): string {
  return dayjs(value).format("HH:mm:ss");
}

export function EventTable({
  events,
  selected,
  onSelect,
}: Readonly<{
  events: readonly StudioEvent[];
  selected?: StudioEvent;
  onSelect: (event: StudioEvent) => void;
}>) {
  const [selectedTypes, setSelectedTypes] = useState<
    readonly string[] | undefined
  >();
  const eventTypes = useMemo(
    () => [...new Set(events.map((event) => event.type))].sort(),
    [events],
  );
  const activeTypes = selectedTypes ?? eventTypes;
  // Agents used as tools, by path; events without one belong to the root agent.
  const [agent, setAgent] = useState<string | undefined>();
  const agents = useMemo(
    () =>
      [
        ...new Set(
          events.flatMap((event) => {
            const path = agentOf(event.payload)?.path;
            return path ? [path] : [];
          }),
        ),
      ].sort(),
    [events],
  );
  const visibleEvents = events.filter(
    (event) =>
      (selectedTypes === undefined || selectedTypes.includes(event.type)) &&
      (agent === undefined ||
        (agentOf(event.payload)?.path ?? ROOT) === agent),
  );
  const filterLabel =
    selectedTypes === undefined || selectedTypes.length === eventTypes.length
      ? "All event types"
      : selectedTypes.length === 0
        ? "No event types"
        : selectedTypes.length === 1
          ? eventLabel({ type: selectedTypes[0]! })
          : selectedTypes.length + " event types";
  const toggleType = (type: string, checked: boolean): void => {
    setSelectedTypes((current) => {
      const next = (current ?? eventTypes).filter((entry) => entry !== type);
      if (checked) next.push(type);
      return next.length === eventTypes.length &&
        eventTypes.every((entry) => next.includes(entry))
        ? undefined
        : next;
    });
  };
  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b bg-background px-4">
        <h2 className="text-sm font-medium">Events</h2>
        <span className="text-xs text-muted-foreground">
          {events.length} total
        </span>
        {agents.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="ml-auto w-44 justify-between font-normal"
              >
                <span className="truncate">{agent ?? "All agents"}</span>
                <ChevronDown className="size-4 opacity-50" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {[undefined, ROOT, ...agents].map((value) => (
                <DropdownMenuCheckboxItem
                  key={value ?? "all"}
                  checked={agent === value}
                  onCheckedChange={() => setAgent(value)}
                >
                  {value ?? "All agents"}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className={`${agents.length > 0 ? "" : "ml-auto "}w-44 justify-between font-normal`}
            >
              <span className="truncate">{filterLabel}</span>
              <ChevronDown className="size-4 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {eventTypes.length === 0 ? (
              <p className="px-2 py-1.5 text-sm text-muted-foreground">
                No event types yet
              </p>
            ) : (
              eventTypes.map((type) => (
                <DropdownMenuCheckboxItem
                  key={type}
                  checked={activeTypes.includes(type)}
                  onCheckedChange={(checked) =>
                    toggleType(type, checked === true)
                  }
                >
                  {eventLabel({ type })}
                </DropdownMenuCheckboxItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <TableHead className="w-28">Time</TableHead>
              <TableHead className="w-40">Type</TableHead>
              <TableHead>Summary</TableHead>
              <TableHead className="w-24">Delivery</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleEvents.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="h-28 text-center text-muted-foreground"
                >
                  {events.length === 0
                    ? "Events will appear when the session runs."
                    : "No events match this filter."}
                </TableCell>
              </TableRow>
            ) : (
              visibleEvents.map((event) => (
                <TableRow
                  key={event.eventId}
                  data-state={
                    selected?.eventId === event.eventId ? "selected" : undefined
                  }
                  className="cursor-pointer"
                  onClick={() => onSelect(event)}
                >
                  <TableCell className="text-xs text-muted-foreground">
                    {time(event.time)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{eventLabel(event)}</Badge>
                  </TableCell>
                  <TableCell className="max-w-0 truncate text-xs text-muted-foreground">
                    {eventSummary(event)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {event.committed ? "History" : "Live"}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </ScrollArea>
    </section>
  );
}
