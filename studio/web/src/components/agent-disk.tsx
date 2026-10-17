import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AgentView } from "@nylorun/agents";
import { createTenantClient } from "@/proxy-client";
import { messageOf, useRead } from "@/resources/reads";
import { agentPath } from "@/agent-path";
import { fullTime, shortTime } from "@/time-format";
import { ReadState } from "@/components/resource-layout";
import { date, otherSessionsNote } from "@/components/agents";
import { ForkSheet } from "@/components/agent-fork";
import { useArtifactSelection } from "@/components/artifacts";
import { ArtifactSheet } from "@/components/agent-artifacts";
import {
  ActionMenu,
  EmptyRow,
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

const bytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 ** 2
      ? `${(n / 1024).toFixed(1)} KiB`
      : n < 1024 ** 3
        ? `${(n / 1024 ** 2).toFixed(1)} MiB`
        : `${(n / 1024 ** 3).toFixed(2)} GiB`;

/**
 * An Agent's disk versions (R2d step 3, Host feature `environment-disk-versions`): keep one
 * between turns (the toolbar's ⋯), and from each row's ⋯ browse its files, put it back, fork a
 * new Agent from it or delete it. The versions are versions of one folder artifact the Agent
 * owns, read through `/v1/artifacts`; a row opens it in the artifact inspector on the right.
 */
export function AgentDisk({
  tenantId,
  agent,
  latest,
  onChanged,
}: {
  tenantId: string;
  agent: AgentView;
  /** The latest version of the Agent's manifest, when known: a fork may move to it. */
  latest?: number;
  onChanged: () => void;
}) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const navigate = useNavigate();
  const id = agent.id;
  const selection = useArtifactSelection("disk");
  const load = useCallback((signal: AbortSignal) => sdk.agents.versions(id, { signal }), [sdk, id]);
  const read = useRead(load);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [forking, setForking] = useState<number>();
  const operation = agent.disk?.operation ?? undefined;
  const others = otherSessionsNote(agent);

  async function run(work: () => Promise<string | undefined>) {
    setActing(true);
    setError("");
    setNotice("");
    try {
      const message = await work();
      if (message === undefined) return;
      setNotice(message);
      read.reload();
      onChanged();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setActing(false);
    }
  }
  const snapshot = () =>
    run(async () => {
      const kept = await sdk.agents.snapshot(id);
      return kept.unchanged
        ? `The disk had not changed: version ${kept.version} is the latest.`
        : `Kept version ${kept.version}: ${kept.files.toLocaleString()} entries, ${bytes(kept.bytes)} (${bytes(kept.storedBytes)} stored) in ${kept.durationMs} ms.`;
    });
  const restore = (version: number) =>
    run(async () => {
      if (
        !window.confirm(
          `Restore version ${version} of ${id}'s disk? ${
            agent.kind === "pod"
              ? "The pod gets a new volume seeded with it; the next turn waits for it."
              : "The workspace is replaced with it."
          } What the disk holds now is lost unless a version keeps it.${others}`,
        )
      )
        return undefined;
      const restored = await sdk.agents.restore(id, version);
      return restored.status === "done"
        ? `Restored version ${restored.restored}.`
        : `Restoring version ${restored.restored}: the next turn waits until the new volume is seeded.`;
    });
  const remove = (version: number) =>
    run(async () => {
      if (!window.confirm(`Delete version ${version} of ${id}'s disk? This cannot be undone.`)) return undefined;
      await sdk.agents.deleteVersion(id, version);
      if (selection.id && selection.version === version) selection.update({ selected: null, version: null, file: null });
      return `Deleted version ${version}.`;
    });
  const versions = read.data;
  const browse = (version: number) =>
    versions?.artifactId
      ? selection.update({ selected: versions.artifactId, version: String(version), tab: "preview", file: null })
      : undefined;
  const actions = (version: number): MenuAction[] => [
    ...(versions?.artifactId ? [{ label: "Browse", onSelect: () => browse(version) }] : []),
    { label: "Restore…", onSelect: () => void restore(version), disabled: acting || operation !== undefined },
    { label: "Fork into a new Agent…", onSelect: () => setForking(version), disabled: acting },
    { label: "Delete…", onSelect: () => void remove(version), destructive: true, separated: true, disabled: acting },
  ];
  const count = versions?.versions.length ?? 0;
  return (
    <div>
      {operation ? (
        <p role="status" className="border-b px-4 py-2 text-sm">
          {operation.kind === "snapshot"
            ? "Keeping a version of the disk"
            : operation.kind === "restore"
              ? `Restoring version ${operation.version ?? ""}`
              : `Seeding a new volume${operation.version ? ` with version ${operation.version}` : ""}`}{" "}
          since {date(operation.startedAt)}. Turns wait for it.
        </p>
      ) : null}
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
        <span className="text-sm text-muted-foreground">
          What its disk held between turns. Put one back to undo a session's work.
        </span>
        <ToolbarCount>{countText(count, count, "version", "versions")}</ToolbarCount>
        <ActionMenu
          label="Disk actions"
          bordered
          actions={[{ label: "Snapshot now", onSelect: () => void snapshot(), disabled: acting || operation !== undefined }]}
        />
      </TableToolbar>
      <TableFrame minWidth={520}>
        <thead>
          <tr>
            <th className={headClass}>Version</th>
            <th className={`${headClass} w-[30%]`}>Kept</th>
            <th className={`${headClass} w-[20%]`}>Size</th>
            <th className={`${headClass} w-12`}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {versions && count === 0 ? (
            <EmptyRow columns={4}>No disk versions yet. Snapshot the disk to keep one.</EmptyRow>
          ) : null}
          {versions?.versions.map((v) => (
            <tr
              key={v.version}
              className={`${rowClass} ${versions.artifactId ? "cursor-pointer" : ""}`}
              data-state={selection.id && selection.version === v.version ? "selected" : undefined}
              onClick={() => browse(v.version)}
            >
              <td className={cellClass}>
                v{v.version}
                {v.version === versions.latest ? <span className="ml-1 text-xs text-muted-foreground"> latest</span> : null}
              </td>
              <td className={`${cellClass} text-muted-foreground`}>
                <time dateTime={v.createdAt} title={fullTime(v.createdAt)}>
                  {shortTime(v.createdAt)}
                </time>
              </td>
              <td className={`${cellClass} text-muted-foreground`}>{bytes(v.bytes)}</td>
              <td className={menuCellClass}>
                <ActionMenu label={`Actions for version ${v.version}`} actions={actions(v.version)} />
              </td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
      <ReadState {...read} onRetry={read.reload} />
      {selection.id ? (
        <ArtifactSheet
          tenantId={tenantId}
          selection={selection}
          onClose={() => selection.update({ selected: null, version: null, tab: null, file: null })}
        />
      ) : null}
      {forking !== undefined ? (
        <ForkSheet
          tenantId={tenantId}
          source={agent}
          disk={forking}
          {...(latest === undefined ? {} : { latest })}
          onClose={() => setForking(undefined)}
          onForked={(created) => {
            setForking(undefined);
            navigate(agentPath(created.id));
          }}
        />
      ) : null}
    </div>
  );
}
