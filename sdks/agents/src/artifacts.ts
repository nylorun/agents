/**
 * Artifacts (protocol 6): `client.artifacts`. A file is uploaded in one streamed request and
 * kept as an artifact with numbered versions; a session's artifacts appear in its history as
 * `artifact.*` events. Download through the Runtime (with Range), or mint a capability link: a
 * short-lived URL that needs no credential, for `<img>` tags and sharing. A message names an
 * artifact in a file part (`session.inputParts`), and the model reads it.
 *
 * Folders (F8.2): at the end of each turn the Runtime exports `/workspace/outputs` of the
 * session's sandbox as a version of its `outputs` folder. Read one as a tree, one file by path,
 * a diff between versions or a zip.
 *
 * Acting for a person (`client.as`, or a trusted issuer's token), only the artifacts of their own sessions.
 */
import {
  ArtifactPageSchema,
  type ArtifactKind,
  type ArtifactPage,
  type ArtifactDiff,
  type ArtifactLink,
  type ArtifactTree,
  type ArtifactView,
  type DeleteArtifactResponse,
  type UploadArtifactResponse,
} from "@nylorun/core/contracts";
import { segment, type Transport } from "./http.js";

/** What an upload sends: bytes, a `Blob` or `File`, text, or a stream of bytes. */
export type ArtifactBody = Uint8Array | ArrayBuffer | Blob | string | ReadableStream<Uint8Array>;

export interface UploadArtifactOptions {
  /** The file's name, e.g. `brief.pdf`. */
  readonly name: string;
  /** The session it belongs to; required when acting for a person. */
  readonly sessionId?: string;
  /** The media type. Default: a `Blob`'s type, else what the name implies. */
  readonly contentType?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface ArtifactPageOptions {
  /** Only this session's artifacts; excludes Tenant-owned artifacts. */
  readonly sessionId?: string;
  readonly kind?: ArtifactKind;
  /** Every label must match exactly. */
  readonly labels?: Readonly<Record<string, string>>;
  /** Default 50, from 1 to 200. */
  readonly limit?: number;
  readonly cursor?: string;
  readonly signal?: AbortSignal;
}

/** A capability link, with the absolute URL to open on this Runtime. */
export type ArtifactLinkWithUrl = ArtifactLink & { readonly url: string };

function contentTypeOf(body: ArtifactBody, declared: string | undefined): string {
  if (declared) return declared;
  if (typeof Blob !== "undefined" && body instanceof Blob && body.type) return body.type;
  return typeof body === "string" ? "text/plain; charset=utf-8" : "application/octet-stream";
}

export class ArtifactsClient {
  constructor(private readonly transport: Transport) {}

  private async send<T>(
    path: string,
    body: ArtifactBody,
    contentType: string,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    const response = await this.transport.request(path, {
      method: "POST",
      headers: { "content-type": contentType },
      body: body as BodyInit,
      // A stream is sent as it is read (Node's fetch needs this said).
      ...(typeof ReadableStream !== "undefined" && body instanceof ReadableStream
        ? ({ duplex: "half" } as object)
        : {}),
      ...(signal ? { signal } : {}),
    });
    return (await response.json()) as T;
  }

  /**
   * Uploads a file as a new artifact (`POST /v1/artifacts`), in one streamed request. A file past
   * the Tenant's per-file limit, or past its total, is refused with `413 limit_exceeded`.
   */
  upload(body: ArtifactBody, options: UploadArtifactOptions): Promise<UploadArtifactResponse> {
    const query = new URLSearchParams({ name: options.name });
    if (options.sessionId !== undefined) query.set("sessionId", options.sessionId);
    for (const [key, value] of Object.entries(options.labels ?? {}))
      query.append("label", `${key}=${value}`);
    return this.send(
      `/v1/artifacts?${query}`,
      body,
      contentTypeOf(body, options.contentType),
      options.signal,
    );
  }

  /** Uploads the artifact's next version. */
  uploadVersion(
    artifactId: string,
    body: ArtifactBody,
    options: { contentType?: string; signal?: AbortSignal } = {},
  ): Promise<UploadArtifactResponse> {
    return this.send(
      `/v1/artifacts/${segment(artifactId)}/versions`,
      body,
      contentTypeOf(body, options.contentType),
      options.signal,
    );
  }

  /** The artifacts of one session, or of every session this client reaches; oldest first. */
  async list(options: { sessionId?: string; signal?: AbortSignal } = {}): Promise<ArtifactView[]> {
    const query = options.sessionId === undefined ? "" : `?sessionId=${segment(options.sessionId)}`;
    const reply = await this.transport.json<{ artifacts: ArtifactView[] }>(
      `/v1/artifacts${query}`,
      "GET",
      undefined,
      options.signal,
    );
    return reply.artifacts;
  }

