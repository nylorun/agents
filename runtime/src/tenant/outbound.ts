/**
 * The Runtime's requests to Action endpoints (design: Action endpoints §8.3): one POST, no
 * redirects, a bounded answer, and the Host's address policy checked on the address actually
 * connected to, so a DNS answer cannot steer a delivery somewhere the Host forbids.
 *
 * The result says whether anything reached the endpoint. A request that failed before its body
 * was flushed (refused connection, unknown host, TLS failure, a refused address) was `not_sent`
 * and is safe to send again, even for a tool; one that failed after (reset, timeout) is `lost`.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";

/** How the Host lets the Runtime call developer URLs (Host settings, `TenantConfig.delivery`). */
export interface OutboundPolicy {
  /** `http` URLs as well as `https`. Default true (OSS). */
  allowHttp?: boolean;
  /** Private, loopback and link-local addresses. Default `allow` (OSS); Cloud refuses. */
  privateAddresses?: "allow" | "refuse";
  /**
   * `docker-host`: the Runtime runs in the local stack's container, so `localhost`,
   * `127.0.0.1` and `[::1]` mean the machine that runs Docker (`host.docker.internal`).
   */
  loopback?: "docker-host";
}

export type OutboundResult =
  | { kind: "response"; status: number; headers: IncomingHttpHeaders; body: Buffer }
  /** The answer was larger than `maxResponseBytes`. */
  | { kind: "too_large"; status: number }
  | { kind: "not_sent"; code: string; message: string }
  | { kind: "lost"; code: string; message: string };

/** The largest answer read from an endpoint. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const PRIVATE = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const)
  PRIVATE.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
] as const)
  PRIVATE.addSubnet(network, prefix, "ipv6");

/** True when `address` is private, loopback, link-local or unspecified (IPv4-mapped included). */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return PRIVATE.check(mapped[1]!, "ipv4");
  const family = isIP(address);
  if (family === 0) return false;
  return PRIVATE.check(address, family === 4 ? "ipv4" : "ipv6");
}

class RefusedAddress extends Error {
  readonly code = "ENDPOINT_ADDRESS_REFUSED";
}

/** Why the Host refuses `url`, or `undefined` when it may be called. */
export function refusal(url: URL, policy: OutboundPolicy): string | undefined {
  if (url.protocol !== "https:" && !(url.protocol === "http:" && policy.allowHttp !== false))
    return `This Runtime calls only ${policy.allowHttp === false ? "https" : "http and https"} endpoints`;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (policy.privateAddresses === "refuse" && isIP(host) && isPrivateAddress(host))
    return "This Runtime does not call private addresses; expose the endpoint through a public URL (a tunnel, for a local app)";
  return undefined;
}

/** `localhost` means the machine that runs Docker (`OutboundPolicy.loopback`). */
function dockerHost(url: URL, policy: OutboundPolicy): void {
  if (policy.loopback === "docker-host" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    url.hostname = "host.docker.internal";
}

/** A DNS lookup that drops private answers when `policy` refuses them: checked on what is connected to. */
function guardedLookup(policy: OutboundPolicy) {
  return (
    hostname: string,
    lookupOptions: object,
    callback: (error: Error | null, address: string | LookupAddress[], family?: number) => void,
  ) =>
    dnsLookup(hostname, { ...lookupOptions, all: true }, (error, addresses) => {
      if (error) return callback(error, []);
      const allowed =
        policy.privateAddresses === "refuse"
          ? addresses.filter((a) => !isPrivateAddress(a.address))
          : addresses;
      if (allowed.length === 0)
        return callback(
          new RefusedAddress(
            `${hostname} resolves only to private addresses, which this Runtime does not call`,
          ),
          [],
        );
      if ((lookupOptions as { all?: boolean }).all) return callback(null, allowed);
      return callback(null, allowed[0]!.address, allowed[0]!.family);
    });
}

/** POSTs `body` to `url` under `policy`. Never throws; `signal` aborts the request. */
export async function post(
  target: string,
  body: string,
  headers: Record<string, string>,
  options: { policy: OutboundPolicy; signal: AbortSignal; maxResponseBytes?: number },
): Promise<OutboundResult> {
  const { policy, signal } = options;
  const limit = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const url = new URL(target);
  const refused = refusal(url, policy);
  if (refused) return { kind: "not_sent", code: "ENDPOINT_ADDRESS_REFUSED", message: refused };
  const originalHost = url.host;
  dockerHost(url, policy);
  const lookup = guardedLookup(policy);
  return new Promise<OutboundResult>((resolve) => {
    let sent = false;
    let settled = false;
    const finish = (result: OutboundResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const failed = (error: NodeJS.ErrnoException) =>
      finish({
        kind: sent ? "lost" : "not_sent",
        code: signal.aborted ? "ABORTED" : (error.code ?? error.name),
        message: signal.aborted ? "The delivery was aborted" : error.message,
      });
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "POST",
        headers: {
          ...headers,
          host: originalHost,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        },
        lookup: lookup as never,
        signal,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit) {
            // Settle first: destroying the answer reports an error of its own.
            finish({ kind: "too_large", status });
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          finish({ kind: "response", status, headers: response.headers, body: Buffer.concat(chunks) }),
        );
        response.on("error", failed);
        response.on("aborted", () => failed(Object.assign(new Error("The answer was cut off"), { code: "ECONNRESET" })));
      },
    );
    request.on("finish", () => {
      sent = true;
    });
    request.on("error", failed);
    request.end(body);
  });
}

