import type { IncomingMessage, ServerResponse } from "node:http";
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from "@nylorun/agents";

const LOCAL_OWNER = "local-developer";
/** What an agent's tools would get from the Environment a new session names. */
const COVERAGE = "/v1/tenant/credential-coverage";
/** One Environment (protocol 11): its id is one percent-encoded path segment. */
const ENVIRONMENT = String.raw`/v1/environments/[^/]+`;
const matches = (pattern: string, path: string) =>
  new RegExp(`^${pattern}$`).test(path);

/**
 * Environment reads on the Runtime API: the list (with label filters and pages), one
 * Environment, its lifecycle events, its disk versions, and its secrets' names, types and
 * bindings (never a value).
 */
function isEnvironmentRead(method: string, path: string): boolean {
  return (
    method === "GET" &&
    (path === "/v1/environments" ||
      matches(`${ENVIRONMENT}(?:/events|/versions|/secrets(?:/[^/]+)?)?`, path))
  );
}

/**
 * Environment writes on the Runtime API: create or change one (`PUT`), stop or reset it, keep
 * or restore a version of its disk, delete it or one of its disk versions, and write or delete
 * one of its secrets.
 */
function isEnvironmentWrite(method: string, path: string): boolean {
  return (
    (method === "PUT" && matches(`${ENVIRONMENT}(?:/secrets/[^/]+)?`, path)) ||
    (method === "POST" && matches(`${ENVIRONMENT}/(?:stop|reset|snapshot|restore)`, path)) ||
    (method === "DELETE" &&
      matches(`${ENVIRONMENT}(?:/secrets/[^/]+|/versions/[1-9]\\d*)?`, path))
  );
}

/**
 * Management API checks Studio's key makes as itself: a preview of the tools behind a URL
 * (`POST /v1/tenant/mcp/preview`, R2b C12), which may send an Environment's credential, and
 * an agent's credential coverage against an Environment (`POST
 * /v1/tenant/credential-coverage`), which reads no secret.
 */
function isManagementCheck(method: string, path: string): boolean {
  return (
    method === "POST" &&
    (path === "/v1/tenant/mcp/preview" || path === COVERAGE)
  );
}

export type StudioProxyOptions = {
  origin: string;
  runtimeUrl: string;
  /** Bearer sent to the Runtime: the Tenant's Studio key. Never reaches the browser. */
  serverKey: string;
  /** Request path prefix stripped before forwarding. Default `/_studio/runtime`. */
  prefix?: string;
  /** Origins allowed to change state. Default: only `origin`. */
  allowedOrigins?: ReadonlySet<string>;
};

/**
 * Trusted Runtime proxy: forwards one allowlisted Tenant API request with the
 * given bearer. The Host serves one Tenant, so nothing names it. Credentials
 * stay in this process, not the browser. It never sends `Nylorun-Subject` or
 * `Nylorun-Scopes`: on `/v1/tenant/*` Studio's key acts as itself (AP15).
 */
