import { proxyRuntime } from "./proxy.js";
import {
  authorize,
  mintToken,
  studioCorsHeaders,
  type AuthorizeResult,
} from "./access.js";
import { resolveLocalUiRoot, serveLocalUi } from "./local-ui.js";
import {
  HOSTED_ORIGIN,
  STUDIO_PROTOCOL,
  pairingFragment,
  type StudioHello,
  type StudioMode,
} from "./contract.js";
import {
  STUDIO_VERSION,
  probeRuntimeCompatibility,
} from "./runtime-compat.js";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { openBrowser } from "./browser.js";

export type StudioTenant = Readonly<{ id: string; name: string }>;
export type StudioOptions = Readonly<{
  runtimeUrl?: string;
  serverKey?: string;
  tenant?: StudioTenant;
  port?: number;
  open?: boolean;
  /** Dashboard delivery mode. Default `"local"` until Hosted Studio I2. */
  ui?: StudioMode;
  /** Host data directory for local-mode bundle cache (design §10). */
  cacheDir?: string;
  /** Non-public: one extra allowed Origin for repository Vite development. */
  extraOrigin?: string;
}>;
export type StudioHost = Readonly<{
  address: string;
  launchUrl: string;
  readonly runtimeUrl: string;
  readonly tenant: StudioTenant;
  open(): void;
  close(): Promise<void>;
}>;
export type StudioConfig = Readonly<{
  runtimeUrl: string;
  local: true;
  tenant: StudioTenant;
}>;

