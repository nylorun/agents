import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { ArtifactView, FolderEntry } from "@nylorun/agents";
import { createTenantClient, tenantRuntimePath } from "@/proxy-client";
import {
  IMAGE_PREVIEW_BYTES,
  TEXT_PREVIEW_BYTES,
  previewBytes,
  previewKind,
} from "@/resources/artifacts";
import { messageOf, useRead } from "@/resources/reads";
import {
  ResourceLayout,
  ResourceHeader,
  ReadState,
  Metadata,
} from "@/components/resource-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const date = (value: string) => new Date(value).toLocaleString();
const size = (bytes: number) => `${bytes.toLocaleString()} bytes`;

/** Global and session inspectors share the same UI, with independent URL state. */
function useSelection(session = false) {
  const [query, setQuery] = useSearchParams();
  const fields = session
    ? {
        selected: "artifact",
        version: "artifactVersion",
        tab: "artifactTab",
        file: "artifactFile",
      }
    : { selected: "selected", version: "version", tab: "tab", file: "file" };
  const id = query.get(fields.selected) ?? "";
  const rawVersion = query.get(fields.version);
  const version = rawVersion === null ? undefined : Number(rawVersion);
  const validVersion =
    rawVersion === null ||
    (/^[1-9]\d*$/.test(rawVersion) && Number.isSafeInteger(version));
  const tab = ["preview", "versions", "changes"].includes(
    query.get(fields.tab) ?? "",
  )
    ? query.get(fields.tab)!
    : "preview";
  function update(
    values: Partial<Record<keyof typeof fields, string | null>>,
    replace = false,
  ) {
    const next = new URLSearchParams(query);
    for (const [key, value] of Object.entries(values)) {
      const field = fields[key as keyof typeof fields];
      if (value === null) next.delete(field);
      else if (value !== undefined) next.set(field, value);
    }
    if (session && values.selected) next.set("inspector", "artifacts");
    setQuery(next, { replace });
  }
  return {
    id,
    version,
    validVersion,
    tab,
    file: query.get(fields.file) ?? "",
    update,
  };
}

export function Artifacts({ tenantId }: { tenantId: string }) {
  const [query, setQuery] = useSearchParams();
  const sessionId = query.get("sessionId") ?? "";
  const [sessionInput, setSessionInput] = useState(sessionId);
  const [artifactInput, setArtifactInput] = useState("");
  const selection = useSelection();
  useEffect(() => setSessionInput(sessionId), [sessionId]);
  const close = () => selection.update({ selected: null });
  function filter(event: FormEvent) {
    event.preventDefault();
    const next = new URLSearchParams(query);
    if (sessionInput.trim()) next.set("sessionId", sessionInput.trim());
    else next.delete("sessionId");
    next.delete("selected");
    next.delete("version");
    next.delete("file");
    setQuery(next);
  }
  return (
    <ResourceLayout
      title="Artifact details"
      onClose={close}
      inspector={
        selection.id ? (
          <ArtifactInspector
            key={selection.id}
            tenantId={tenantId}
            selection={selection}
            onClose={close}
          />
        ) : undefined
      }
    >
      <div className="space-y-4 p-4">
        <h1 className="text-xl font-semibold">Artifacts</h1>
        <form onSubmit={filter} className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 text-sm">
            Session ID
            <Input
              value={sessionInput}
              onChange={(e) => setSessionInput(e.target.value)}
              placeholder="Session ID"
            />
          </label>
          <Button variant="outline" type="submit">
            View session artifacts
          </Button>
        </form>
        {sessionId ? (
          <ArtifactList
            tenantId={tenantId}
            sessionId={sessionId}
            selection={selection}
          />
        ) : (
          <div className="space-y-3 rounded border p-4 text-sm">
            <h2 className="font-medium">
              Tenant-wide artifact browsing needs a paged API
            </h2>
            <p className="text-muted-foreground">
              The current Runtime lists all tenant artifacts in one response.
              Select a session above or open an artifact by ID. A public
              artifact pagination API is required for the tenant-wide table.
            </p>
            <form
              className="flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (artifactInput.trim())
                  selection.update({
                    selected: artifactInput.trim(),
                    version: null,
                    tab: "preview",
                    file: null,
                  });
              }}
            >
              <Input
                aria-label="Artifact ID"
                className="min-w-0 flex-1"
                value={artifactInput}
                onChange={(e) => setArtifactInput(e.target.value)}
                placeholder="Artifact ID"
              />
              <Button variant="outline" disabled={!artifactInput.trim()}>
                Open artifact
              </Button>
            </form>
          </div>
        )}
      </div>
    </ResourceLayout>
  );
}

