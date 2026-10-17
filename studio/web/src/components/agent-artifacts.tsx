import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AgentView } from "@nylorun/agents";
import { createTenantClient } from "@/proxy-client";
import { useRead } from "@/resources/reads";
import { sessionPath } from "@/session-list";
import { fullTime, shortTime } from "@/time-format";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { ReadState } from "@/components/resource-layout";
import { ArtifactInspector, useArtifactSelection } from "@/components/artifacts";
import {
  ActionMenu,
  EmptyRow,
  FilterMenu,
  SearchBox,
  TableFrame,
  TableToolbar,
  ToolbarCount,
  countText,
  cellClass,
  headClass,
  menuCellClass,
  rowClass,
} from "@/components/data-table";

type Selection = ReturnType<typeof useArtifactSelection>;

/** An artifact's inspector (preview, versions, changes), over the page from the right. */
export function ArtifactSheet({
  tenantId,
  selection,
  onClose,
}: {
  tenantId: string;
  selection: Selection;
  onClose: () => void;
}) {
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full gap-0 overflow-hidden sm:max-w-2xl" showCloseButton={false}>
        <SheetTitle className="sr-only">Artifact</SheetTitle>
        <SheetDescription className="sr-only">An artifact's files and versions</SheetDescription>
        <ArtifactInspector key={selection.id} tenantId={tenantId} selection={selection} onClose={onClose} />
      </SheetContent>
    </Sheet>
  );
}

type Row = {
  key: string;
  artifactId: string;
  name: string;
  kind: string;
  source: "session" | "input";
  sessionId?: string;
  version: number;
  updatedAt?: string;
};

/**
 * What the Agent's sessions made and what its runtime copies in: each session's artifacts (read
 * one session at a time, never the Tenant's whole list) and the input files its manifest version
 * names. A row opens the artifact's inspector on the right.
 */
export function AgentArtifacts({ tenantId, agent }: { tenantId: string; agent: AgentView }) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const navigate = useNavigate();
  const selection = useArtifactSelection("agent");
  const sessionIds = agent.sessions.map((s) => s.id).join("\n");
  const load = useCallback(
    async (signal: AbortSignal) => {
      const ids = sessionIds ? sessionIds.split("\n") : [];
      const lists = await Promise.all(ids.map((sessionId) => sdk.artifacts.list({ sessionId, signal })));
      // A session's list may hold an artifact another's does: each shows once.
      return [...new Map(lists.flat().map((a) => [a.artifactId, a])).values()];
    },
    [sdk, sessionIds],
  );
  const read = useRead(load);
  const [search, setSearch] = useState("");
  const [source, setSource] = useState<"any" | Row["source"]>("any");
  const [session, setSession] = useState("any");
  const rows: Row[] = [
    ...(read.data ?? [])
      .map((a) => ({
        key: a.artifactId,
        artifactId: a.artifactId,
        name: a.name,
        kind: a.kind,
        source: "session" as const,
        ...(a.sessionId ? { sessionId: a.sessionId } : {}),
        version: a.latestVersion,
        updatedAt: a.updatedAt,
      }))
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")),
    ...(agent.runtime.files ?? []).flatMap((file, index) =>
      "artifactId" in file
        ? [
            {
              key: `input:${index}`,
              artifactId: file.artifactId,
              name: file.path,
              kind: "input",
              source: "input" as const,
              version: file.version,
            },
          ]
        : [],
    ),
  ];
  const needle = search.trim().toLowerCase();
  const shown = rows.filter(
    (row) =>
      (source === "any" || row.source === source) &&
      (session === "any" || row.sessionId === session) &&
      (needle === "" || row.name.toLowerCase().includes(needle) || (row.sessionId ?? "").toLowerCase().includes(needle)),
  );
  const open = (row: Row) =>
    selection.update({ selected: row.artifactId, version: String(row.version), tab: "preview", file: null });
  const close = () => selection.update({ selected: null, version: null, tab: null, file: null });
  return (
    <div>
      <TableToolbar>
        <SearchBox label="Search artifacts" value={search} onChange={setSearch} />
        <FilterMenu
          label="Source"
          value={source}
          options={[
            { value: "any", label: "Any" },
            { value: "session", label: "Sessions" },
            { value: "input", label: "Input files" },
          ]}
          onChange={setSource}
        />
        <FilterMenu
          label="Session"
          value={session}
          options={[{ value: "any", label: "Any" }, ...agent.sessions.map((s) => ({ value: s.id, label: s.id }))]}
          onChange={setSession}
        />
        <ToolbarCount>
          {countText(shown.length, rows.length, "artifact", "artifacts")}
        </ToolbarCount>
      </TableToolbar>
      <TableFrame minWidth={720}>
        <thead>
          <tr>
            <th className={headClass}>Name</th>
            <th className={`${headClass} w-[14%]`}>Source</th>
            <th className={`${headClass} w-[24%]`}>Session</th>
            <th className={`${headClass} w-[10%]`}>Version</th>
            <th className={`${headClass} w-[14%]`}>Updated</th>
            <th className={`${headClass} w-12`}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {!read.pending && shown.length === 0 ? (
            <EmptyRow columns={6}>
              {rows.length === 0 ? "Its sessions have made no artifacts yet." : "No artifacts match these filters."}
            </EmptyRow>
          ) : null}
          {shown.map((row) => (
            <tr
              key={row.key}
              className={`${rowClass} cursor-pointer`}
              data-state={selection.id === row.artifactId ? "selected" : undefined}
              onClick={() => open(row)}
            >
              <td className={`${cellClass} font-mono text-[13px]`} title={row.name}>
                {row.name}
              </td>
              <td className={`${cellClass} text-muted-foreground`}>{row.source === "input" ? "Input file" : row.kind === "folder" ? "Folder" : "File"}</td>
              <td className={`${cellClass} font-mono text-xs text-muted-foreground`} title={row.sessionId}>
                {row.sessionId ?? "—"}
              </td>
              <td className={cellClass}>v{row.version}</td>
              <td className={`${cellClass} text-muted-foreground`}>
                {row.updatedAt ? (
                  <time dateTime={row.updatedAt} title={fullTime(row.updatedAt)}>
                    {shortTime(row.updatedAt)}
                  </time>
                ) : (
                  "—"
                )}
              </td>
              <td className={menuCellClass}>
                <ActionMenu
                  label={`Actions for ${row.name}`}
                  actions={[
                    { label: "Open", onSelect: () => open(row) },
                    { label: "Copy artifact ID", onSelect: () => void navigator.clipboard.writeText(row.artifactId) },
                    ...(row.sessionId
                      ? [{ label: "Open session", onSelect: () => navigate(sessionPath(agent.id, row.sessionId!)) }]
                      : []),
                  ]}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
      <ReadState {...read} onRetry={read.reload} />
      {selection.id ? <ArtifactSheet tenantId={tenantId} selection={selection} onClose={close} /> : null}
    </div>
  );
}
