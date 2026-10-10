/**
 * Definition files (track R2 M4): `PUT /v1/files/sha256:{hex}` uploads one file a definition
 * names by its content hash (a skill's), `HEAD` says whether the Tenant holds it. Application
 * key only: definitions are the application's, not a person's.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { DEFINITION_FILE_MAX_BYTES } from "@nylorun/core/contracts";
import { DefinitionFileView } from "../../components.js";
import { normalizeContentType } from "../../../artifacts/media-types.js";
import { hasDefinitionFile, putDefinitionFile } from "../../../tenant/definition-files.js";
import { fail } from "../../../tenant/http.js";
import type { TenantEnv } from "../app.js";
import { tenantRoute, type RouteAccess } from "../define.js";
import { jsonResponse } from "../respond.js";

const APPLICATION: RouteAccess = { credentials: ["application"], scopes: "never" };
const UPLOAD: RouteAccess = { ...APPLICATION, bytes: true };

const file = z.object({
  file: z.string().meta({ description: "`sha256:` and the SHA-256 of the file's bytes, 64 lowercase hex digits" }),
});
const view = (description: string) => ({
  description,
  content: { "application/json": { schema: DefinitionFileView } },
});

/** The declared `Content-Length`, when there is one. */
function declaredLength(request: Request): number | undefined {
  const raw = request.headers.get("content-length");
  return raw !== null && /^\d+$/.test(raw) ? Number(raw) : undefined;
}

/** The declared media type, unless it is absent or `application/octet-stream`. */
function declaredType(request: Request): string | undefined {
  const raw = request.headers.get("content-type") ?? undefined;
  if (raw === undefined) return undefined;
  const type = normalizeContentType(raw);
  if (type === undefined) return fail(400, "Content-Type is not a media type");
  return type.toLowerCase().startsWith("application/octet-stream") ? undefined : type;
}

export function fileRoutes(api: OpenAPIHono<TenantEnv>): void {
  tenantRoute(
    api,
    UPLOAD,
    {
      method: "put",
      path: "/v1/files/{file}",
      tags: ["Definition files"],
      summary: "Upload a definition file",
      description: `Stores the body, at most ${DEFINITION_FILE_MAX_BYTES} bytes, at the SHA-256 the path names; a body with another hash stores nothing (\`400\`). A file the Tenant holds already is kept as it is (\`200\`).`,
      request: {
        params: file,
        body: {
          required: true,
          description: "The file's bytes",
          content: { "application/octet-stream": { schema: z.string().meta({ format: "binary" }) } },
        },
      },
      responses: {
        200: view("The Tenant held the file already"),
        201: view("The file, stored"),
        413: { description: `Larger than ${DEFINITION_FILE_MAX_BYTES} bytes (\`limit_exceeded\`)` },
      },
    },
    async (c) => {
      const request = c.req.raw;
      const length = declaredLength(request);
      const type = declaredType(request);
      const stored = await putDefinitionFile(
        c.env.tenant,
        c.req.param("file")!,
        {
          body: request.body,
          ...(length === undefined ? {} : { declaredBytes: length }),
          ...(type === undefined ? {} : { contentType: type }),
        },
        request.signal,
      );
      return jsonResponse(stored.status, stored.view);
    },
  );

  tenantRoute(
    api,
    APPLICATION,
    {
      method: "head",
      path: "/v1/files/{file}",
      tags: ["Definition files"],
      summary: "Whether the Runtime holds a definition file",
      description: "`200` when the Tenant holds the file, `404` when it does not: upload it.",
      request: { params: file },
      responses: { 200: { description: "The Tenant holds the file" } },
    },
    async (c) => {
      if (!(await hasDefinitionFile(c.env.tenant, c.req.param("file")!)))
        return fail(404, "The Runtime does not hold this file");
      return new Response(null, { status: 200 });
    },
  );
}
