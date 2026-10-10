import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { SandboxEvent } from "@nylorun/agents";
import { createTenantClient } from "@/proxy-client";
import { usePages, useRead } from "@/resources/reads";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Metadata,
  ReadState,
  ResourceHeader,
  ResourceLayout,
} from "@/components/resource-layout";

const date = (value?: string) =>
  value ? new Date(value).toLocaleString() : "—";

export function Sandboxes({ tenantId }: { tenantId: string }) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const [query, setQuery] = useSearchParams();
  const selected = query.get("selected") ?? "";
  const labelValues = query.getAll("label");
  const labelKey = JSON.stringify(labelValues);
  const [labelInput, setLabelInput] = useState(labelValues.join("\n"));
  const [labelError, setLabelError] = useState("");
  useEffect(() => {
    setLabelInput((JSON.parse(labelKey) as string[]).join("\n"));
    setLabelError("");
  }, [labelKey]);
  const load = useCallback(
    async (signal: AbortSignal, cursor?: string) => {
      const labels: Record<string, string> = {};
      for (const value of JSON.parse(labelKey) as string[]) {
        const at = value.indexOf("=");
        if (at <= 0) throw new Error("Labels must use key=value.");
        labels[value.slice(0, at)] = value.slice(at + 1);
      }
      const page = await sdk.sandboxes.page({
        labels,
        limit: 50,
        cursor,
        signal,
      });
      return { items: page.sandboxes, nextCursor: page.nextCursor };
    },
    [sdk, labelKey],
  );
  const page = usePages(load);
  function filter(event: FormEvent) {
    event.preventDefault();
    const labels = labelInput
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (labels.some((s) => s.indexOf("=") <= 0))
      return setLabelError("Use one key=value label per line.");
    setLabelError("");
    const next = new URLSearchParams(query);
    next.delete("label");
    for (const label of labels) next.append("label", label);
    setQuery(next);
  }
  function select(id?: string) {
    const next = new URLSearchParams(query);
    if (id) next.set("selected", id);
    else next.delete("selected");
    setQuery(next);
  }
  return (
    <ResourceLayout
      title="Sandbox details"
      onClose={() => select()}
      inspector={
        selected ? (
          <SandboxInspector
            key={selected}
            tenantId={tenantId}
            id={selected}
            onClose={() => select()}
          />
        ) : undefined
      }
    >
      <div className="space-y-4 p-4">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-semibold">Sandboxes</h1>
          <Button
            variant="outline"
            onClick={page.reload}
            disabled={page.pending}
          >
            Refresh sandboxes
          </Button>
        </div>
        <form className="flex flex-wrap items-end gap-2" onSubmit={filter}>
          <label className="flex flex-1 flex-col gap-1 text-sm">
            Labels
            <textarea
              aria-label="Sandbox labels"
              className="min-h-10 rounded-md border bg-background p-2"
              placeholder="project=build"
              value={labelInput}
              onChange={(e) => setLabelInput(e.target.value)}
            />
          </label>
          <Button type="submit" variant="outline">
            Apply labels
          </Button>
        </form>
        {labelError ? (
          <p role="alert" className="text-sm">
            {labelError}
          </p>
        ) : null}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Kind / state</TableHead>
              <TableHead>Sessions</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.items.map((s) => (
              <TableRow
                key={s.id}
                data-state={selected === s.id ? "selected" : undefined}
                onClick={() => select(s.id)}
              >
                <TableCell className="whitespace-normal break-all">
                  <button
                    className="text-left underline-offset-4 hover:underline"
                    onClick={(e) => {
                      e.stopPropagation();
                      select(s.id);
                    }}
                  >
                    {s.id}
                  </button>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{s.kind}</Badge>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {s.pod?.observed ?? s.state}
                  </p>
                </TableCell>
                <TableCell>{s.sessions.length}</TableCell>
                <TableCell>{date(s.updatedAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <ReadState
          {...page}
          onRetry={page.reload}
          empty={
            page.items.length ? undefined : "No sandboxes match these labels."
          }
        />
        {page.more ? (
          <Button
            variant="outline"
            disabled={page.pending}
            onClick={page.loadMore}
          >
            Load more sandboxes
          </Button>
        ) : null}
      </div>
    </ResourceLayout>
  );
}

function SandboxInspector({
  tenantId,
  id,
  onClose,
}: {
  tenantId: string;
  id: string;
  onClose: () => void;
}) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const [query, setQuery] = useSearchParams();
  const tab = ["details", "sessions", "events"].includes(query.get("tab") ?? "")
    ? query.get("tab")!
    : "details";
  const load = useCallback(
    (signal: AbortSignal) => sdk.sandboxes.get(id, { signal }),
    [sdk, id],
  );
  const read = useRead(load);
  const s = read.data;
  return (
    <section className="flex h-full min-h-0 flex-col">
      <ResourceHeader title={id} onClose={onClose}>
        <Button
          size="sm"
          variant="outline"
          onClick={read.reload}
          disabled={read.pending}
        >
          Refresh details
        </Button>
      </ResourceHeader>
      <Tabs
        value={tab}
        onValueChange={(value) => {
          const next = new URLSearchParams(query);
          next.set("tab", value);
          setQuery(next);
        }}
        className="min-h-0 flex-1 overflow-auto p-4"
      >
        <TabsList aria-label="Sandbox tabs">
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="sessions">Sessions</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
        </TabsList>
        <ReadState {...read} onRetry={read.reload} />
        {s ? (
          <>
            <TabsContent value="details" className="space-y-4">
              <Metadata
                entries={[
                  ["ID", s.id],
                  ["Kind", s.kind],
                  ["Workspace", s.state],
                  ["Created", date(s.createdAt)],
                  ["Updated", date(s.updatedAt)],
                ]}
              />
              {s.pod ? (
                <Metadata
                  entries={[
                    ["Desired", s.pod.desired],
                    ["Observed", s.pod.observed],
                    ["Expires", date(s.pod.expiresAt)],
                    ["Volume generation", s.pod.volumeGeneration],
                    ["Host epoch", s.pod.hostEpoch],
                    ["Reason", s.pod.reason],
                  ]}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  Virtual workspace; stopped means its turn queue is idle. There
                  is no pod to suspend.
                </p>
              )}
              <h3 className="text-sm font-medium">Labels</h3>
              <pre className="whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">
                {JSON.stringify(s.labels, null, 2)}
              </pre>
              <h3 className="text-sm font-medium">Resolved spec</h3>
              <pre className="whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">
                {JSON.stringify(s.spec, null, 2)}
              </pre>
            </TabsContent>
            <TabsContent value="sessions">
              <SandboxSessions
                tenantId={tenantId}
                id={id}
                active={s.sessions}
              />
            </TabsContent>
            <TabsContent value="events">
              <SandboxEvents tenantId={tenantId} id={id} />
            </TabsContent>
          </>
        ) : null}
      </Tabs>
    </section>
  );
}

function SandboxSessions({
  tenantId,
  id,
  active,
}: {
  tenantId: string;
  id: string;
  active: { id: string; activeTurnId: string | null }[];
}) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const load = useCallback(
    async (signal: AbortSignal, cursor?: string) => {
      const page = await sdk.sessions.page({
        sandboxId: id,
        limit: 50,
        cursor,
        signal,
      });
      return { items: page.sessions, nextCursor: page.nextCursor };
    },
    [sdk, id],
  );
  const page = usePages(load);
  return (
    <div className="space-y-3">
      <ReadState
        {...page}
        onRetry={page.reload}
        empty={page.items.length ? undefined : "No attached sessions."}
      />
      {page.items.map((s) => (
        <div key={s.id} className="space-y-2 border-b py-3 text-sm">
          <Link
            className="break-all underline"
            to={`/sessions/${encodeURIComponent(s.id)}`}
          >
            {s.id}
          </Link>
          <p className="break-all text-muted-foreground">
            {s.agentId} · {s.status}
          </p>
          {active.find((a) => a.id === s.id)?.activeTurnId ? (
            <p className="break-all text-xs">
              Active turn: {active.find((a) => a.id === s.id)!.activeTurnId}
            </p>
          ) : null}
          <Link
            className="inline-block underline"
            to={`/artifacts?${new URLSearchParams({ sessionId: s.id })}`}
          >
            View artifacts
          </Link>
        </div>
      ))}
      {page.more ? (
        <Button
          variant="outline"
          disabled={page.pending}
          onClick={page.loadMore}
        >
          Load more sessions
        </Button>
      ) : null}
    </div>
  );
}

function SandboxEvents({ tenantId, id }: { tenantId: string; id: string }) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const accumulated = useRef<SandboxEvent[]>([]);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const from = accumulated.current.reduce(
        (n, e) => Math.max(n, e.seq + 1),
        0,
      );
      const next = await sdk.sandboxes.events(id, { from, signal });
      signal.throwIfAborted();
      accumulated.current = Array.from(
        new Map(
          [...accumulated.current, ...next].map((e) => [e.seq, e]),
        ).values(),
      ).sort((a, b) => a.seq - b.seq);
      return accumulated.current;
    },
    [sdk, id],
  );
  const read = useRead(load);
  return (
    <div className="space-y-3">
      <Button variant="outline" disabled={read.pending} onClick={read.reload}>
        Refresh events
      </Button>
      <ReadState
        {...read}
        onRetry={read.reload}
        empty={read.data?.length ? undefined : "No lifecycle events."}
      />
      {read.data?.map((e) => (
        <details key={e.eventId} className="border-b py-2 text-sm">
          <summary className="break-all">
            {e.seq} · {e.type}
            <span className="block text-xs text-muted-foreground">
              {date(e.time)}
            </span>
          </summary>
          <pre className="mt-2 whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">
            {JSON.stringify(e.payload, null, 2)}
          </pre>
        </details>
      ))}
    </div>
  );
}
