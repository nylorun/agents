import { useCallback, useMemo, useState } from "react";
import type { AgentView } from "@nylorun/agents";
import { createTenantClient } from "@/proxy-client";
import { messageOf, useRead } from "@/resources/reads";
import { fullTime, shortTime } from "@/time-format";
import { ReadState } from "@/components/resource-layout";
import {
  ActionMenu,
  CodeBlock,
  EmptyRow,
  Fields,
  FilterMenu,
  SearchBox,
  SidePanel,
  TableFrame,
  TableToolbar,
  ToolbarCount,
  countText,
  cellClass,
  headClass,
  menuCellClass,
  rowClass,
  type MenuAction,
} from "@/components/data-table";

type Client = ReturnType<typeof createTenantClient>;
type MemoryVersion = Awaited<ReturnType<Client["agents"]["memories"]["versions"]>>["versions"][number];

const bytes = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KiB`);

/** Who made a change: a session's turn, or the principal of an API call. */
const actorOf = (version: MemoryVersion) => version.sessionId ?? version.actor;

/**
 * What the Agent keeps across every session (`/memories`): each memory by path with its
 * description, version and who changed it last. A row opens its content and its history.
 */
export function AgentMemory({ tenantId, agent }: { tenantId: string; agent: AgentView }) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const id = agent.id;
  const load = useCallback(
    async (signal: AbortSignal) => {
      const [list, changes] = await Promise.all([
        sdk.agents.memories.list(id, { signal }),
        sdk.agents.memories.versions(id, { limit: 100, signal }),
      ]);
      return { memories: list.memories, versions: changes.versions };
    },
    [sdk, id],
  );
  const read = useRead(load);
  const [search, setSearch] = useState("");
  const [by, setBy] = useState("any");
  const [open, setOpen] = useState<{ path: string; history: boolean }>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const memories = read.data?.memories ?? [];
  // The newest change to each path names who changed it last.
  const last = new Map<string, MemoryVersion>();
  for (const version of read.data?.versions ?? []) if (!last.has(version.path)) last.set(version.path, version);
  const actors = [...new Set(memories.flatMap((m) => (last.get(m.path) ? [actorOf(last.get(m.path)!)] : [])))];
  const needle = search.trim().toLowerCase();
  const shown = memories.filter(
    (m) =>
      (by === "any" || (last.get(m.path) && actorOf(last.get(m.path)!) === by)) &&
      (needle === "" || m.path.toLowerCase().includes(needle) || (m.description ?? "").toLowerCase().includes(needle)),
  );
  async function remove(path: string) {
    if (!window.confirm(`Delete the memory ${path}? Every session of ${id} stops seeing it. Its history stays.`)) return;
    setError("");
    setNotice("");
    try {
      await sdk.agents.memories.delete(id, path);
      setOpen(undefined);
      setNotice(`Deleted ${path}.`);
      read.reload();
    } catch (cause) {
      setError(messageOf(cause));
    }
  }
  const actions = (path: string): MenuAction[] => [
    { label: "Open", onSelect: () => setOpen({ path, history: false }) },
    { label: "History", onSelect: () => setOpen({ path, history: true }) },
    { label: "Copy path", onSelect: () => void navigator.clipboard.writeText(`/memories/${path}`) },
    { label: "Delete…", onSelect: () => void remove(path), destructive: true, separated: true },
  ];
  return (
    <div>
      {error ? (
        <p role="alert" className="border-b px-4 py-2 text-sm break-words text-red-600">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="border-b px-4 py-2 text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
      <TableToolbar>
        <SearchBox label="Search memories" value={search} onChange={setSearch} />
        <FilterMenu
          label="Changed by"
          value={by}
          options={[{ value: "any", label: "Anyone" }, ...actors.map((value) => ({ value, label: value }))]}
          onChange={setBy}
        />
        <ToolbarCount>
          {countText(shown.length, memories.length, "memory", "memories")}
        </ToolbarCount>
      </TableToolbar>
      <TableFrame minWidth={720}>
        <thead>
          <tr>
            <th className={`${headClass} w-[28%]`}>Memory</th>
            <th className={headClass}>Description</th>
            <th className={`${headClass} w-[9%]`}>Version</th>
            <th className={`${headClass} w-[14%]`}>Updated</th>
            <th className={`${headClass} w-[18%]`}>Changed by</th>
            <th className={`${headClass} w-12`}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {read.data && shown.length === 0 ? (
            <EmptyRow columns={6}>
              {memories.length === 0 ? "It keeps no memories yet." : "No memories match these filters."}
            </EmptyRow>
          ) : null}
          {shown.map((m) => {
            const change = last.get(m.path);
            return (
              <tr
                key={m.path}
                className={`${rowClass} cursor-pointer`}
                data-state={open?.path === m.path ? "selected" : undefined}
                onClick={() => setOpen({ path: m.path, history: false })}
              >
                <td className={`${cellClass} font-mono text-[13px]`} title={m.path}>
                  {m.path}
                </td>
                <td className={`${cellClass} text-muted-foreground`} title={m.description ?? undefined}>
                  {m.description ?? "—"}
                </td>
                <td className={cellClass}>v{m.version}</td>
                <td className={`${cellClass} text-muted-foreground`}>
                  <time dateTime={m.updatedAt} title={fullTime(m.updatedAt)}>
                    {shortTime(m.updatedAt)}
                  </time>
                </td>
                <td className={`${cellClass} font-mono text-xs text-muted-foreground`}>{change ? actorOf(change) : "—"}</td>
                <td className={menuCellClass}>
                  <ActionMenu label={`Actions for ${m.path}`} actions={actions(m.path)} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </TableFrame>
      <ReadState {...read} onRetry={read.reload} />
      {open ? (
        <MemoryPanel
          key={open.path}
          client={sdk}
          agentId={id}
          path={open.path}
          history={open.history}
          actions={actions(open.path).filter((action) => action.label !== "Open")}
          onClose={() => setOpen(undefined)}
        />
      ) : null}
    </div>
  );
}

function MemoryPanel({
  client,
  agentId,
  path,
  history,
  actions,
  onClose,
}: {
  client: Client;
  agentId: string;
  path: string;
  history: boolean;
  actions: MenuAction[];
  onClose: () => void;
}) {
  const load = useCallback(
    async (signal: AbortSignal) => {
      const [memory, versions] = await Promise.all([
        client.agents.memories.get(agentId, path, { signal }),
        client.agents.memories.versions(agentId, { path, limit: 20, signal }),
      ]);
      return { memory, versions: versions.versions };
    },
    [client, agentId, path],
  );
  const read = useRead(load);
  const memory = read.data?.memory;
  return (
    <SidePanel
      title={path}
      description={memory ? `v${memory.version} · ${bytes(memory.bytes)}` : undefined}
      actions={actions}
      onClose={onClose}
      wide
    >
      <ReadState {...read} onRetry={read.reload} />
      {memory ? (
        <>
          {memory.description ? <p className="text-sm text-muted-foreground">{memory.description}</p> : null}
          {history ? null : <CodeBlock label="Content">{memory.content}</CodeBlock>}
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">History</p>
            <ol className="divide-y rounded-md border text-sm">
              {read.data!.versions.map((version) => (
                <li key={version.id} className="flex items-center gap-3 px-3 py-2">
                  <span className="w-20 shrink-0">{version.operation.replace(/_/gu, " ")}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={version.actor}>
                    {actorOf(version)}
                  </span>
                  <time className="shrink-0 text-xs text-muted-foreground" dateTime={version.createdAt} title={fullTime(version.createdAt)}>
                    {shortTime(version.createdAt)}
                  </time>
                </li>
              ))}
            </ol>
          </div>
          {history ? <CodeBlock label="Content">{memory.content}</CodeBlock> : null}
          <Fields
            entries={[
              ["Path", <span className="font-mono text-xs">/memories/{memory.path}</span>],
              ["Updated", fullTime(memory.updatedAt)],
              ["SHA-256", <span className="font-mono text-xs break-all">{memory.contentSha256}</span>],
            ]}
          />
        </>
      ) : null}
    </SidePanel>
  );
}
