import { useCallback, useEffect, useMemo, useState } from "react";
import { FileText } from "lucide-react";
import { createTenantClient } from "@/proxy-client";
import { formatBytes } from "@/attachments";
import { IMAGE_PREVIEW_BYTES, previewBytes, previewKind } from "@/resources/artifacts";
import { useRead } from "@/resources/reads";

/**
 * A file a message carried: its name and type from the artifact, an image's thumbnail
 * (its bytes, read like the artifact preview reads them). Click opens the artifact.
 */
export function AttachmentPreview({
  tenantId,
  artifactId,
  version,
  name,
  onOpen,
}: Readonly<{
  tenantId: string;
  artifactId: string;
  version: number;
  /** The name the event carries, until the artifact is read. */
  name: string;
  onOpen: () => void;
}>) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const artifact = await sdk.artifacts.get(artifactId, { signal });
      const pinned = artifact.versions?.find((v) => v.version === version);
      const contentType = pinned?.contentType ?? artifact.contentType;
      const size = pinned?.size;
      let image: Uint8Array<ArrayBuffer> | undefined;
      if (
        previewKind(contentType) === "image" &&
        size !== undefined &&
        size > 0 &&
        size <= IMAGE_PREVIEW_BYTES
      ) {
        const response = await sdk.artifacts.download(artifactId, {
          version,
          range: { start: 0, end: IMAGE_PREVIEW_BYTES },
          signal,
        });
        const read = await previewBytes(response, IMAGE_PREVIEW_BYTES, signal);
        if (!read.truncated) image = read.bytes;
      }
      return { name: artifact.name, contentType, size, image };
    },
    [sdk, artifactId, version],
  );
  const read = useRead(load);
  const [thumbnail, setThumbnail] = useState("");
  useEffect(() => {
    const data = read.data;
    if (!data?.image) return;
    const url = URL.createObjectURL(new Blob([data.image], { type: data.contentType }));
    setThumbnail(url);
    return () => {
      URL.revokeObjectURL(url);
      setThumbnail("");
    };
  }, [read.data]);
  const data = read.data;
  const type = data?.contentType.split(";")[0];
  return (
    <button
      type="button"
      data-slot="attachment-preview"
      onClick={onOpen}
      title={`Open ${data?.name ?? name} · v${version}`}
      className="flex max-w-64 items-center gap-2 rounded-lg border bg-background p-1.5 pr-3 text-left text-xs hover:bg-accent"
    >
      {thumbnail ? (
        <img
          src={thumbnail}
          alt={data?.name ?? name}
          className="size-10 shrink-0 rounded object-cover"
        />
      ) : (
        <span className="flex size-10 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
          <FileText className="size-4" aria-hidden />
        </span>
      )}
      <span className="min-w-0">
        <span className="block truncate font-medium">{data?.name ?? name}</span>
        <span className="block truncate text-muted-foreground">
          {read.error
            ? `v${version}`
            : [type, data?.size === undefined ? undefined : formatBytes(data.size)]
                .filter(Boolean)
                .join(" · ") || "…"}
        </span>
      </span>
    </button>
  );
}
