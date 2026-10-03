/**
 * File artifacts (`/v1/artifacts/**`, protocol 6): upload a file in one streamed request (a new
 * artifact, or a new version of one), list and read them, download a version with HTTP Range
 * through the Runtime, mint a capability link, and delete. `GET /v1/artifact-links/{token}`
 * opens a capability link with no other credential and no `Nylorun-Protocol`. The Tenant's
 * limits are `GET`/`PUT /v1/tenant/artifacts`.
 *
 * Acting for a person, a caller reaches only the artifacts of that person's sessions, as it
 * reaches only their sessions.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import {
  ArtifactLabelsSchema,
  CreateArtifactLinkRequestSchema,
  PutTenantArtifactsRequestSchema,
} from "@nylorun/core/contracts";
import {
  ArtifactLink,
  ArtifactView,
  CreateArtifactLinkRequest,
  DeleteArtifactResponse,
  ListArtifactsResponse,
  PutTenantArtifactsRequest,
  TenantArtifactsView,
  UploadArtifactResponse,
} from "../../components.js";
import { BlobRangeError } from "../../../blob/index.js";
import {
  effectiveArtifactLimits,
  readArtifactsConfig,
  writeArtifactsConfig,
} from "../../../artifacts/config.js";
import { mintArtifactLink, verifyArtifactLink } from "../../../artifacts/links.js";
import { normalizeContentType } from "../../../artifacts/media-types.js";
import {
  artifactContent,
  deleteArtifact,
  getArtifact,
  listArtifacts,
  readableArtifact,
  uploadArtifact,
  versionOf,
} from "../../../artifacts/service.js";
import type { ArtifactRow, ArtifactVersionRow } from "../../../store/types.js";
import { accessOf } from "../../../tenant/auth.js";
import type { TenantContext } from "../../../tenant/context.js";
import { fail } from "../../../tenant/http.js";
import type { TenantEnv } from "../app.js";
import { readJson } from "../body.js";
import { tenantRoute, type RouteAccess } from "../define.js";
import { jsonResponse } from "../respond.js";

/** Reading and writing artifacts: whoever may use sessions, a person only in their own. */
const OWN: RouteAccess = {
  credentials: ["application", "subject", "token"],
  scopes: ["sessions:own"],
  browser: true,
};
/** An upload: the same callers, with the file's bytes as the body. */
const UPLOAD: RouteAccess = { ...OWN, bytes: true };
/** A capability link: no credential, no protocol header; the token in the path is the grant. */
const LINK: RouteAccess = {
  credentials: ["application", "subject", "token", "publishable"],
  scopes: "any",
  browser: true,
  anonymous: true,
  unversioned: true,
};
const SETTINGS: RouteAccess = {
  credentials: ["application", "subject"],
  scopes: ["tenant:settings"],
};

const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const fileBody = {
  required: true,
  description: "The file's bytes; `Content-Type` is its media type",
  content: { "*/*": { schema: z.string().meta({ format: "binary" }) } },
};
const fileContent = (description: string) => ({
  description,
  headers: z.object({
    "Accept-Ranges": z.string().meta({ description: "`bytes`" }),
    "Content-Range": z
      .string()
      .optional()
      .meta({ description: "The bytes sent, on a `206`: `bytes <start>-<end>/<size>`" }),
    ETag: z.string().meta({ description: "The version's SHA-256, quoted" }),
  }),
  content: { "*/*": { schema: z.string().meta({ format: "binary" }) } },
});
const ranged = {
  206: fileContent("The bytes the `Range` header asked for"),
  416: { description: "The `Range` starts past the end of the file" },
};
const artifactId = z.object({ artifactId: z.string() });
const versionParam = z.object({
  artifactId: z.string(),
  version: z.string().meta({ description: "A version number, or `latest`" }),
});
const labelQuery = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .meta({ description: "`key=value`; repeat it for several labels" });

/** `label=k=v`, repeated. */
function labelsOf(values: readonly string[] | undefined): Record<string, string> | undefined {
  if (values === undefined || values.length === 0) return undefined;
  const labels: Record<string, string> = {};
  for (const value of values) {
    const at = value.indexOf("=");
    if (at <= 0) fail(400, `label must be key=value, not ${value}`);
    labels[value.slice(0, at)] = value.slice(at + 1);
  }
  const parsed = ArtifactLabelsSchema.safeParse(labels);
  if (!parsed.success) fail(400, parsed.error.issues[0]?.message ?? "Invalid labels");
  return labels;
}