/**
 * A refusal of `guardedFetch`: the Host's policy forbids the URL or every address it resolves
 * to. Not a `TypeError`, so callers that read a `TypeError` as a CORS failure (the MCP SDK's
 * discovery) see the refusal instead of trying again.
 */
export class OutboundRefused extends Error {
  readonly code = "ENDPOINT_ADDRESS_REFUSED";
  constructor(message: string) {
    super(message);
    this.name = "OutboundRefused";
  }
}

/** A request `guardedFetch` sent that failed: refused connection, reset, timeout, redirect. */
export class OutboundFailed extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "OutboundFailed";
  }
}

/** The largest answer `guardedFetch` reads. OAuth metadata and tokens are small. */
export const MAX_FETCH_RESPONSE_BYTES = 1024 * 1024;
/** How long a `guardedFetch` request may take without a signal of its own. */
export const FETCH_TIMEOUT_MS = 30_000;

/**
 * A `fetch` under the Host's address policy (F9 C2): the literal-IP and DNS checks of `post`
 * on the address actually connected to, `localhost` rewritten for the local stack, no
 * redirects (`redirect: "error"`; a 3xx answer rejects), a bounded answer and a 30 s timeout
 * unless the caller passes a signal. The gateway calls OAuth discovery, registration, the code
 * exchange and refresh with it. A refused URL or address rejects with `OutboundRefused`, any
 * other failure with `OutboundFailed`.
 *
 * `stream`: the Response resolves once the headers arrive and its body streams, unbounded and
 * with no timeout but the caller's signal: remote MCP servers, whose answers and event streams
 * stay open (`mcp/connect.ts`).
 */
export function guardedFetch(
  policy: OutboundPolicy,
  options: { maxResponseBytes?: number; timeoutMs?: number; stream?: boolean } = {},
): typeof fetch {
  const limit = options.maxResponseBytes ?? MAX_FETCH_RESPONSE_BYTES;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const stream = options.stream === true;
  const lookup = guardedLookup(policy);
  const guarded = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request ? request.url : String(input));
    const refused = refusal(url, policy);
    if (refused) throw new OutboundRefused(refused);
    const method = (init.method ?? request?.method ?? "GET").toUpperCase();
    const headers = new Headers(request?.headers);
    for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
    let body: Buffer | undefined;
    const source = init.body ?? (request && method !== "GET" && method !== "HEAD" ? await request.arrayBuffer() : undefined);
    if (source !== undefined && source !== null) {
      if (typeof source === "string") body = Buffer.from(source, "utf8");
      else if (source instanceof URLSearchParams) {
        body = Buffer.from(source.toString(), "utf8");
        if (!headers.has("content-type"))
          headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
      } else if (source instanceof ArrayBuffer) body = Buffer.from(source);
      else if (ArrayBuffer.isView(source))
        body = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
      else throw new OutboundFailed("guardedFetch sends only string, form or byte bodies", "UNSUPPORTED_BODY");
    }
    const originalHost = url.host;
    dockerHost(url, policy);
    const signal = init.signal ?? request?.signal ?? (stream ? undefined : AbortSignal.timeout(timeoutMs));
    const outgoing: Record<string, string> = { host: originalHost };
    for (const [name, value] of headers) outgoing[name] = value;
    if (body) outgoing["content-length"] = String(body.byteLength);
    return await new Promise<Response>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      const failed = (error: NodeJS.ErrnoException) =>
        settle(() =>
          reject(
            error instanceof RefusedAddress
              ? new OutboundRefused(error.message)
              : new OutboundFailed(
                  signal?.aborted ? `The request to ${originalHost} was aborted or timed out` : error.message,
                  signal?.aborted ? "ABORTED" : (error.code ?? error.name),
                ),
          ),
        );
      const sent = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        { method, headers: outgoing, lookup: lookup as never, ...(signal ? { signal } : {}) },
        (response) => {
          const status = response.statusCode ?? 0;
          if (status >= 300 && status < 400 && response.headers.location !== undefined) {
            response.resume();
            return settle(() =>
              reject(new OutboundFailed(`${originalHost} answered a redirect, which this Runtime does not follow`, "REDIRECT")),
            );
          }
          const noBody = status === 204 || status === 304 || method === "HEAD";
          const answer = (body: BodyInit | null) => {
            const headers = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (value === undefined) continue;
              for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
            }
            return new Response(noBody ? null : body, {
              status,
              statusText: response.statusMessage ?? "",
              headers,
            });
          };
          if (stream) {
            // A failure after this reaches the reader as the body's error.
            if (noBody) response.resume();
            return settle(() => resolve(answer(noBody ? null : (Readable.toWeb(response) as ReadableStream))));
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > limit) {
              settle(() =>
                reject(new OutboundFailed(`The answer from ${originalHost} is larger than ${limit} bytes`, "TOO_LARGE")),
              );
              response.destroy();
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => settle(() => resolve(answer(Buffer.concat(chunks)))));
          response.on("error", failed);
          response.on("aborted", () =>
            failed(Object.assign(new Error("The answer was cut off"), { code: "ECONNRESET" })),
          );
        },
      );
      sent.on("error", failed);
      sent.end(body);
    });
  };
  return guarded as typeof fetch;
}