export function SessionArtifacts({
  tenantId,
  sessionId,
  revision,
}: {
  tenantId: string;
  sessionId: string;
  revision: string;
}) {
  const selection = useSelection(true);
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <ArtifactList
        tenantId={tenantId}
        sessionId={sessionId}
        selection={selection}
        revision={revision}
      />
      {selection.id ? (
        <div className="mt-4 border-t">
          <ArtifactInspector
            key={selection.id}
            tenantId={tenantId}
            selection={selection}
            onClose={() => selection.update({ selected: null })}
          />
        </div>
      ) : null}
    </div>
  );
}

function ArtifactList({
  tenantId,
  sessionId,
  selection,
  revision = "",
}: {
  tenantId: string;
  sessionId: string;
  selection: ReturnType<typeof useSelection>;
  revision?: string;
}) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const load = useCallback(
    (signal: AbortSignal) => sdk.artifacts.list({ sessionId, signal }),
    [sdk, sessionId, revision],
  );
  const read = useRead(load);
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium break-all">
          Artifacts · {sessionId}
        </h2>
        <Button
          size="sm"
          variant="outline"
          disabled={read.pending}
          onClick={read.reload}
        >
          Refresh artifacts
        </Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead>Latest version</TableHead>
            <TableHead>Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {read.data?.map((a) => (
            <TableRow
              key={a.artifactId}
              data-state={
                selection.id === a.artifactId ? "selected" : undefined
              }
              onClick={() =>
                selection.update({
                  selected: a.artifactId,
                  version: String(a.latestVersion),
                  tab: "preview",
                  file: null,
                })
              }
            >
              <TableCell className="whitespace-normal break-all">
                <button
                  className="text-left underline-offset-4 hover:underline"
                  onClick={(e) => {
                    e.stopPropagation();
                    selection.update({
                      selected: a.artifactId,
                      version: String(a.latestVersion),
                      tab: "preview",
                      file: null,
                    });
                  }}
                >
                  {a.name}
                </button>
              </TableCell>
              <TableCell>{a.kind}</TableCell>
              <TableCell>v{a.latestVersion}</TableCell>
              <TableCell>{date(a.updatedAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ReadState
        {...read}
        onRetry={read.reload}
        empty={
          read.data?.length
            ? undefined
            : "No exported artifacts yet. Artifacts appear when a client uploads a file or a turn exports outputs."
        }
      />
    </section>
  );
}

function ArtifactInspector({
  tenantId,
  selection,
  onClose,
}: {
  tenantId: string;
  selection: ReturnType<typeof useSelection>;
  onClose: () => void;
}) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const { id, version, validVersion, tab, file, update } = selection;
  const load = useCallback(
    (signal: AbortSignal) => sdk.artifacts.get(id, { signal }),
    [sdk, id],
  );
  const read = useRead(load);
  const artifact = read.data;
  useEffect(() => {
    if (artifact && version === undefined)
      update({ version: String(artifact.latestVersion) }, true);
  }, [artifact, version]);
  const selectedVersion = artifact?.versions?.find(
    (v) => v.version === version,
  );
  const activeTab =
    artifact?.kind === "file" && tab === "changes" ? "preview" : tab;
  return (
    <section className="flex h-full min-h-0 flex-col">
      <ResourceHeader title={artifact?.name ?? id} onClose={onClose}>
        <Button
          size="sm"
          variant="outline"
          onClick={read.reload}
          disabled={read.pending}
        >
          Refresh metadata
        </Button>
      </ResourceHeader>
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
        <ReadState {...read} onRetry={read.reload} />
        {artifact ? (
          <>
            <div className="flex flex-wrap items-end justify-between gap-2">
              <label className="text-sm">
                Version
                <select
                  aria-label="Artifact version"
                  className="ml-2 rounded border bg-background p-1.5"
                  value={version ?? ""}
                  onChange={(e) =>
                    update({ version: e.target.value, file: null })
                  }
                >
                  {!selectedVersion ? (
                    <option value={version ?? ""}>
                      {validVersion ? "Select version" : "Invalid version"}
                    </option>
                  ) : null}
                  {artifact.versions
                    ?.slice()
                    .reverse()
                    .map((v) => (
                      <option key={v.version} value={v.version}>
                        v{v.version}
                        {v.version === artifact.latestVersion
                          ? " · latest"
                          : ""}
                      </option>
                    ))}
                </select>
              </label>
              {selectedVersion ? (
                <ArtifactDownload
                  tenantId={tenantId}
                  id={id}
                  version={selectedVersion.version}
                  name={
                    artifact.kind === "folder"
                      ? `${artifact.name}.zip`
                      : artifact.name
                  }
                  label={
                    artifact.kind === "folder" ? "Download ZIP" : "Download"
                  }
                />
              ) : null}
            </div>
            <Metadata
              entries={[
                ["Artifact ID", id],
                ["Kind", artifact.kind],
                [
                  "Session",
                  artifact.sessionId ? (
                    <Link
                      className="underline"
                      to={`/sessions/${encodeURIComponent(artifact.sessionId)}`}
                    >
                      {artifact.sessionId}
                    </Link>
                  ) : (
                    "Tenant"
                  ),
                ],
                ["Created", date(artifact.createdAt)],
                ["Updated", date(artifact.updatedAt)],
              ]}
            />
            {selectedVersion ? (
              <Metadata
                entries={[
                  ["Version", `v${selectedVersion.version} · pinned`],
                  ["Size", size(selectedVersion.size)],
                  ["MIME type", selectedVersion.contentType],
                  ["Source", selectedVersion.source],
                  ["Version created", date(selectedVersion.createdAt)],
                  ["SHA-256", selectedVersion.sha256],
                ]}
              />
            ) : version !== undefined ? (
              <p role="alert" className="text-sm">
                {validVersion
                  ? "This artifact has no such version. Select one of its recorded versions."
                  : "Invalid artifact version."}
              </p>
            ) : null}
            {artifact.labels && Object.keys(artifact.labels).length ? (
              <details className="text-sm">
                <summary>Labels</summary>
                <pre className="whitespace-pre-wrap break-all text-xs">
                  {JSON.stringify(artifact.labels, null, 2)}
                </pre>
              </details>
            ) : null}
            <Tabs
              value={activeTab}
              onValueChange={(value) => update({ tab: value })}
            >
              <TabsList aria-label="Artifact tabs">
                <TabsTrigger value="preview">Preview</TabsTrigger>
                <TabsTrigger value="versions">Versions</TabsTrigger>
                {artifact.kind === "folder" ? (
                  <TabsTrigger value="changes">Changes</TabsTrigger>
                ) : null}
              </TabsList>
              <TabsContent value="preview">
                {selectedVersion ? (
                  artifact.kind === "folder" ? (
                    <FolderPreview
                      key={selectedVersion.version}
                      tenantId={tenantId}
                      artifact={artifact}
                      version={selectedVersion.version}
                      file={file}
                      onFile={(path) => update({ file: path })}
                    />
                  ) : (
                    <FilePreview
                      key={selectedVersion.version}
                      tenantId={tenantId}
                      id={id}
                      version={selectedVersion.version}
                      contentType={selectedVersion.contentType}
                      bytes={selectedVersion.size}
                    />
                  )
                ) : null}
              </TabsContent>
              <TabsContent value="versions" className="space-y-2">
                {artifact.versions
                  ?.slice()
                  .reverse()
                  .map((v) => (
                    <div
                      key={v.version}
                      className="space-y-1 border-b py-2 text-sm"
                    >
                      <button
                        className="underline"
                        onClick={() =>
                          update({
                            version: String(v.version),
                            tab: "preview",
                            file: null,
                          })
                        }
                      >
                        Version {v.version}
                      </button>
                      <p className="text-muted-foreground">
                        {date(v.createdAt)} · {size(v.size)} · {v.source}
                      </p>
                    </div>
                  ))}
              </TabsContent>
              {artifact.kind === "folder" ? (
                <TabsContent value="changes">
                  {selectedVersion ? (
                    <FolderChanges
                      key={selectedVersion.version}
                      tenantId={tenantId}
                      id={id}
                      version={selectedVersion.version}
                    />
                  ) : null}
                </TabsContent>
              ) : null}
            </Tabs>
          </>
        ) : null}
      </div>
    </section>
  );
}

function ArtifactDownload({
  tenantId,
  id,
  version,
  file,
  name,
  label,
}: {
  tenantId: string;
  id: string;
  version: number;
  file?: string;
  name: string;
  label: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function download() {
    setPending(true);
    setError("");
    try {
      // A 60-second public capability, minted through authenticated Studio.
      // The proxy streams it directly to the browser's download manager.
      const link = await createTenantClient(tenantId).artifacts.link(id, {
        version,
        file,
        expiresIn: 60,
      });
      if (!/^\/v1\/artifact-links\/[^/]+$/.test(link.path))
        throw new Error("Runtime returned an invalid download path.");
      const anchor = document.createElement("a");
      anchor.href = tenantRuntimePath(tenantId) + link.path;
      anchor.download = name;
      anchor.referrerPolicy = "no-referrer";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <div>
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => void download()}
      >
        {pending ? "Preparing…" : label}
      </Button>
      {error ? (
        <p role="alert" className="mt-2 max-w-xs break-words text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function FilePreview({
  tenantId,
  id,
  version,
  contentType,
  bytes,
  file,
}: {
  tenantId: string;
  id: string;
  version: number;
  contentType: string;
  bytes: number;
  file?: string;
}) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const kind = previewKind(contentType);
  const limit = kind === "image" ? IMAGE_PREVIEW_BYTES : TEXT_PREVIEW_BYTES;
  const enabled = kind !== "download" && (kind !== "image" || bytes <= limit);
  const load = useCallback(
    async (signal: AbortSignal) => {
      if (!enabled) return undefined;
      if (bytes === 0) return { bytes: new Uint8Array(), truncated: false };
      const options = { version, range: { start: 0, end: limit }, signal };
      const response =
        file === undefined
          ? await sdk.artifacts.download(id, options)
          : await sdk.artifacts.file(id, file, options);
      return previewBytes(response, limit, signal);
    },
    [sdk, id, version, file, limit, enabled, bytes],
  );
  const read = useRead(load);
  const [imageUrl, setImageUrl] = useState("");
  const [imageError, setImageError] = useState(false);
  useEffect(() => {
    setImageError(false);
    if (kind !== "image" || !read.data || read.data.truncated) {
      setImageUrl("");
      return;
    }
    const url = URL.createObjectURL(
      new Blob([read.data.bytes], { type: contentType }),
    );
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [read.data, kind, contentType]);
  if (!enabled)
    return (
      <p className="py-4 text-sm text-muted-foreground">
        {kind === "image"
          ? "Image exceeds the 10 MiB preview limit."
          : "Preview is unavailable for this file type."}{" "}
        Use Download to open it locally.
      </p>
    );
  return (
    <div className="space-y-3 py-2">
      <ReadState {...read} onRetry={read.reload} />
      {read.data ? (
        kind === "text" ? (
          <>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">
              {new TextDecoder().decode(read.data.bytes)}
            </pre>
            {read.data.truncated ? (
              <p className="text-xs text-muted-foreground">
                Preview truncated at 256 KiB. Download for the complete file.
              </p>
            ) : null}
          </>
        ) : read.data.truncated ? (
          <p className="text-sm">
            Image exceeds the preview limit. Download for the complete file.
          </p>
        ) : imageUrl ? (
          imageError ? (
            <p role="alert" className="text-sm">
              The image could not be decoded.{" "}
              <Button size="sm" variant="outline" onClick={read.reload}>
                Retry preview
              </Button>
            </p>
          ) : (
            <img
              className="max-h-96 max-w-full object-contain"
              src={imageUrl}
              alt={file ?? "Artifact preview"}
              onError={() => setImageError(true)}
            />
          )
        ) : null
      ) : null}
    </div>
  );
}

function FolderPreview({
  tenantId,
  artifact,
  version,
  file,
  onFile,
}: {
  tenantId: string;
  artifact: ArtifactView;
  version: number;
  file: string;
  onFile: (path: string) => void;
}) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const load = useCallback(
    (signal: AbortSignal) =>
      sdk.artifacts.tree(artifact.artifactId, { version, signal }),
    [sdk, artifact.artifactId, version],
  );
  const read = useRead(load);
  const entry = read.data?.entries.find((e) => e.path === file);
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Committed exported folder · v{version}. This is not the live workspace.
      </p>
      <ReadState
        {...read}
        onRetry={read.reload}
        empty={
          read.data?.entries.length
            ? undefined
            : "This exported folder has no files."
        }
      />
      <div className="max-h-64 overflow-auto">
        {read.data?.entries.map((e) => (
          <button
            key={e.path}
            className={`block w-full border-b px-2 py-2 text-left text-sm ${file === e.path ? "bg-muted" : "hover:bg-muted/50"}`}
            onClick={() => onFile(e.path)}
          >
            <span className="break-all font-mono text-xs">{e.path}</span>
            <span className="ml-2 text-xs text-muted-foreground">
              {size(e.size)}
            </span>
          </button>
        ))}
      </div>
      {file && read.data && !entry ? (
        <p role="alert" className="text-sm">
          This file is absent from the selected folder version.
        </p>
      ) : null}
      {entry ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="break-all text-sm font-medium">{entry.path}</h3>
            <ArtifactDownload
              tenantId={tenantId}
              id={artifact.artifactId}
              version={version}
              file={entry.path}
              name={entry.path.split("/").pop()!}
              label="Download file"
            />
          </div>
          <FilePreview
            key={`${version}:${entry.path}`}
            tenantId={tenantId}
            id={artifact.artifactId}
            version={version}
            file={entry.path}
            contentType={entry.contentType}
            bytes={entry.size}
          />
        </>
      ) : null}
    </div>
  );
}

function FolderChanges({
  tenantId,
  id,
  version,
}: {
  tenantId: string;
  id: string;
  version: number;
}) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const load = useCallback(
    (signal: AbortSignal) =>
      version === 1
        ? Promise.resolve(undefined)
        : sdk.artifacts.diff(id, { version, from: version - 1, signal }),
    [sdk, id, version],
  );
  const read = useRead(load);
  if (version === 1)
    return (
      <p className="py-3 text-sm text-muted-foreground">
        Version 1 has no previous version.
      </p>
    );
  const groups: [string, FolderEntry[]][] = read.data
    ? [
        ["Added", read.data.added],
        ["Removed", read.data.removed],
        ["Changed", read.data.changed.map((e) => e.to)],
      ]
    : [];
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">
        v{version - 1} → v{version}
      </h3>
      <ReadState
        {...read}
        onRetry={read.reload}
        empty={
          read.data && groups.every(([, entries]) => entries.length === 0)
            ? "No file changes."
            : undefined
        }
      />
      {groups.map(([label, entries]) =>
        entries.length ? (
          <section key={label}>
            <h4 className="text-sm font-medium">{label}</h4>
            {entries.map((e) => (
              <p key={e.path} className="break-all py-1 font-mono text-xs">
                {e.path}
              </p>
            ))}
          </section>
        ) : null,
      )}
    </div>
  );
}
