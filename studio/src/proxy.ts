import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { PROTOCOL_HEADER, PROTOCOL_VERSION, RUNTIME_LIMIT_DEFAULTS } from "@nylorun/agents";

const LOCAL_OWNER = "local-developer";
/** What an Agent's tools would get from its vault. */
const COVERAGE = "/v1/tenant/credential-coverage";
/** One Agent (protocol 16): its id is one percent-encoded path segment. */
const AGENT = String.raw`/v1/agents/[^/]+`;
/** The agent manifests (protocol 16, track T2), and one by its name. */
const MANIFESTS = "/v1/agent-manifests";
const MANIFEST = String.raw`/v1/agent-manifests/[^/]+`;
const matches = (pattern: string, path: string) =>
  new RegExp(`^${pattern}$`).test(path);

/**
 * Agent reads on the Runtime API: the list (with state, manifest and label filters, and pages),
 * one Agent, its lifecycle events, its disk versions, and its secrets' names, types and bindings
 * (never a value); and the agent manifests, one manifest, its versions and one version.
 */
function isAgentRead(method: string, path: string): boolean {
  return (
    method === "GET" &&
    (path === "/v1/agents" ||
      matches(`${AGENT}(?:/events|/versions|/secrets(?:/[^/]+)?)?`, path) ||
      path === MANIFESTS ||
      matches(`${MANIFEST}(?:/versions(?:/[1-9]\\d*)?)?`, path))
  );
}

/** Saving an agent manifest's next version (`PUT`, or its plan with `?dryRun=true`). */
const isManifestSave = (method: string, path: string) => method === "PUT" && matches(MANIFEST, path);

/**
 * Agent writes on the Runtime API: make one from a manifest version or change its labels and
 * owner (`PUT`), stop, restart (on its pending version, or `retry` the failed one) or reset it,
 * fork it, keep or restore a version of its disk, delete it or
 * one of its disk versions, and write or delete one of its secrets; and save an agent manifest.
 */
function isAgentWrite(method: string, path: string): boolean {
  return (
    (method === "PUT" && matches(`${AGENT}(?:/secrets/[^/]+)?`, path)) ||
    isManifestSave(method, path) ||
    (method === "POST" && matches(`${AGENT}/(?:stop|restart|reset|fork|snapshot|restore)`, path)) ||
    (method === "DELETE" && matches(`${AGENT}(?:/secrets/[^/]+|/versions/[1-9]\\d*)?`, path))
  );
}

/**
 * Management API checks Studio's key makes as itself: a preview of the tools behind a URL
 * (`POST /v1/tenant/mcp/preview`, R2b C12), which may send an Agent's credential, and an Agent's
 * credential coverage (`POST /v1/tenant/credential-coverage`), which reads no secret.
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
  /**
   * The largest file a message attachment upload forwards. Default: no cap of Studio's own; the
   * Runtime holds the upload to the Tenant's artifact limits (`/v1/tenant/artifacts`).
   */
  maxUploadBytes?: number;
};

/**
 * The largest JSON body the Runtime reads: the Tenant's Runtime limit `requestBodyBytes`. Studio
 * reads a write it parses (it rewrites some) up to the limit's default without asking, and asks
 * the Runtime only for a larger one, so it refuses only what the Runtime would.
 */