  /** Newest first, with metadata only (Host feature `artifact-reads`). */
  async page(options: ArtifactPageOptions = {}): Promise<ArtifactPage> {
    await this.transport.requireFeature("artifact-reads", options.signal);
    const query = new URLSearchParams({ limit: String(options.limit ?? 50) });
    if (options.cursor !== undefined) query.set("cursor", options.cursor);
    if (options.sessionId !== undefined) query.set("sessionId", options.sessionId);
    if (options.kind !== undefined) query.set("kind", options.kind);
    for (const [key, value] of Object.entries(options.labels ?? {}))
      query.append("label", `${key}=${value}`);
    return ArtifactPageSchema.parse(
      await this.transport.json(`/v1/artifacts?${query}`, "GET", undefined, options.signal),
    );
  }

  /** The artifact, with every version. */
  get(artifactId: string, options: { signal?: AbortSignal } = {}): Promise<ArtifactView> {
    return this.transport.json(`/v1/artifacts/${segment(artifactId)}`, "GET", undefined, options.signal);
  }

  /**
   * A version's bytes as the Runtime's response, to stream (`response.body`) or read. With
   * `range`, only those bytes (`206`, `Content-Range`). Default: the latest version.
   */
  download(
    artifactId: string,
    options: {
      version?: number;
      /** Bytes `start` to `end`, both inclusive; without `end`, to the end. */
      range?: { start: number; end?: number };
      signal?: AbortSignal;
    } = {},
  ): Promise<Response> {
    const range = options.range;
    return this.transport.request(
      `/v1/artifacts/${segment(artifactId)}/versions/${options.version ?? "latest"}/content`,
      {
        method: "GET",
        ...(range ? { headers: { range: `bytes=${range.start}-${range.end ?? ""}` } } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
  }

  /**
   * A capability link to one version (default: the latest): anyone holding the URL may download
   * it, with no credential, until it expires (default 5 minutes, at most 15) or the artifact is
   * deleted. A folder's link opens its zip, or with `file` that one file.
   */
  async link(
    artifactId: string,
    options: { version?: number; expiresIn?: number; file?: string; signal?: AbortSignal } = {},
  ): Promise<ArtifactLinkWithUrl> {
    const link = await this.transport.json<ArtifactLink>(
      `/v1/artifacts/${segment(artifactId)}/links`,
      "POST",
      {
        ...(options.version === undefined ? {} : { version: options.version }),
        ...(options.expiresIn === undefined ? {} : { expiresIn: options.expiresIn }),
        ...(options.file === undefined ? {} : { file: options.file }),
      },
      options.signal,
    );
    return { ...link, url: `${this.transport.url}${link.path}` };
  }

  /** A folder version's files (default: the latest), sorted by path. */
  tree(artifactId: string, options: { version?: number; signal?: AbortSignal } = {}): Promise<ArtifactTree> {
    return this.transport.json(
      `${this.versionPath(artifactId, options.version)}/tree`,
      "GET",
      undefined,
      options.signal,
    );
  }

  /**
   * One file of a folder version (default: the latest) by its path in the folder, as the
   * Runtime's response; with `range`, only those bytes (`206`).
   */
  file(
    artifactId: string,
    path: string,
    options: {
      version?: number;
      /** Bytes `start` to `end`, both inclusive; without `end`, to the end. */
      range?: { start: number; end?: number };
      signal?: AbortSignal;
    } = {},
  ): Promise<Response> {
    const range = options.range;
    return this.transport.request(
      `${this.versionPath(artifactId, options.version)}/files/${encodeURIComponent(path)}`,
      {
        method: "GET",
        ...(range ? { headers: { range: `bytes=${range.start}-${range.end ?? ""}` } } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
  }

  /**
   * What changed in a folder from version `from` (default: the one before) to `version`
   * (default: the latest): files added, removed and changed.
   */
  diff(
    artifactId: string,
    options: { version?: number; from?: number; signal?: AbortSignal } = {},
  ): Promise<ArtifactDiff> {
    const query = options.from === undefined ? "" : `?from=${options.from}`;
    return this.transport.json(
      `${this.versionPath(artifactId, options.version)}/diff${query}`,
      "GET",
      undefined,
      options.signal,
    );
  }

  /** A folder version (default: the latest) as a zip archive, streamed: the Runtime's response. */
  zip(artifactId: string, options: { version?: number; signal?: AbortSignal } = {}): Promise<Response> {
    return this.transport.request(`${this.versionPath(artifactId, options.version)}/zip`, {
      method: "GET",
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  private versionPath(artifactId: string, version: number | undefined): string {
    return `/v1/artifacts/${segment(artifactId)}/versions/${version ?? "latest"}`;
  }

  /** Deletes the artifact, every version and its bytes; its links stop working. */
  delete(artifactId: string, options: { signal?: AbortSignal } = {}): Promise<DeleteArtifactResponse> {
    return this.transport.json(`/v1/artifacts/${segment(artifactId)}`, "DELETE", undefined, options.signal);
  }
}