function versionNumber(value: string | undefined): number | undefined {
  if (value === "latest") return undefined;
  if (value === undefined || !/^[1-9]\d{0,8}$/.test(value))
    return fail(400, "version must be a version number or latest");
  return Number(value);
}

/** The declared `Content-Length`, when there is one. */
function declaredLength(request: Request): number | undefined {
  const raw = request.headers.get("content-length");
  return raw !== null && /^\d+$/.test(raw) ? Number(raw) : undefined;
}

/** The declared media type: absent, or `application/octet-stream`, means "from the name". */
function declaredType(request: Request): string | undefined {
  const raw = request.headers.get("content-type") ?? undefined;
  if (raw === undefined) return undefined;
  const type = normalizeContentType(raw);
  if (type === undefined) return fail(400, "Content-Type is not a media type");
  return type.toLowerCase().startsWith("application/octet-stream") ? undefined : type;
}

/**
 * One `bytes=` range of a file of `size` bytes: what to send, `"unsatisfiable"`, or undefined
 * to send the whole file (no header, several ranges, or one the Runtime ignores).
 */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | "unsatisfiable" | undefined {
  if (header === undefined) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return undefined;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  if (match[2] !== "" && Number(match[2]) < start) return undefined;
  if (start >= size) return "unsatisfiable";
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  return { start, end };
}

/** `inline; filename=…`, with an ASCII fallback and the UTF-8 name. */
function disposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * The version's bytes, streamed from the Object store: the whole file, or the one range asked
 * for (`206`, `Content-Range`), or `416` when it starts past the end. Served so a browser never
 * runs it as a page of the Runtime's origin.
 */
async function contentResponse(
  ctx: TenantContext,
  artifact: ArtifactRow,
  version: ArtifactVersionRow,
  request: Request,
): Promise<Response> {
  const range = parseRange(request.headers.get("range") ?? undefined, version.size);
  const headers: Record<string, string> = {
    "accept-ranges": "bytes",
    etag: `"${version.sha256}"`,
    "cache-control": "private, max-age=0",
    "content-disposition": disposition(artifact.name),
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
  };
  if (range === "unsatisfiable")
    return new Response(null, {
      status: 416,
      headers: { ...headers, "content-range": `bytes */${version.size}` },
    });
  let got;
  try {
    got = await ctx.blobs.get(version.blobKey, {
      ...(range ? { range } : {}),
      signal: request.signal,
    });
  } catch (error) {
    if (error instanceof BlobRangeError)
      return new Response(null, {
        status: 416,
        headers: { ...headers, "content-range": `bytes */${version.size}` },
      });
    throw error;
  }
  if (!got) return fail(404, "Artifact bytes not found");
  const sent = got.range ?? (range ? range : undefined);
  const length = sent ? sent.end - sent.start + 1 : got.size;
  return new Response(got.body, {
    status: sent ? 206 : 200,
    headers: {
      ...headers,
      "content-type": version.contentType,
      "content-length": String(length),
      ...(sent ? { "content-range": `bytes ${sent.start}-${sent.end}/${got.size}` } : {}),
    },
  });
}

