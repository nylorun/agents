import type { IncomingMessage, ServerResponse } from "node:http";
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from "@nylorun/agents";

const LOCAL_OWNER = "local-developer";

function isVaultRead(method: string, path: string): boolean {
  return (
    method === "GET" &&
    (/^\/v1\/vaults$/.test(path) ||
      /^\/v1\/vaults\/[^/]+$/.test(path) ||
      /^\/v1\/vaults\/[^/]+\/credentials$/.test(path) ||
      /^\/v1\/vaults\/[^/]+\/credentials\/[^/]+$/.test(path))
  );
}

function isVaultWrite(method: string, path: string): boolean {
  return (
    (method === "POST" &&
      (/^\/v1\/vaults$/.test(path) ||
        /^\/v1\/vaults\/[^/]+\/credentials$/.test(path) ||
        /^\/v1\/vaults\/[^/]+\/credentials\/[^/]+$/.test(path))) ||
    (method === "DELETE" &&
      (/^\/v1\/vaults\/[^/]+$/.test(path) ||
        /^\/v1\/vaults\/[^/]+\/credentials\/[^/]+$/.test(path)))
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
 * stay in this process, not the browser.
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
  const allowed =
    options.allowedOrigins ?? new Set<string>([options.origin]);
  const fail = (status: number, message: string) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ message }));
  };
  const health = method === "GET" && path === "/health";
  const read =
    method === "GET" &&
    (/^\/v1\/(agents|sessions)$/.test(path) ||
      /^\/v1\/sessions\/[^/]+(?:\/(items|events|manifest))?$/.test(path) ||
      path === "/v1/tenant/model" ||
      path === "/v1/tenant/models" ||
      path === "/v1/tenant/providers" ||
      isVaultRead(method, path));
  const write =
    (method === "PUT" && /^\/v1\/sessions\/[^/]+$/.test(path)) ||
    (method === "POST" && /^\/v1\/sessions\/[^/]+\/commands$/.test(path));
  const tenantWrite =
    method === "PUT" &&
    (path === "/v1/tenant/model" || path === "/v1/tenant/model/selection");
  const vaultWrite = isVaultWrite(method, path);
  if (!health && !read && !write && !tenantWrite && !vaultWrite)
    return fail(404, "Unsupported Studio operation");
  const requestOrigin = request.headers.origin;
  if (
    (write || tenantWrite || vaultWrite) &&
    (requestOrigin === undefined || !allowed.has(requestOrigin))
  )
    return fail(403, "Studio mutations require a same-origin request");
  let body: string | undefined;
  if (write || tenantWrite || (vaultWrite && method === "POST")) {
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
    if (vaultWrite && path === "/v1/vaults" && method === "POST") {
      // Studio's Connections are the installation's own vaults, which any session may use.
      delete value.ownerUserId;
      value.scope = "installation";
    }
    else if (!tenantWrite && !vaultWrite && method === "PUT")
      value.ownerUserId = LOCAL_OWNER;
    else if (
      !tenantWrite &&
      !vaultWrite &&
      !["message", "cancel"].includes(value.type)
    )
      return fail(
        400,
        "This Studio release supports message and cancel commands",
      );
    body = JSON.stringify(value);
  }
  if (path === "/v1/vaults" && method === "GET")
    incoming.searchParams.set("ownerUserId", LOCAL_OWNER);
  const controller = new AbortController();
  response.on("close", () => controller.abort());
  try {
    const upstream = await fetch(options.runtimeUrl + path + incoming.search, {
      method,
      body,
      redirect: "error",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${options.serverKey}`,
        [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
        ...(body ? { "content-type": "application/json" } : {}),
        ...(request.headers["last-event-id"]
          ? { "last-event-id": String(request.headers["last-event-id"]) }
          : {}),
        accept: request.headers.accept ?? "application/json",
      },
    });
    response.writeHead(upstream.status, {
      "content-type":
        upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    });
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
