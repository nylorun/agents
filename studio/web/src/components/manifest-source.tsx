import { useCallback, useMemo, useState } from "react";
import type { AgentManifestSourceSummary } from "@nylorun/agents";
import { FileText, Folder } from "lucide-react";
import { cn } from "@/lib/utils";
import { createTenantClient, tenantRuntimeFetch } from "@/proxy-client";
import { useRead } from "@/resources/reads";
import { previewBytes, TEXT_PREVIEW_BYTES } from "@/resources/artifacts";
import { formatBytes } from "@/attachments";
import { diffSummary, fileText, sourceTree, type SourceRow } from "@/agent-folder";
import { ReadState } from "@/components/resource-layout";
import { SidePanel } from "@/components/data-table";

/**
 * A manifest version's Source view (track T7): the agent folder it was saved from, read only, as
 * a tree (`GET .../versions/{v}/source`), each file marked when it was added or changed since the
 * version before (`GET .../source/diff`). A file opens beside it (`.../source/files/{path}`): its
 * text, or its size for one that is not text. A version saved as JSON has no source.
 */
export function ManifestSource({
  tenantId,
  name,
  version,
  summary,
}: Readonly<{ tenantId: string; name: string; version: number; summary?: AgentManifestSourceSummary }>) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const load = useCallback(
    async (signal: AbortSignal) => {
      if (!summary) return undefined;
      const source = await sdk.agentManifests.source(name, version, { signal });
      // The version before may have been saved as JSON: then there is nothing to compare.
      const diff =
        version > 1
          ? await sdk.agentManifests.sourceDiff(name, version - 1, version, { signal }).catch(() => undefined)
          : undefined;
      return { source, diff };
    },
    [sdk, name, version, summary],
  );
  const read = useRead(load);
  const [open, setOpen] = useState<SourceRow>();
  if (!summary)
    return (
      <p className="px-5 py-4 text-sm text-muted-foreground">
        v{version} was saved as JSON, so it has no source folder. A version saved from a folder (Upload folder, or{" "}
        <span className="font-mono text-xs">nylorun apply</span> on a folder) keeps its files here.
      </p>
    );
  const data = read.data;
  const rows = data ? sourceTree(data.source.entries, data.diff) : [];
  return (
    <div>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-5 py-2.5 text-xs text-muted-foreground">
        <span className="font-mono">{summary.compiler}</span>
        <span aria-hidden>·</span>
        <span>{summary.files === 1 ? "1 file" : `${summary.files} files`}</span>
        <span aria-hidden>·</span>
        <span>{formatBytes(summary.bytes)}</span>
        {data?.diff ? (
          <>
            <span aria-hidden>·</span>
            <span>{diffSummary(data.diff)}</span>
          </>
        ) : null}
      </p>
      <ReadState {...read} pending={read.pending && !data} onRetry={read.reload} />
      {data ? (
        <ul aria-label={`Files of ${name} v${version}`}>
          {rows.map((row) => (
            <li key={row.path}>
              {row.kind === "dir" ? (
                <div
                  className="flex h-9 items-center gap-2 border-b border-border/60 pr-5 text-[13px] text-muted-foreground"
                  style={{ paddingLeft: 20 + row.depth * 16 }}
                >
                  <Folder className="size-3.5 shrink-0" aria-hidden />
                  <span className="truncate font-mono">{row.name}/</span>
                </div>
              ) : (
                <button
                  type="button"
                  aria-label={`${row.path}${row.change ? `, ${row.change}` : ""}, ${formatBytes(row.size ?? 0)}`}
                  onClick={() => setOpen(row)}
                  className={cn(
                    "flex h-9 w-full items-center gap-2 border-b border-border/60 pr-5 text-left text-[13px] hover:bg-muted/50",
                    open?.path === row.path && "bg-muted",
                  )}
                  style={{ paddingLeft: 20 + row.depth * 16 }}
                >
                  <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 truncate font-mono" title={row.path}>
                    {row.name}
                  </span>
                  {row.change ? (
                    <span className="shrink-0 text-xs text-muted-foreground" title={`${row.change === "added" ? "Added" : "Changed"} since v${version - 1}`}>
                      {row.change}
                    </span>
                  ) : null}
                  <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                    {formatBytes(row.size ?? 0)}
                  </span>
                </button>
              )}
            </li>
          ))}
          {data.diff?.removed.map((entry) => (
            <li
              key={`removed:${entry.path}`}
              className="flex h-9 items-center gap-2 border-b border-border/60 px-5 text-[13px] text-muted-foreground"
              title={`Removed since v${version - 1}`}
            >
              <FileText className="size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate font-mono line-through">{entry.path}</span>
              <span className="shrink-0 text-xs">removed</span>
            </li>
          ))}
        </ul>
      ) : null}
      {open ? (
        <SidePanel
          title={open.path}
          description={`${name} v${version} · ${formatBytes(open.size ?? 0)}`}
          actions={[{ label: "Copy path", onSelect: () => void navigator.clipboard.writeText(open.path) }]}
          onClose={() => setOpen(undefined)}
          wide
        >
          <SourceFile tenantId={tenantId} name={name} version={version} path={open.path} size={open.size ?? 0} />
        </SidePanel>
      ) : null}
    </div>
  );
}

/** One file of a version's source: its text, up to the preview limit, or its size. */
function SourceFile({
  tenantId,
  name,
  version,
  path,
  size,
}: Readonly<{ tenantId: string; name: string; version: number; path: string; size: number }>) {
  const fetchRuntime = useMemo(() => tenantRuntimeFetch(tenantId), [tenantId]);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const response = await fetchRuntime(
        `/v1/agent-manifests/${encodeURIComponent(name)}/versions/${version}/source/files/${encodeURIComponent(path)}`,
        { signal },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => undefined)) as { message?: unknown } | undefined;
        throw new Error(typeof body?.message === "string" ? body.message : `The file could not be read (${response.status}).`);
      }
      const read = await previewBytes(response, TEXT_PREVIEW_BYTES, signal);
      return { text: fileText(read.bytes, read.truncated), truncated: read.truncated };
    },
    [fetchRuntime, name, version, path],
  );
  const read = useRead(load);
  return (
    <div className="space-y-3">
      <ReadState {...read} onRetry={read.reload} />
      {read.data ? (
        read.data.text === undefined ? (
          <p className="text-sm text-muted-foreground">
            Not a text file ({formatBytes(size)}): it is kept with the source as it was saved.
          </p>
        ) : (
          <>
            <pre className="overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-5 whitespace-pre-wrap break-all">
              {read.data.text}
            </pre>
            {read.data.truncated ? (
              <p className="text-xs text-muted-foreground">Shown up to 256 KiB of {formatBytes(size)}.</p>
            ) : null}
          </>
        )
      ) : null}
    </div>
  );
}
