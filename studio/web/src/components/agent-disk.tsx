import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AgentView } from "@nylorun/agents";
import { createTenantClient } from "@/proxy-client";
import { messageOf, useRead } from "@/resources/reads";
import { agentPath } from "@/agent-path";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ReadState } from "@/components/resource-layout";
import { date, otherSessionsNote } from "@/components/agents";
import { ForkSheet } from "@/components/agent-fork";
import {
  ArtifactInspector,
  useArtifactSelection,
} from "@/components/artifacts";

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
 * between turns, put one back, fork a new Agent from one, delete one, and browse a version's
 * files and changes. The versions are versions of one folder artifact the Agent owns, read
 * through `/v1/artifacts`.
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
  const load = useCallback(
    (signal: AbortSignal) => sdk.agents.versions(id, { signal }),
    [sdk, id],
  );
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
      if (!window.confirm(`Delete version ${version} of ${id}'s disk? This cannot be undone.`))
        return undefined;
      await sdk.agents.deleteVersion(id, version);
      if (selection.id && selection.version === version)
        selection.update({ selected: null, version: null, file: null });
      return `Deleted version ${version}.`;
    });
  const browse = (artifactId: string, version: number) =>
    selection.update({
      selected: artifactId,
      version: String(version),
      tab: "preview",
      file: null,
    });

  const versions = read.data;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          A disk version keeps what the Agent's disk holds, between turns. Put one back
          to undo a session's work, or fork a new Agent from one, with the secrets its
          manifest version declares.
        </p>
        <div className="flex gap-2">
          <Button variant="outline" disabled={read.pending} onClick={read.reload}>
            Refresh versions
          </Button>
          <Button disabled={acting || operation !== undefined} onClick={() => void snapshot()}>
            Snapshot disk
          </Button>
        </div>
      </div>
      {operation ? (
        <p role="status" className="rounded-md border p-3 text-sm">
          {operation.kind === "snapshot"
            ? "Keeping a version of the disk"
            : operation.kind === "restore"
              ? `Restoring version ${operation.version ?? ""}`
              : `Seeding a new volume${operation.version ? ` with version ${operation.version}` : ""}`}{" "}
          since {date(operation.startedAt)}. Turns wait for it.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="break-words text-sm text-red-600">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Version</TableHead>
            <TableHead>Kept</TableHead>
            <TableHead>Size</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {versions?.versions.map((v) => (
            <TableRow
              key={v.version}
              data-state={
                selection.id && selection.version === v.version ? "selected" : undefined
              }
            >
              <TableCell>
                v{v.version}
                {v.version === versions.latest ? (
                  <Badge variant="outline" className="ml-2">
                    latest
                  </Badge>
                ) : null}
              </TableCell>
              <TableCell>{date(v.createdAt)}</TableCell>
              <TableCell>{bytes(v.bytes)}</TableCell>
              <TableCell className="space-x-1 text-right">
                {versions.artifactId ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Browse version ${v.version}`}
                    onClick={() => browse(versions.artifactId!, v.version)}
                  >
                    Browse
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Restore version ${v.version}`}
                  disabled={acting || operation !== undefined}
                  onClick={() => void restore(v.version)}
                >
                  Restore
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Fork from version ${v.version}`}
                  disabled={acting}
                  onClick={() => setForking(v.version)}
                >
                  Fork
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Delete version ${v.version}`}
                  disabled={acting}
                  onClick={() => void remove(v.version)}
                >
                  Delete
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ReadState
        {...read}
        onRetry={read.reload}
        empty={
          versions && versions.versions.length === 0
            ? "No disk versions yet. Snapshot the disk to keep one."
            : undefined
        }
      />
      {selection.id ? (
        <div className="rounded-lg border">
          <ArtifactInspector
            key={selection.id}
            tenantId={tenantId}
            selection={selection}
            onClose={() =>
              selection.update({ selected: null, version: null, tab: null, file: null })
            }
          />
        </div>
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