async function requestBodyBytes(options: StudioProxyOptions, signal: AbortSignal): Promise<number | undefined> {
  try {
    const answer = await fetch(`${options.runtimeUrl}/v1/tenant/limits`, {
      redirect: "error",
      signal,
      headers: {
        authorization: `Bearer ${options.serverKey}`,
        [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
        accept: "application/json",
      },
    });
    const limits = answer.ok ? ((await answer.json()) as { limits?: { requestBodyBytes?: unknown } }).limits : undefined;
    if (typeof limits?.requestBodyBytes === "number") return limits.requestBodyBytes;
    await answer.body?.cancel().catch(() => {});
  } catch {
    // Unreachable: the write is answered 502.
  }
  return undefined;
}

/**
 * The bytes of a request, as a stream that errors once more than `limit` bytes have passed
 * (Node's parser already holds a body to its `Content-Length`; this holds it to the cap).
 */
function countedBody(request: IncomingMessage, limit: number, onExceeded: () => void) {
  let seen = 0;
  return (Readable.toWeb(request) as ReadableStream<Uint8Array>).pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > limit) {
          onExceeded();
          controller.error(new Error("Upload exceeds its limit"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

/**
 * Trusted Runtime proxy: forwards one allowlisted Runtime or Management API request with the
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
    (isAgentRead(method, path) ||
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
    (path === "/v1/sessions" ||
      // A session's model usage, for its Usage tab: its totals and its model calls.
      /^\/v1\/sessions\/[^/]+(?:\/(items|events|manifest|usage|calls\/model))?$/.test(path) ||
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
    (path === "/v1/tenant/model" ||
      path === "/v1/tenant/model/selection" ||
      path === "/v1/tenant/models/inputs");
  // A message attachment: one file into one session, streamed to the Runtime.
  const upload = method === "POST" && path === "/v1/artifacts";
  const managementCheck = isManagementCheck(method, path);
  const agentWrite = isAgentWrite(method, path);
  if (
    !health &&
    !read &&
    !write &&
    !tenantWrite &&
    !managementCheck &&
    !agentWrite &&
    !artifactLink &&
    !upload
  )
    return fail(404, "Unsupported Studio operation");
  const requestOrigin = request.headers.origin;
  if (
    (write ||
      tenantWrite ||
      managementCheck ||
      agentWrite ||
      artifactLink ||
      upload) &&
    (requestOrigin === undefined || !allowed.has(requestOrigin))
  )
    return fail(403, "Studio mutations require a same-origin request");
  const controller = new AbortController();
  response.on("close", () => controller.abort());
  let body: string | ReadableStream<Uint8Array> | undefined;
  let search = incoming.search;
  let uploadHeaders: Record<string, string> = {};
  let uploadTooLarge = false;
  if (upload) {
    const refuse = (status: number, message: string) => {
      request.resume();
      fail(status, message);
    };
    const name = incoming.searchParams.get("name");
    const sessionId = incoming.searchParams.get("sessionId");
    if (!name || !sessionId)
      return refuse(400, "An upload names its file (name) and its session (sessionId)");
    const declared = request.headers["content-length"];
    if (declared === undefined || !/^\d+$/.test(declared))
      return refuse(411, "An upload needs a Content-Length");
    const length = Number(declared);
    const limit = options.maxUploadBytes ?? Number.POSITIVE_INFINITY;
    if (length > limit)
      return refuse(413, `A file can be at most ${limit} bytes`);
    // Only into a session that exists: Studio's key could otherwise make Tenant-wide artifacts.
    try {
      const session = await fetch(
        `${options.runtimeUrl}/v1/sessions/${encodeURIComponent(sessionId)}`,
        {
          redirect: "error",
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${options.serverKey}`,
            [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
            accept: "application/json",
          },
        },
      );
      await session.body?.cancel().catch(() => {});
      if (session.status === 404) return refuse(404, "Session not found");
      if (!session.ok)
        return refuse(session.status, "The upload's session could not be read");
    } catch {
      return refuse(502, "Runtime is unavailable");
    }
    search = `?${new URLSearchParams({ name, sessionId })}`;
    body = countedBody(request, limit, () => {
      uploadTooLarge = true;
    });
    uploadHeaders = {
      "content-type":
        request.headers["content-type"] ?? "application/octet-stream",
      "content-length": String(length),
    };
  }
  if (
    write ||
    tenantWrite ||
    artifactLink ||
    managementCheck ||
    (agentWrite && method !== "DELETE")
  ) {
    if (!request.headers["content-type"]?.startsWith("application/json"))
      return fail(415, "JSON required");
    let most: number = RUNTIME_LIMIT_DEFAULTS.requestBodyBytes;
    let asked = false;
    let text = "";
    for await (const chunk of request) {
      text += chunk;
      if (Buffer.byteLength(text) <= most) continue;
      if (!asked) {
        asked = true;
        const limit = await requestBodyBytes(options, controller.signal);
        if (limit === undefined) return fail(502, "Runtime is unavailable");
        most = limit;
        if (Buffer.byteLength(text) <= most) continue;
      }
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
      // Studio's sessions are its local developer's; an Agent's owner guard is the operator's to
      // set, so Agent writes pass as they are.
      value.ownerUserId = LOCAL_OWNER;
    else if (write && !["message", "cancel"].includes(value.type))
      return fail(
        400,
        "This Studio release supports message and cancel commands",
      );
    body = JSON.stringify(value);
  }
  try {
    const upstream = await fetch(options.runtimeUrl + path + search, {
      method,
      body,
      // A stream is sent as it is read.
      ...(upload ? ({ duplex: "half" } as object) : {}),
      redirect: "error",
      signal: controller.signal,
      headers: {
        ...(capabilityRead
          ? {}
          : { authorization: `Bearer ${options.serverKey}` }),
        [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
        ...(typeof body === "string" ? { "content-type": "application/json" } : {}),
        ...uploadHeaders,
        // A manifest save names the version it was made over (`412 manifest_changed`).
        ...(isManifestSave(method, path) && request.headers["if-match"]
          ? { "if-match": String(request.headers["if-match"]) }
          : {}),
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
    if (!response.headersSent)
      fail(uploadTooLarge ? 413 : 502, uploadTooLarge ? "Upload exceeds its limit" : "Runtime is unavailable");
    else response.end();
  }
}
