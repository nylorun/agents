/**
 * egress-gate (F7.2, D42): the only way out of a pod sandbox to the internet. A CONNECT proxy in
 * the gateway (`--service egress`, port 4200) that opens a TCP tunnel to a host the sandbox's spec
 * allows (`network.allow`), and nothing else. Pods reach it through `HTTPS_PROXY`/`HTTP_PROXY`
 * with their egress token as the proxy credential; NetworkPolicy lets them reach nothing but this
 * listener, the gates and the Harness API.
 *
 * Every CONNECT, in order:
 * 1. the egress token from `Proxy-Authorization` (Basic with the token as password, as tools send
 *    proxy userinfo, or Bearer) verifies (`verifyEgressToken`), else 407;
 * 2. its sandbox is live and its host epoch is the token's (`EgressSandboxes.live`), else 407;
 * 3. the port is 443 or 80, the target is a host name and no IP literal, and it matches the spec's
 *    `network.allow` exactly or by `*.suffix`, else 403;
 * 4. the sandbox has fewer than `maxPerSandbox` tunnels open, else 429;
 * 5. the name resolves, and to at least one address that is not private, loopback, link-local
 *    (cloud metadata included), multicast or reserved, else 502 or 403;
 * 6. the gate connects to that checked address (never to the name again) and pipes.
 *
 * No TLS interception and no credential injection: a tunnel is opaque bytes. Any other request
 * (an absolute-form plain HTTP request included) is answered 405. Refusals are logged, never as
 * events; the token never is. Tunnels close after `idleMs` without traffic in either direction.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { BlockList, connect, isIP, type AddressInfo, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { isSandboxHostPattern } from "@nylorun/core/define";
import type { EgressTokenVerdict } from "../sandbox/egress-token.js";
import type { SessionStore } from "../store/types.js";
import { isPrivateAddress } from "../tenant/outbound.js";
import type { Logger } from "../tenant/types.js";
import { bindListener } from "../host/http.js";

/**
 * What egress-gate reads of a sandbox: its current host epoch and its spec's `network.allow`, or
 * `undefined` when it is gone, lost or not a pod. Pods record their host epoch at join.
 */
export interface EgressSandboxes {
  live(sandboxId: string): Promise<{ readonly epoch: number; readonly allow: readonly string[] } | undefined>;
}

/** Ports a tunnel may open. */
export const EGRESS_PORTS: readonly number[] = [443, 80];
/** Tunnels one sandbox may hold open at once. */
export const EGRESS_MAX_PER_SANDBOX = 64;
/** A tunnel with no traffic either way for this long is closed. */
export const EGRESS_IDLE_MS = 5 * 60_000;
/** How long a sandbox's epoch and allowlist are reused before they are read again. */
export const EGRESS_CACHE_MS = 5_000;
/** How long the gate waits for the upstream connection. */
export const EGRESS_CONNECT_TIMEOUT_MS = 10_000;

export interface StartEgressGateOptions {
  readonly listen: { readonly host: string; readonly port: number };
  readonly logger: Logger;
  /** Verifies a presented egress token (`verifyEgressToken` over the Tenant's keys). */
  verify(raw: string): Promise<EgressTokenVerdict>;
  readonly sandboxes: EgressSandboxes;
  readonly idleMs?: number;
  readonly maxPerSandbox?: number;
  readonly cacheMs?: number;
  readonly connectTimeoutMs?: number;
  /** Tests replace name resolution. */
  readonly lookup?: (host: string) => Promise<readonly { address: string; family: number }[]>;
  /** Tests replace which resolved addresses are refused. Default `isEgressBlocked`. */
  readonly blocked?: (address: string) => boolean;
  /** Tests replace how the checked address is dialled. */
  readonly dial?: (address: string, port: number) => Socket;
}

export interface EgressGate {
  /** Where the gate listens, e.g. `http://0.0.0.0:4200`. */
  readonly url: string;
  readonly server: Server;
  close(): Promise<void>;
}

/** Ranges beyond `isPrivateAddress`'s that a tunnel never reaches. */
const RESERVED = new BlockList();
for (const [network, prefix] of [
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
] as const)
  RESERVED.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["64:ff9b::", 96], // NAT64: would reach any IPv4 address
  ["64:ff9b:1::", 48],
  ["100::", 64], // discard
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["ff00::", 8], // multicast
] as const)
  RESERVED.addSubnet(network, prefix, "ipv6");

/**
 * True when a tunnel must not reach `address`: private, loopback, link-local (169.254.169.254, the
 * cloud metadata address, included), unspecified, multicast, reserved, or an IPv6 form that
 * embeds an IPv4 address.
 */