export async function proxyRuntime(
  request: IncomingMessage,
  response: ServerResponse,
  options: StudioProxyOptions,
): Promise<void> {
  const incoming = new URL(request.url!, options.origin);
  const path = incoming.pathname.slice(
    (options.prefix ?? "/_studio/runtime").length,
  );
  const method = request.method ?? "GET";
  const allowed = options.allowedOrigins ?? new Set<string>([options.origin]);
  const fail = (status: number, message: string) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ message }));
  };
  const health = method === "GET" && path === "/health";
  const capabilityRead =
    method === "GET" && /^\/v1\/artifact-links\/[^/]+$/.test(path);
  const artifactLink =
    method === "POST" && /^\/v1\/artifacts\/[^/]+\/links$/.test(path);
  const resourceRead =
    method === "GET" &&
    (isEnvironmentRead(method, path) ||
      /^\/v1\/artifacts(?:\/[^/]+(?:\/versions\/(?:latest|[1-9]\d*)\/(?:content|tree|diff|zip|files\/[^/]+))?)?$/.test(
        path,
      ));
  const artifactContent =
    capabilityRead ||
    (resourceRead &&
      /^\/v1\/artifacts\/[^/]+\/versions\/(?:latest|[1-9]\d*)\/(?:content|zip|files\/[^/]+)$/.test(
        path,
      ));
  const read =
    method === "GET" &&
    (/^\/v1\/(agents|sessions)$/.test(path) ||
      /^\/v1\/sessions\/[^/]+(?:\/(items|events|manifest))?$/.test(path) ||
      path === "/v1/tenant/model" ||
      path === "/v1/tenant/models" ||
      path === "/v1/tenant/providers" ||
      resourceRead ||
      capabilityRead);
  const write =
    (method === "PUT" && /^\/v1\/sessions\/[^/]+$/.test(path)) ||
    (method === "POST" && /^\/v1\/sessions\/[^/]+\/commands$/.test(path));
  const tenantWrite =
    method === "PUT" &&
    (path === "/v1/tenant/model" || path === "/v1/tenant/model/selection");
  const managementCheck = isManagementCheck(method, path);
  const environmentWrite = isEnvironmentWrite(method, path);
  if (
    !health &&
    !read &&
    !write &&
    !tenantWrite &&
    !managementCheck &&
    !environmentWrite &&
    !artifactLink
  )
    return fail(404, "Unsupported Studio operation");
  const requestOrigin = request.headers.origin;
  if (
    (write ||
      tenantWrite ||
      managementCheck ||
      environmentWrite ||
      artifactLink) &&
    (requestOrigin === undefined || !allowed.has(requestOrigin))
  )
    return fail(403, "Studio mutations require a same-origin request");
  let body: string | undefined;
  if (
    write ||
    tenantWrite ||
    artifactLink ||
    managementCheck ||
    (environmentWrite && method !== "DELETE")
  ) {
    if (!request.headers["content-type"]?.startsWith("application/json"))
      return fail(415, "JSON required");
    let text = "";
    for await (const chunk of request) {
      text += chunk;
      if (Buffer.byteLength(text) > 1024 * 1024)
        return fail(413, "Request too large");
    }
    let value: any;
    try {
      value = JSON.parse(text);
    } catch {
      return fail(400, "Invalid JSON");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      return fail(400, "JSON object required");
    if (artifactLink) {
      // Only the existing public link contract, pinned to an explicit version.
      if (
        !Number.isSafeInteger(value.version) ||
        value.version < 1 ||
        (value.file !== undefined && typeof value.file !== "string")
      )
        return fail(
          400,
          "A download link requires a version and an optional file path",
        );
      value = {
        version: value.version,
        expiresIn: 60,
        ...(value.file === undefined ? {} : { file: value.file }),
      };
    } else if (write && method === "PUT")
      // Studio's sessions are its local developer's; an Environment's owner guard is the
      // operator's to set, so Environment writes pass as they are.
      value.ownerUserId = LOCAL_OWNER;
    else if (write && !["message", "cancel"].includes(value.type))
      return fail(
        400,
        "This Studio release supports message and cancel commands",
      );
    body = JSON.stringify(value);
  }
  const controller = new AbortController();
  response.on("close", () => controller.abort());
  try {
    const upstream = await fetch(options.runtimeUrl + path + incoming.search, {
      method,
      body,
      redirect: "error",
      signal: controller.signal,
      headers: {
        ...(capabilityRead
          ? {}
          : { authorization: `Bearer ${options.serverKey}` }),
        [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
        ...(body ? { "content-type": "application/json" } : {}),
        ...(request.headers["last-event-id"]
          ? { "last-event-id": String(request.headers["last-event-id"]) }
          : {}),
        accept: request.headers.accept ?? "application/json",
        ...(artifactContent
          ? {
              "accept-encoding": "identity",
              ...(request.headers.range
                ? { range: String(request.headers.range) }
                : {}),
              ...(request.headers["if-range"]
                ? { "if-range": String(request.headers["if-range"]) }
                : {}),
            }
          : {}),
      },
    });
    const headers: Record<string, string> = {
      "content-type":
        upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    };
    if (artifactContent) {
      for (const name of [
        "accept-ranges",
        "content-range",
        "content-length",
        "etag",
        "content-disposition",
      ])
        if (upstream.headers.has(name))
          headers[name] = upstream.headers.get(name)!;
      // All content is delivered as a download. Preview components read bytes,
      // never navigate to untrusted HTML on Studio's authenticated origin.
      headers["content-disposition"] = (
        headers["content-disposition"] ?? "attachment"
      ).replace(/^inline\b/i, "attachment");
      headers["x-content-type-options"] = "nosniff";
      headers["content-security-policy"] = "sandbox; default-src 'none'";
    }
    response.writeHead(upstream.status, headers);
    response.flushHeaders();
    if (upstream.body)
      for await (const chunk of upstream.body) {
        if (!response.write(chunk))
          await new Promise<void>((resolve) => {
            const done = () => {
              response.off("drain", done);
              response.off("close", done);
              resolve();
            };
            response.once("drain", done);
            response.once("close", done);
          });
        if (controller.signal.aborted) break;
      }
    response.end();
  } catch {
    if (!response.headersSent) fail(502, "Runtime is unavailable");
    else response.end();
  }
}
