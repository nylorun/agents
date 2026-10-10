/**
 * egress-gate's credential path (R2c, D50): how a skill's CLI authenticates while the secret
 * stays out of the sandbox. A CONNECT to port 443 of a host that an `environment_secret` of a
 * live session on the sandbox is bound to (`allowedHosts`) is not tunnelled: the gate answers
 * 200, terminates TLS with a fresh leaf for that host signed by the installation's egress CA
 * (keys holds its key; the pod trusts its certificate, `harness/pod.ts`), and reads HTTP/1.1
 * requests. For each request it reads the vault (one Postgres query, no cache, so a rotation
 * applies to the next request), sets the credential's header (replacing any of that name, such
 * as the `nylorun-managed` sentinel the CLI sent), and forwards it over TLS to the address the
 * gate already checked, verifying the host's certificate by name against the public roots.
 *
 * Nothing here knows a tool: the header name and its format are the credential's. A release the
 * vault refuses (two secrets for one host, an unreadable value) answers 502 and is logged, never
 * as an event; a value never is. Upgrades (WebSocket) and HTTP/2 are not served on this path.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Agent, request } from "node:https";
import type { LookupFunction, Socket } from "node:net";
import type { Duplex } from "node:stream";
import { createSecureContext, TLSSocket } from "node:tls";
import type { Logger } from "../tenant/types.js";

/** What the vault answers for one request to a host a credential may be bound to. */
export type EgressCredentialRelease =
  | { readonly status: "none" }
  | { readonly status: "released"; readonly header: string; readonly value: string; readonly credentialId: string }
  | { readonly status: "refused"; readonly reason: string };

export interface EgressCredentials {
  /** Whether an `environment_secret` of a live session on the sandbox is bound to `host`. */
  bound(sandboxId: string, host: string): Promise<boolean>;
  /** The header to set on one request, read from the vault each time. */
  release(sandboxId: string, host: string): Promise<EgressCredentialRelease>;
  /** A fresh leaf for `host`: its key, made here, and its certificate, signed by keys. */
  leaf(host: string): Promise<{ readonly key: string; readonly cert: string }>;
  /** Tests: the CA upstream servers are verified against, instead of the public roots. */
  readonly upstreamCa?: string;
  /** Tests: the port requests are sent to, instead of 443. */
  readonly upstreamPort?: number;
}

/** Headers that describe one hop and are never forwarded. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

interface Terminated {
  readonly sandboxId: string;
  readonly host: string;
  readonly agent: Agent;
}

/** `rawHeaders` without hop-by-hop headers and `drop`, as lowercase names to values. */
function forwardable(raw: readonly string[], drop?: string): Record<string, string[]> {
  const headers: Record<string, string[]> = {};
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i]!.toLowerCase();
    if (HOP_BY_HOP.has(name) || name === drop) continue;
    (headers[name] ??= []).push(raw[i + 1]!);
  }
  return headers;
}

function reply(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = `egress-gate: ${message}\n`;
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

export interface CredentialTerminator {
  /**
   * Answers the CONNECT, terminates TLS for `host` and serves its requests, sending each to one
   * of `addresses` (already checked) and nowhere else.
   */
  terminate(
    client: Duplex,
    target: {
      readonly sandboxId: string;
      readonly host: string;
      readonly addresses: readonly { address: string; family: number }[];
    },
  ): Promise<void>;
}

export function credentialTerminator(options: {
  readonly credentials: EgressCredentials;
  readonly logger: Logger;
  readonly idleMs: number;
}): CredentialTerminator {
  const { credentials, logger } = options;
  const terminated = new WeakMap<Socket, Terminated>();

  const http = createServer((req, res) => {
    forward(req, res).catch((error: unknown) => {
      logger.error("egress_forward_failed", { error: error instanceof Error ? error.message : String(error) });
      reply(res, 502, "the request failed");
    });
  });
  http.keepAliveTimeout = options.idleMs;
  http.headersTimeout = 60_000;
  // Uploads may be long; the client socket's idle timeout still applies.
  http.requestTimeout = 0;
  http.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
    const at = terminated.get(req.socket as Socket);
    logger.warn("egress_refused", { status: 501, reason: "upgrade_refused", sandboxId: at?.sandboxId, host: at?.host });
    socket.destroy();
  });
  http.on("clientError", (_error, socket) => socket.destroy());

  async function forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const at = terminated.get(req.socket as Socket);
    if (!at) {
      res.destroy();
      return;
    }
    const { sandboxId, host } = at;
    const release = await credentials.release(sandboxId, host);
    if (release.status === "refused") {
      logger.warn("egress_credential_refused", { status: 502, reason: release.reason, sandboxId, host });
      req.resume();
      return reply(res, 502, `the credential for ${host} could not be used`);
    }
    const header = release.status === "released" ? release.header.toLowerCase() : undefined;
    const headers = forwardable(req.rawHeaders, header);
    if (release.status === "released") headers[header!] = [release.value];
    const upstream = request({
      host,
      port: credentials.upstreamPort ?? 443,
      servername: host,
      method: req.method,
      path: req.url,
      headers,
      agent: at.agent,
    });
    upstream.on("response", (response) => {
      res.writeHead(response.statusCode ?? 502, response.statusMessage, forwardable(response.rawHeaders));
      response.pipe(res);
      response.on("error", () => res.destroy());
    });
    upstream.on("error", (error: NodeJS.ErrnoException) => {
      logger.warn("egress_upstream_failed", { status: 502, sandboxId, host, code: error.code });
      reply(res, 502, `could not reach ${host}`);
    });
    req.on("error", () => upstream.destroy());
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  }

  return {
    async terminate(client, target) {
      const { sandboxId, host, addresses } = target;
      const leaf = await credentials.leaf(host);
      if (client.destroyed) return;
      // Requests go to the addresses the gate checked, never to the name resolved again.
      const lookup: LookupFunction = (_name, lookupOptions, callback) => {
        if (lookupOptions.all) (callback as (e: null, a: typeof addresses) => void)(null, addresses);
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      };
      const agent = new Agent({
        keepAlive: true,
        maxSockets: 8,
        lookup,
        ...(credentials.upstreamCa ? { ca: credentials.upstreamCa } : {}),
      });
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const tls = new TLSSocket(client as Socket, {
        isServer: true,
        secureContext: createSecureContext({ key: leaf.key, cert: leaf.cert }),
        ALPNProtocols: ["http/1.1"],
      });
      terminated.set(tls, { sandboxId, host, agent });
      tls.on("error", () => tls.destroy());
      tls.on("close", () => {
        agent.destroy();
        client.destroy();
      });
      logger.info("egress_terminated", { sandboxId, host });
      http.emit("connection", tls);
    },
  };
}