export function isEgressBlocked(address: string): boolean {
  if (isPrivateAddress(address)) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return RESERVED.check(mapped[1]!, "ipv4");
  const family = isIP(address);
  if (family === 0) return true;
  return RESERVED.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** Whether `host` (a lowercase name) matches one of `allow`'s names or `*.suffix` patterns. */
export function egressAllows(host: string, allow: readonly string[]): boolean {
  for (const entry of allow) {
    const pattern = entry.toLowerCase();
    if (pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : host === pattern) return true;
  }
  return false;
}

/** The egress token in a `Proxy-Authorization` header, or `undefined`. */
export function proxyToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^(basic|bearer)\s+(\S+)\s*$/i.exec(header);
  if (!match) return undefined;
  if (match[1]!.toLowerCase() === "bearer") return match[2];
  const decoded = Buffer.from(match[2]!, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  // userinfo `x:<token>@`; a bare `<token>@` arrives as the user with no password.
  const token = colon === -1 ? decoded : decoded.slice(colon + 1) || decoded.slice(0, colon);
  return token === "" ? undefined : token;
}

/** `host:port` of a CONNECT request target, lowercase, without a trailing root dot. */
function parseTarget(target: string | undefined): { host: string; port: number } | undefined {
  const match = /^(\[[^\]]*\]|[^:[\]]+):(\d{1,5})$/.exec(target ?? "");
  if (!match) return undefined;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return undefined;
  return { host: match[1]!.toLowerCase().replace(/\.$/, ""), port };
}

const REASONS: Record<number, string> = {
  403: "Forbidden",
  405: "Method Not Allowed",
  407: "Proxy Authentication Required",
  429: "Too Many Requests",
  502: "Bad Gateway",
};

function answer(socket: Duplex, status: number, message: string, headers: string[] = []): void {
  const body = `egress-gate: ${message}\n`;
  if (socket.destroyed) return;
  socket.end(
    [
      `HTTP/1.1 ${status} ${REASONS[status] ?? "Error"}`,
      "content-type: text/plain; charset=utf-8",
      `content-length: ${Buffer.byteLength(body)}`,
      "connection: close",
      ...headers,
      "",
      body,
    ].join("\r\n"),
  );
}

