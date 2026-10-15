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
 * 2. its sandbox is live and its host epoch and pod are the token's (`EgressSandboxes.live`),
 *    else 407;
 * 3. the port is 443 or 80, the target is a host name and no IP literal, and it matches the spec's
 *    `network.allow` exactly or by `*.suffix`, else 403;
 * 4. the sandbox has fewer than `maxPerSandbox` tunnels open, else 429;
 * 5. the name resolves, and to at least one address that is not private, loopback, link-local
 *    (cloud metadata included), multicast or reserved, else 502 or 403;
 * 6. the gate connects to that checked address (never to the name again) and pipes.
 *
 * A tunnel is opaque bytes, with one exception (R2c, D50): port 443 of a host that an
 * `environment_secret` of a live session on the sandbox is bound to. There the gate terminates
 * TLS and sets the credential's header on every request (`egress-credentials.ts`), still sending
 * only to the checked address. Every other host gets the tunnel. Any other request
 * (an absolute-form plain HTTP request included) is answered 405. Refusals are logged; the token
 * never is. Tunnels close after `idleMs` without traffic in either direction.
 *
 * Every connection to a named host on a live token is recorded once (R7.3, D67), when it closes
 * or at once when the gate refuses it, as `environment.egress` on the Environment's own stream:
 * the connection is the Environment's, since its token names the pod and turns run in parallel
 * (D66). `runningTurns` lists the turns active on the Environment as it opened, as context and
 * never as an owner: one read, started as the name resolves and never waited for, so a turn that
 * moves while it is in flight may show either way. Host, port, outcome, bytes, duration and, for a
 * credential host, the request count and credential ids; never a header value, a path or a body. A refusal
 * before that (no token, a stale one, no `host:port`) stays a log line, and a client that hangs up
 * before the gate answers leaves nothing. A write never holds the tunnel up, and a failed one is
 * logged (`egress_record_failed`).
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { BlockList, connect, isIP, type AddressInfo, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { EgressRunningTurn, EnvironmentEventPayload } from "@nylorun/core/contracts";
import { isSandboxHostPattern } from "@nylorun/core/define";
import type { EgressTokenVerdict } from "../sandbox/egress-token.js";
import type { SessionStore } from "../store/types.js";
import { isPrivateAddress } from "../tenant/outbound.js";
import type { Logger } from "../tenant/types.js";
import { bindListener } from "../host/http.js";
import {
  CONNECT_ESTABLISHED,
  credentialTerminator,
  type EgressCredentials,
  type EgressTally,
} from "./egress-credentials.js";

/**
 * What egress-gate reads of a sandbox: its current host epoch, the pod that joined at it, and
 * its spec's `network.allow`; `undefined` when it is gone, deleted, lost, expired or not a pod.
 */
export interface EgressSandboxes {
  live(sandboxId: string): Promise<
    | { readonly epoch: number; readonly podUid?: string; readonly allow: readonly string[] }
    | undefined
  >;
}

/** One connection's record (R7.3, D67): `environment.egress`'s payload. */
export type EgressConnection = EnvironmentEventPayload<"environment.egress">;

/** How many running turns one connection names, at most. */
export const EGRESS_RUNNING_TURNS_MAX = 16;

/** Where egress-gate records connections (R7.3, D67). */
export interface EgressRecord {
  /** The turns active on the Environment now, at most `EGRESS_RUNNING_TURNS_MAX`. */
  runningTurns(environmentId: string): Promise<readonly EgressRunningTurn[]>;
  /** Writes `connection` to its Environment's stream; a deleted Environment gets nothing. */
  write(connection: EgressConnection): Promise<void>;
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
  /** The vault and keys, for hosts an `environment_secret` is bound to (R2c). None: tunnels only. */
  readonly credentials?: EgressCredentials;
  /** Where connections are recorded (R7.3). None: they are only logged. */
  readonly record?: EgressRecord;
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

/**
 * One connection's record (R7.3): written once, at a refusal or at the close, after the answer
 * and off the tunnel's path. The running turns are read once, started when `opened()` is first
 * called, as the connection opens, and kept for the write; the tunnel never waits for the read.
 */
interface ConnectionRecord {
  opened(): void;
  refused(status: number, reason: string): void;
  closed(tally?: EgressTally): void;
  /** A host an `environment_secret` is bound to: the gate terminates TLS (R2c). */
  credentialBound: boolean;
}

function connectionRecord(
  sink: EgressRecord | undefined,
  logger: Logger,
  client: Duplex,
  at: {
    readonly environmentId: string;
    readonly host: string;
    readonly port: number;
    /** The gate's clock at CONNECT. */
    readonly startedAt: Date;
    /** The client socket's `bytesRead` when the tunnel's bytes start. */
    readonly upFrom: number;
  },
): ConnectionRecord {
  let running: Promise<readonly EgressRunningTurn[]> | undefined;
  let written = false;
  const runningTurns = (to: EgressRecord) => (running ??= to.runningTurns(at.environmentId));
  const write = (fields: Pick<EgressConnection, "outcome" | "reason" | "status" | "requests" | "credentialIds">) => {
    if (written || !sink) return;
    written = true;
    const socket = client as Partial<Socket>;
    const allowed = fields.outcome === "allowed";
    const durationMs = Math.max(0, Date.now() - at.startedAt.getTime());
    const connection = (turns: readonly EgressRunningTurn[]): EgressConnection => ({
      environmentId: at.environmentId,
      host: at.host,
      port: at.port,
      ...fields,
      mode: record.credentialBound ? "credential" : "tunnel",
      credentialBound: record.credentialBound,
      // Up is what the sandbox sent after its CONNECT, down what it got after the gate's 200.
      bytesUp: allowed ? Math.max(0, (socket.bytesRead ?? 0) - at.upFrom) : 0,
      bytesDown: allowed ? Math.max(0, (socket.bytesWritten ?? 0) - CONNECT_ESTABLISHED.length) : 0,
      durationMs,
      startedAt: at.startedAt.toISOString(),
      runningTurns: [...turns],
    });
    runningTurns(sink)
      .then((turns) => sink.write(connection(turns)))
      .catch((error: unknown) =>
        logger.error("egress_record_failed", {
          sandboxId: at.environmentId,
          host: at.host,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
  };
  const record: ConnectionRecord = {
    credentialBound: false,
    // A failed read is logged when the write needs it.
    opened: () => void (sink && runningTurns(sink).catch(() => undefined)),
    refused: (status, reason) => write({ outcome: "refused", reason, status }),
    closed: (tally) =>
      write({
        outcome: "allowed",
        ...(tally ? { requests: tally.requests, credentialIds: [...tally.credentialIds] } : {}),
      }),
  };
  return record;
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

  const terminator = options.credentials
    ? credentialTerminator({ credentials: options.credentials, logger, idleMs })
    : undefined;
  const open = new Map<string, Set<Duplex>>();
  const tunnels = new Set<Duplex>();
  /** Each connection's record, once its Environment and target are known. */
  const records = new WeakMap<Duplex, ConnectionRecord>();

  async function onConnect(req: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    const startedAt = new Date();
    // What the sandbox sent before the tunnel: its CONNECT, less the bytes after it (`head`).
    const upFrom = ((client as Partial<Socket>).bytesRead ?? 0) - head.length;
    const target = parseTarget(req.url);
    const refuse = (status: number, reason: string, fields: Record<string, unknown> = {}, message?: string) => {
      logger.warn("egress_refused", { status, reason, ...(target ? { host: target.host, port: target.port } : {}), ...fields });
      answer(client, status, message ?? reason, status === 407 ? ['proxy-authenticate: Basic realm="nylorun-egress"'] : []);
      records.get(client)?.refused(status, reason);
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
    if (sandbox.podUid !== undefined && sandbox.podUid !== verdict.claims.podUid)
      return refuse(407, "pod_stale", { sandboxId }, "the egress token was refused");
    if (!target) return refuse(403, "target_invalid", { sandboxId }, "CONNECT needs host:port");
    const { host, port } = target;
    const record = connectionRecord(options.record, logger, client, {
      environmentId: sandboxId,
      host,
      port,
      startedAt,
      upFrom,
    });
    records.set(client, record);
    if (!EGRESS_PORTS.includes(port))
      return refuse(403, "port_refused", { sandboxId }, `port ${port} is not allowed; tunnels open to 443 or 80 only`);
    if (isIP(host.replace(/^\[|\]$/g, "")) !== 0 || !isSandboxHostPattern(host) || host.startsWith("*."))
      return refuse(403, "not_a_host_name", { sandboxId }, `${host} is not a host name; IP literals are refused`);
    if (!egressAllows(host, sandbox.allow))
      return refuse(403, "host_not_allowed", { sandboxId }, `${host} is not in this sandbox's network.allow`);
    // The turns running on the Environment as the connection opens: the read starts as the
    // name resolves, and the 200 does not wait for it.
    record.opened();
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
    if (terminator && port === 443 && (await options.credentials!.bound(sandboxId, host))) {
      record.credentialBound = true;
      // A client that spoke before the 200 is not one this path serves.
      if (head.length > 0) return refuse(403, "early_data", { sandboxId }, "wait for the CONNECT answer before sending");
      const tally: EgressTally = { requests: 0, credentialIds: new Set() };
      client.once("close", () => record.closed(tally));
      return terminator.terminate(client, { sandboxId, host, addresses: allowed, tally });
    }
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
    client.on("close", () => {
      upstream.destroy();
      record.closed();
    });
    client.write(CONNECT_ESTABLISHED);
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
      records.get(client)?.refused(502, "egress_failed");
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
 * `EgressSandboxes` over the Tenant's `sandbox_resources` (one indexed read): a pod sandbox's
 * host epoch, the pod that joined at it and its spec's allowlist; nothing for a virtual
 * Environment, or one deleted or lost, as `staleHost` judges a host token.
 */
export function storeEgressSandboxes(store: SessionStore): EgressSandboxes {
  return {
    async live(sandboxId) {
      const sandbox = await store.tx((t) => t.environment(sandboxId));
      const pod = sandbox?.pod;
      if (!sandbox || sandbox.kind !== "pod" || !pod) return undefined;
      if (pod.desired === "deleted" || pod.observed === "lost") return undefined;
      return {
        epoch: pod.hostEpoch,
        ...(pod.podUid ? { podUid: pod.podUid } : {}),
        // The applied allowlist: a recipe change writes it at once (Q8).
        allow: sandbox.applied.network?.allowedHosts ?? [],
      };
    },
  };
}

/**
 * `EgressRecord` over the Tenant's record (R7.3, D67). The running turns are the sessions on the
 * Environment whose body has an `activeTurnId`, in id order, at most `EGRESS_RUNNING_TURNS_MAX`.
 * The write is `environment.egress` on the Environment's stream, under its row's lock; a deleted
 * Environment gets nothing.
 */
export function storeEgressRecord(store: SessionStore): EgressRecord {
  return {
    async runningTurns(environmentId) {
      const sessions = await store.tx((t) => t.sessionsOnEnvironment(environmentId));
      return sessions
        .filter((session) => typeof session.activeTurnId === "string")
        .map((session) => ({ sessionId: session.id, turnId: session.activeTurnId as string }))
        .sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0))
        .slice(0, EGRESS_RUNNING_TURNS_MAX);
    },
    async write(connection) {
      await store.tx(async (t) => {
        if (!(await t.environment(connection.environmentId, { lock: true }))) return;
        await t.environmentEvent(connection.environmentId, "environment.egress", connection);
      });
    },
  };
}