const HOSTED_LANDING = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Nylorun Studio</title>
</head>
<body>
<p>Open the Studio URL printed in your terminal.</p>
</body>
</html>
`;

const PROXY_VERSION = STUDIO_VERSION;

export { probeRuntimeCompatibility };

export function parseAgentServerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--runtime-url must be an absolute http(s) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("--runtime-url must use http or https.");
  if (url.username !== "" || url.password !== "")
    throw new Error("--runtime-url must not contain credentials.");
  if (url.search !== "" || url.hash !== "")
    throw new Error(
      "--runtime-url must not contain a query string or fragment.",
    );
  return url.href.replace(/\/$/u, "");
}

function json(
  response: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function reject(
  response: ServerResponse,
  status: number,
  message: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  json(response, status, { error: { message } }, extraHeaders);
}

function loopbackHosts(port: number): ReadonlySet<string> {
  return new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
}

type RequestHandle = (
  request: IncomingMessage,
  response: ServerResponse,
) => void;

async function listenOn(
  host: string,
  port: number,
  handle: RequestHandle,
): Promise<Server> {
  const server = createServer(handle);
  await new Promise<void>((ready, rejectListen) => {
    const failed = (error: Error) => rejectListen(error);
    server.once("error", failed);
    server.listen(port, host, () => {
      server.off("error", failed);
      ready();
    });
  });
  return server;
}

function ipv6Optional(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ["EADDRNOTAVAIL", "EAFNOSUPPORT", "EPERM"].includes(String(error.code))
  );
}

async function bindLoopback(
  handle: RequestHandle,
  port: number,
): Promise<Readonly<{ port: number; servers: readonly Server[] }>> {
  const ipv4 = await listenOn("127.0.0.1", port, handle);
  const address = ipv4.address();
  if (address === null || typeof address === "string") {
    ipv4.close();
    throw new Error("Studio did not report a TCP address.");
  }
  try {
    return Object.freeze({
      port: address.port,
      servers: Object.freeze([
        ipv4,
        await listenOn("::1", address.port, handle),
      ]),
    });
  } catch (error) {
    if (ipv6Optional(error))
      return Object.freeze({
        port: address.port,
        servers: Object.freeze([ipv4]),
      });
    ipv4.close();
    throw error;
  }
}

async function listenForStudio(
  handle: RequestHandle,
  port: number | undefined,
): Promise<Readonly<{ port: number; servers: readonly Server[] }>> {
  if (port !== undefined) return bindLoopback(handle, port);
  let lastError: unknown;
  for (let candidate = 4161; candidate <= 4260; candidate += 1) {
    try {
      return await bindLoopback(handle, candidate);
    } catch (error) {
      lastError = error;
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EADDRINUSE"
      )
        throw error;
    }
  }
  throw new Error(
    `No Studio port is available in the range 4161-4260.${lastError instanceof Error ? ` ${lastError.message}` : ""}`,
  );
}

function applyAuthorizeDeny(
  response: ServerResponse,
  result: Extract<AuthorizeResult, { ok: false }>,
): void {
  reject(response, result.status, result.message, result.headers ?? {});
}

function writeHostedLanding(
  response: ServerResponse,
  method: string,
): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'",
    "x-content-type-options": "nosniff",
  });
  response.end(method === "HEAD" ? undefined : HOSTED_LANDING);
}

/** Serves the trusted Studio proxy (hosted or local UI) on loopback. */
export async function startStudio(
  options: StudioOptions = {},
): Promise<StudioHost> {
  const ui: StudioMode = options.ui ?? "hosted";
  const token = mintToken();
  const requestedAgentServerUrl =
    options.runtimeUrl === undefined
      ? undefined
      : parseAgentServerUrl(options.runtimeUrl);
  if (!requestedAgentServerUrl || !options.serverKey)
    throw new Error("Studio requires runtimeUrl and a serverKey");
  const tenant = options.tenant;
  if (
    !tenant ||
    typeof tenant.id !== "string" ||
    tenant.id.length === 0 ||
    typeof tenant.name !== "string" ||
    tenant.name.length === 0
  )
    throw new Error("Studio requires tenant: { id, name }");
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(
      new URL(requestedAgentServerUrl).hostname,
    )
  )
    throw new Error("This Studio release connects only to a loopback Runtime");
  if (
    options.extraOrigin !== undefined &&
    (typeof options.extraOrigin !== "string" ||
      options.extraOrigin.length === 0)
  )
    throw new Error("extraOrigin must be a non-empty origin string");

  const webRoot =
    ui === "local"
      ? await resolveLocalUiRoot({
          version: PROXY_VERSION,
          ...(options.cacheDir === undefined
            ? {}
            : { cacheDir: options.cacheDir }),
        })
      : undefined;

  let origin = "";
  let agentServerUrl = requestedAgentServerUrl;
  const studioTenant = Object.freeze({ id: tenant.id, name: tenant.name });
  const allowedOrigins = new Set<string>();
  if (ui === "hosted") allowedOrigins.add(HOSTED_ORIGIN);
  if (options.extraOrigin) allowedOrigins.add(options.extraOrigin);

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    void (async () => {
      const url = new URL(request.url ?? "/", origin || "http://localhost");
      if (
        origin === "" ||
        !loopbackHosts(Number(new URL(origin).port)).has(
          request.headers.host ?? "",
        )
      ) {
        reject(
          response,
          421,
          "Studio only accepts its own loopback Host header.",
        );
        return;
      }

      if (url.pathname.startsWith("/_studio/")) {
        const gate = authorize(request, allowedOrigins, token);
        if (gate.ok && "preflight" in gate && gate.preflight) {
          response.writeHead(204, { ...gate.headers });
          response.end();
          return;
        }
        if (!gate.ok) {
          applyAuthorizeDeny(response, gate);
          return;
        }
        const cors = studioCorsHeaders(gate.corsOrigin);

        if (url.pathname === "/_studio/hello") {
          if (request.method !== "GET" && request.method !== "HEAD") {
            reject(response, 405, "Method not allowed", cors);
            return;
          }
          const runtime = await probeRuntimeCompatibility(agentServerUrl!);
          const body: StudioHello = Object.freeze({
            studioProtocol: STUDIO_PROTOCOL,
            proxyVersion: PROXY_VERSION,
            mode: ui,
            tenant: { id: studioTenant.id, name: studioTenant.name },
            runtime,
          });
          if (request.method === "HEAD") {
            response.writeHead(200, {
              "content-type": "application/json; charset=utf-8",
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
              ...cors,
            });
            response.end();
            return;
          }
          json(response, 200, body, cors);
          return;
        }

        if (url.pathname.startsWith("/_studio/runtime/")) {
          await proxyRuntime(request, response, {
            origin: `http://${request.headers.host}`,
            runtimeUrl: agentServerUrl!,
            serverKey: options.serverKey!,
            tenantId: studioTenant.id,
            allowedOrigins,
            corsOrigin: gate.corsOrigin,
          });
          return;
        }

        reject(response, 404, "Unknown Studio route", cors);
        return;
      }

      if (ui === "hosted") {
        if (
          (request.method === "GET" || request.method === "HEAD") &&
          url.pathname === "/"
        ) {
          writeHostedLanding(response, request.method);
          return;
        }
        reject(response, 404, "Studio asset not found.");
        return;
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        reject(response, 405, "Studio only serves static assets.");
        return;
      }
      // Vite builds with base `/v/<version>/` — serve cache under that prefix so
      // index.html asset URLs and React Router basename resolve in local mode.
      const uiPrefix = `/v/${PROXY_VERSION}`;
      let assetPath = url.pathname;
      if (assetPath === uiPrefix || assetPath.startsWith(`${uiPrefix}/`)) {
        assetPath = assetPath.slice(uiPrefix.length) || "/";
      } else if (assetPath === "/" || assetPath === "") {
        response.writeHead(302, {
          location: `${uiPrefix}/`,
          "cache-control": "no-store",
        });
        response.end();
        return;
      } else {
        reject(response, 404, "Studio asset not found.");
        return;
      }
      await serveLocalUi(
        response,
        request.method,
        assetPath,
        webRoot!,
        (status, message) => reject(response, status, message),
      );
    })().catch(() => {
      if (!response.headersSent) reject(response, 500, "Studio request failed");
      else response.end();
    });
  };

  const bound = await listenForStudio(handle, options.port);
  // Proxy always binds loopback; advertise 127.0.0.1 so the local dashboard is
  // same-origin with proxy-client fetches (PROXY_HOST). localhost↔127.0.0.1 is
  // cross-origin and breaks headless Chromium (LNA / CORS) in create-agent smoke.
  origin = `http://127.0.0.1:${bound.port}`;
  if (ui === "local") {
    allowedOrigins.add(origin);
    allowedOrigins.add(`http://localhost:${bound.port}`);
  }
  const address = origin;
  const fragment = pairingFragment({
    protocol: STUDIO_PROTOCOL,
    port: bound.port,
    token,
  });
  // Local launch must include `/v/<version>/` so the SPA + hashed assets load.
  const launchUrl =
    ui === "hosted"
      ? `${HOSTED_ORIGIN}/${fragment}`
      : `${address}/v/${PROXY_VERSION}/${fragment}`;
  const host = Object.freeze({
    address,
    launchUrl,
    get runtimeUrl() {
      return agentServerUrl;
    },
    get tenant() {
      return studioTenant;
    },
    open: () => openBrowser(launchUrl),
    close: async () => {
      await Promise.all(
        bound.servers.map(
          (server) =>
            new Promise<void>((done, rejectClose) => {
              server.closeAllConnections();
              server.close((error) =>
                error === undefined ? done() : rejectClose(error),
              );
            }),
        ),
      );
    },
  });
  if (options.open !== false) host.open();
  return host;
}

/** Alias retained for programmatic callers that used the static host name. */
export const startStaticStudio = startStudio;