export async function startEgressGate(options: StartEgressGateOptions): Promise<EgressGate> {
  const { logger, sandboxes } = options;
  const idleMs = options.idleMs ?? EGRESS_IDLE_MS;
  const maxPerSandbox = options.maxPerSandbox ?? EGRESS_MAX_PER_SANDBOX;
  const cacheMs = options.cacheMs ?? EGRESS_CACHE_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? EGRESS_CONNECT_TIMEOUT_MS;
  const blocked = options.blocked ?? isEgressBlocked;
  const lookup =
    options.lookup ?? ((host: string) => dnsLookup(host, { all: true, verbatim: true }));
  const dial = options.dial ?? ((address: string, port: number) => connect({ host: address, port }));

  const cache = new Map<string, { at: number; value: Awaited<ReturnType<EgressSandboxes["live"]>> }>();
  /** The sandbox as of at most `cacheMs` ago; read again when the token names a newer epoch. */
  async function live(sandboxId: string, epoch: number) {
    const cached = cache.get(sandboxId);
    if (cached && Date.now() - cached.at < cacheMs && cached.value && cached.value.epoch >= epoch)
      return cached.value;
    const value = await sandboxes.live(sandboxId);
    cache.set(sandboxId, { at: Date.now(), value });
    if (cache.size > 4096) cache.delete(cache.keys().next().value!);
    return value;
  }

  const open = new Map<string, Set<Duplex>>();
  const tunnels = new Set<Duplex>();

  async function onConnect(req: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    const target = parseTarget(req.url);
    const refuse = (status: number, reason: string, fields: Record<string, unknown> = {}, message?: string) => {
      logger.warn("egress_refused", { status, reason, ...(target ? { host: target.host, port: target.port } : {}), ...fields });
      answer(client, status, message ?? reason, status === 407 ? ['proxy-authenticate: Basic realm="nylorun-egress"'] : []);
    };
    const raw = proxyToken(req.headers["proxy-authorization"]);
    if (!raw) return refuse(407, "egress_token_missing", {}, "an egress token is required");
    const verdict = await options.verify(raw);
    if (!verdict.ok) return refuse(407, verdict.reason, {}, "the egress token was refused");
    const { sandboxId, epoch } = verdict.claims;
    const sandbox = await live(sandboxId, epoch);
    if (!sandbox) return refuse(407, "sandbox_gone", { sandboxId }, "the egress token was refused");
    if (sandbox.epoch !== epoch)
      return refuse(407, "epoch_stale", { sandboxId, epoch, current: sandbox.epoch }, "the egress token was refused");
    if (!target) return refuse(403, "target_invalid", { sandboxId }, "CONNECT needs host:port");
    const { host, port } = target;
    if (!EGRESS_PORTS.includes(port))
      return refuse(403, "port_refused", { sandboxId }, `port ${port} is not allowed; tunnels open to 443 or 80 only`);
    if (isIP(host.replace(/^\[|\]$/g, "")) !== 0 || !isSandboxHostPattern(host) || host.startsWith("*."))
      return refuse(403, "not_a_host_name", { sandboxId }, `${host} is not a host name; IP literals are refused`);
    if (!egressAllows(host, sandbox.allow))
      return refuse(403, "host_not_allowed", { sandboxId }, `${host} is not in this sandbox's network.allow`);
    let mine = open.get(sandboxId);
    if (!mine) open.set(sandboxId, (mine = new Set()));
    if (mine.size >= maxPerSandbox)
      return refuse(429, "too_many_tunnels", { sandboxId }, `this sandbox has ${maxPerSandbox} tunnels open`);
    const slot = mine;
    slot.add(client);
    tunnels.add(client);
    const release = () => {
      slot.delete(client);
      tunnels.delete(client);
      if (slot.size === 0 && open.get(sandboxId) === slot) open.delete(sandboxId);
    };
    client.once("close", release);
    let addresses: readonly { address: string; family: number }[];
    try {
      addresses = await lookup(host);
    } catch (error) {
      return refuse(502, "resolve_failed", { sandboxId, code: (error as NodeJS.ErrnoException).code }, `${host} does not resolve`);
    }
    const allowed = addresses.filter((entry) => !blocked(entry.address));
    if (allowed.length === 0)
      return refuse(403, "address_refused", { sandboxId }, `${host} resolves only to addresses tunnels may not reach`);
    if (client.destroyed) return;
    const upstream = await dialFirst(allowed.map((entry) => entry.address), port);
    if (!upstream) return refuse(502, "connect_failed", { sandboxId }, `could not connect to ${host}:${port}`);
    if (client.destroyed) {
      upstream.destroy();
      return;
    }
    upstream.setTimeout(idleMs);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    upstream.on("timeout", close);
    upstream.on("error", close);
    upstream.on("close", () => client.destroy());
    client.on("close", () => upstream.destroy());
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  }

  /** Connects to the first of `addresses` that answers within the connect timeout. */
  async function dialFirst(addresses: readonly string[], port: number): Promise<Socket | undefined> {
    for (const address of addresses) {
      const socket = await new Promise<Socket | undefined>((resolve) => {
        const attempt = dial(address, port);
        const timer = setTimeout(() => {
          attempt.destroy();
          resolve(undefined);
        }, connectTimeoutMs);
        attempt.once("connect", () => {
          clearTimeout(timer);
          attempt.removeAllListeners("error");
          resolve(attempt);
        });
        attempt.once("error", () => {
          clearTimeout(timer);
          attempt.destroy();
          resolve(undefined);
        });
      });
      if (socket) return socket;
    }
    return undefined;
  }

  const server = createServer((req, res) => {
    logger.warn("egress_refused", { status: 405, reason: "not_connect", method: req.method });
    res.writeHead(405, { allow: "CONNECT", "content-type": "text/plain; charset=utf-8", connection: "close" });
    res.end("egress-gate: only CONNECT is served; set HTTPS_PROXY and HTTP_PROXY to this address\n");
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.on("connect", (req: IncomingMessage, client: Duplex, head: Buffer) => {
    // A client socket: idle from the request on, through the tunnel's life.
    client.on("error", () => {});
    (client as Socket).setTimeout(idleMs);
    client.on("timeout", () => client.destroy());
    onConnect(req, client, head).catch((error: unknown) => {
      logger.error("egress_failed", { error: error instanceof Error ? error.message : String(error) });
      answer(client, 502, "the tunnel failed");
    });
  });
  server.on("clientError", (_error, socket) => {
    if (!socket.destroyed) socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n");
  });
  await bindListener(server, options.listen.port, options.listen.host, (error) =>
    logger.error("listener_error", { error: error.message }),
  );
  const port = (server.address() as AddressInfo).port;
  const host = options.listen.host.includes(":") ? `[${options.listen.host}]` : options.listen.host;
  let closing: Promise<void> | undefined;
  return {
    url: `http://${host}:${port}`,
    server,
    close() {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const tunnel of tunnels) tunnel.destroy();
        server.closeAllConnections();
      });
      return closing;
    },
  };
}

/**
 * `EgressSandboxes` over the Tenant's `sandbox_resources`: a pod sandbox's spec allowlist and its
 * host epoch. The host epoch and the lost state are recorded when pods join (F7.2 pods); a row
 * without them reads as epoch 0, which no egress token carries, so its tokens are refused.
 */
export function storeEgressSandboxes(store: SessionStore): EgressSandboxes {
  return {
    async live(sandboxId) {
      const sandbox = await store.tx((t) => t.sandboxResource(sandboxId));
      if (!sandbox || sandbox.kind !== "pod") return undefined;
      return { epoch: 0, allow: sandbox.spec.network?.allow ?? [] };
    },
  };
}
