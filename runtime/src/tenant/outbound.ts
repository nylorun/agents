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
  if (policy.loopback === "docker-host" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    url.hostname = "host.docker.internal";
  const lookup = (
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