export function artifactRoutes(api: OpenAPIHono<TenantEnv>): void {
  tenantRoute(
    api,
    UPLOAD,
    {
      method: "post",
      path: "/v1/artifacts",
      tags: ["Artifacts"],
      summary: "Upload a file as a new artifact",
      description:
        "Streams the body to the Object store in one request, up to the Tenant's per-file limit and within its total; a body past either stores nothing (`413 limit_exceeded`). Its `Content-Type` is the file's media type (default: from the name). Acting for a person, the artifact belongs to one of their sessions. A session's artifact appears in its history as `artifact.created`.",
      request: {
        query: z.object({
          name: z.string().meta({ description: "The file's name, e.g. `brief.pdf`" }),
          sessionId: z.string().optional().meta({ description: "The session it belongs to" }),
          label: labelQuery,
        }),
        body: fileBody,
      },
      responses: {
        201: json(UploadArtifactResponse, "The artifact and its first version"),
        413: { description: "Larger than the per-file limit, or past the Tenant's total (`limit_exceeded`)" },
      },
    },
    async (c) => {
      const scope = c.get("scope");
      const request = c.req.raw;
      const name = c.req.query("name");
      const sessionId = c.req.query("sessionId");
      const labels = labelsOf(c.req.queries("label"));
      const contentType = declaredType(request);
      const uploaded = await uploadArtifact(
        c.env.tenant,
        {
          ...(name === undefined ? {} : { name }),
          ...(contentType === undefined ? {} : { contentType }),
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(labels === undefined ? {} : { labels }),
          ...(declaredLength(request) === undefined ? {} : { declaredBytes: declaredLength(request)! }),
          source: "upload",
        },
        request.body ?? new Uint8Array(),
        accessOf(scope),
        request.signal,
      );
      return jsonResponse(201, uploaded);
    },
  );

  tenantRoute(
    api,
    UPLOAD,
    {
      method: "post",
      path: "/v1/artifacts/{artifactId}/versions",
      tags: ["Artifacts"],
      summary: "Upload a new version of an artifact",
      description:
        "Streams the body as the artifact's next version, with the same limits as a new artifact. A session's artifact gets `artifact.version.created` in its history.",
      request: { params: artifactId, body: fileBody },
      responses: {
        201: json(UploadArtifactResponse, "The artifact and the version the upload created"),
        413: { description: "Larger than the per-file limit, or past the Tenant's total (`limit_exceeded`)" },
      },
    },
    async (c) => {
      const request = c.req.raw;
      const contentType = declaredType(request);
      const uploaded = await uploadArtifact(
        c.env.tenant,
        {
          artifactId: c.req.param("artifactId")!,
          ...(contentType === undefined ? {} : { contentType }),
          ...(declaredLength(request) === undefined ? {} : { declaredBytes: declaredLength(request)! }),
          source: "upload",
        },
        request.body ?? new Uint8Array(),
        accessOf(c.get("scope")),
        request.signal,
      );
      return jsonResponse(201, uploaded);
    },
  );

  tenantRoute(
    api,
    OWN,
    {
      method: "get",
      path: "/v1/artifacts",
      tags: ["Artifacts"],
      summary: "List artifacts",
      description: "Oldest first: of one session, or of every session the caller reaches (an application key: every artifact).",
      request: {
        query: z.object({ sessionId: z.string().optional().meta({ description: "Only this session's" }) }),
      },
      responses: { 200: json(ListArtifactsResponse, "The artifacts") },
    },
    async (c) => {
      const sessionId = c.req.query("sessionId");
      return jsonResponse(
        200,
        await listArtifacts(
          c.env.tenant,
          sessionId === undefined ? {} : { sessionId },
          accessOf(c.get("scope")),
        ),
      );
    },
  );

  tenantRoute(
    api,
    OWN,
    {
      method: "get",
      path: "/v1/artifacts/{artifactId}",
      tags: ["Artifacts"],
      summary: "Get an artifact",
      description: "Its metadata and every version, oldest first.",
      request: { params: artifactId },
      responses: { 200: json(ArtifactView, "The artifact") },
    },
    async (c) =>
      jsonResponse(
        200,
        await getArtifact(c.env.tenant, c.req.param("artifactId")!, accessOf(c.get("scope"))),
      ),
  );

  tenantRoute(
    api,
    OWN,
    {
      method: "get",
      path: "/v1/artifacts/{artifactId}/versions/{version}/content",
      tags: ["Artifacts"],
      summary: "Download a version of an artifact",
      description:
        "Streams the bytes through the Runtime. One `Range: bytes=…` gives `206` with `Content-Range`; several ranges give the whole file.",
      request: { params: versionParam },
      responses: { 200: fileContent("The file"), ...ranged },
    },
    async (c) => {
      const ctx = c.env.tenant;
      const { artifact, version } = await artifactContent(
        ctx,
        c.req.param("artifactId")!,
        versionNumber(c.req.param("version")),
        accessOf(c.get("scope")),
      );
      return contentResponse(ctx, artifact, version, c.req.raw);
    },
  );

  tenantRoute(
    api,
    OWN,
    {
      method: "post",
      path: "/v1/artifacts/{artifactId}/links",
      tags: ["Artifacts"],
      summary: "Mint a capability link",
      description:
        "A short-lived path that downloads one version, with Range, with no other credential: for `<img>` tags, UIs and sharing. Signed by the Runtime with the Tenant's signing key; at most 15 minutes; it opens nothing once the artifact is deleted.",
      request: {
        params: artifactId,
        body: { required: true, content: { "application/json": { schema: CreateArtifactLinkRequest } } },
      },
      responses: { 200: json(ArtifactLink, "The link") },
    },
    async (c) => {
      const ctx = c.env.tenant;
      const request = CreateArtifactLinkRequestSchema.parse(await readJson(c.req.raw));
      const id = c.req.param("artifactId")!;
      const version = await ctx.store.tx(async (t) => {
        const artifact = await readableArtifact(t, id, accessOf(c.get("scope")));
        return (await versionOf(t, artifact, request.version)).version;
      });
      return jsonResponse(
        200,
        await mintArtifactLink(ctx, {
          artifactId: id,
          version,
          ...(request.expiresIn === undefined ? {} : { expiresIn: request.expiresIn }),
        }),
      );
    },
  );

  tenantRoute(
    api,
    OWN,
    {
      method: "delete",
      path: "/v1/artifacts/{artifactId}",
      tags: ["Artifacts"],
      summary: "Delete an artifact",
      description:
        "Deletes every version and its bytes; its links stop working. A session's artifact gets `artifact.deleted` in its history.",
      request: { params: artifactId },
      responses: { 200: json(DeleteArtifactResponse, "Deleted") },
    },
    async (c) =>
      jsonResponse(
        200,
        await deleteArtifact(c.env.tenant, c.req.param("artifactId")!, accessOf(c.get("scope"))),
      ),
  );

  tenantRoute(
    api,
    LINK,
    {
      method: "get",
      path: "/v1/artifact-links/{token}",
      tags: ["Artifacts"],
      summary: "Open a capability link",
      description:
        "Downloads the version the link names, with Range, until it expires (`401 token_expired`). Needs no credential and no `Nylorun-Protocol`.",
      request: { params: z.object({ token: z.string() }) },
      responses: { 200: fileContent("The file"), ...ranged },
    },
    async (c) => {
      const ctx = c.env.tenant;
      const { artifactId: id, version } = await verifyArtifactLink(ctx, c.req.param("token")!);
      const opened = await artifactContent(ctx, id, version, undefined).catch(() => fail(404, "Not found"));
      return contentResponse(ctx, opened.artifact, opened.version, c.req.raw);
    },
  );

  tenantRoute(
    api,
    SETTINGS,
    {
      method: "get",
      path: "/v1/tenant/artifacts",
      tags: ["Tenant"],
      summary: "Get the Tenant's artifact limits",
      responses: { 200: json(TenantArtifactsView, "The limits in force and the bytes used") },
    },
    async (c) => jsonResponse(200, await artifactsView(c.env.tenant)),
  );

  tenantRoute(
    api,
    SETTINGS,
    {
      method: "put",
      path: "/v1/tenant/artifacts",
      tags: ["Tenant"],
      summary: "Set the Tenant's artifact limits",
      description: "The largest file one upload may store, and the most bytes all artifacts may hold. Unset limits take the defaults (100 MiB and 10 GiB).",
      request: {
        body: { required: true, content: { "application/json": { schema: PutTenantArtifactsRequest } } },
      },
      responses: { 200: json(TenantArtifactsView, "The limits now in force") },
    },
    async (c) => {
      const ctx = c.env.tenant;
      const { requestId: _requestId, ...config } = PutTenantArtifactsRequestSchema.parse(
        await readJson(c.req.raw),
      );
      await ctx.store.tx((t) => writeArtifactsConfig(t, config));
      return jsonResponse(200, await artifactsView(ctx));
    },
  );
}

async function artifactsView(ctx: TenantContext) {
  return ctx.store.tx(async (t) => ({
    limits: effectiveArtifactLimits(await readArtifactsConfig(t)),
    usedBytes: await t.artifactBytes(),
  }));
}
