/**
 * egress-gate's credential path (R2c, D50): how a skill's CLI authenticates while the secret
 * stays out of the sandbox. A CONNECT to port 443 of a host that an `environment_secret` of a
 * live session on the sandbox is bound to (`allowedHosts`) is not tunnelled: the gate answers
 * 200, terminates TLS with a fresh leaf for that host signed by the installation's egress CA
 * (keys holds its key; the pod trusts its certificate, `harness/pod.ts`), and reads HTTP/1.1
 * requests. For each request it reads the vault (one Postgres query, no cache, so a rotation
 * applies to the next request), sets the credential's header (replacing any of that name, such
 * as the `nylorun_managed` sentinel the CLI sent), and forwards it over TLS to the address the
 * gate already checked, verifying the host's certificate by name against the public roots.
 *
 * Nothing here knows a tool: the header name and its format are the credential's. A release the
 * vault refuses (two secrets for one host, an unreadable value) answers 502 and is logged, never
 * as an event; a value never is. Upgrades (WebSocket) and HTTP/2 are not served on this path.
 * Each connection keeps a tally for its `agent.egress` event (R7.3, D67): how many requests it
 * read and which credentials it set, by id.
 *
 * A host the outside credential provider lists (`credential-provider.ts`) and the vault does not
 * bind is terminated the same way, but its requests go to the provider's forward route instead:
 * `<provider>/v1/forward<path and query>`, with every header the sandbox sent (its own
 * `Authorization` or inject header included, for the provider to replace) but `host` and any
 * `nylorun-provider-*`, plus the engine's `nylorun-provider-host`, `-agent`, `-owner` and
 * `-token`. Bodies stream both ways; the tally counts the requests, with no credential id.
 */
import { Agent as HttpAgent, createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { Agent, request } from "node:https";
import type { LookupFunction, Socket } from "node:net";
import type { Duplex } from "node:stream";
import { createSecureContext, TLSSocket } from "node:tls";
import type { Logger } from "../tenant/types.js";
import { hostTuning } from "../tuning.js";
import { HOP_BY_HOP_HEADERS } from "../vault/headers.js";
import { PROVIDER_HEADER_PREFIX, type CredentialProvider } from "./credential-provider.js";

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

/** The answer to a CONNECT the gate serves; a tunnel's byte counts leave it out. */
export const CONNECT_ESTABLISHED = "HTTP/1.1 200 Connection Established\r\n\r\n";

/** What one terminated connection did so far (R7.3): requests read, credentials set (ids). */
export interface EgressTally {
  requests: number;
  readonly credentialIds: Set<string>;
}


/** The Agent a provider host's requests are handed on for, and its owner. */
export interface ProviderRoute {
  readonly agentId: string;
  readonly owner: string;
}

interface Terminated {
  readonly sandboxId: string;
  readonly host: string;
  readonly agent: Agent;
  readonly tally: EgressTally;
  /** Set for a host the credential provider lists: its requests go to the provider. */
  readonly provider?: ProviderRoute;
}

/** `rawHeaders` without hop-by-hop headers and those `drop` matches, as lowercase names to values. */
function forwardable(raw: readonly string[], drop?: string | ((name: string) => boolean)): Record<string, string[]> {
  const headers: Record<string, string[]> = {};
  const dropped = typeof drop === "function" ? drop : (name: string) => name === drop;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i]!.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(name) || dropped(name)) continue;
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
      /** Counted as requests are served, read when the connection closes. */
      readonly tally: EgressTally;
      /** A host the credential provider lists: its requests go to the provider's forward route. */
      readonly provider?: ProviderRoute;
    },
  ): Promise<void>;
  /** Closes the kept-alive connections to the credential provider. */
  close(): void;
}

export function credentialTerminator(options: {
  readonly credentials: EgressCredentials;
  readonly logger: Logger;
  readonly idleMs: number;
  /** The outside credential provider, for hosts it lists. */
  readonly provider?: CredentialProvider;
}): CredentialTerminator {
  const { credentials, logger, provider } = options;
  const terminated = new WeakMap<Socket, Terminated>();
  // One kept-alive pool to the provider, shared by every terminated connection.
  const providerAgent = provider
    ? new URL(provider.url).protocol === "https:"
      ? new Agent({ keepAlive: true })
      : new HttpAgent({ keepAlive: true })
    : undefined;

  const http = createServer((req, res) => {
    forward(req, res).catch((error: unknown) => {
      logger.error("egress_forward_failed", { error: error instanceof Error ? error.message : String(error) });
      reply(res, 502, "the request failed");
    });
  });
  http.keepAliveTimeout = options.idleMs;
  http.headersTimeout = hostTuning().egress.credentialsHeadersTimeoutMs;
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
    at.tally.requests += 1;
    if (at.provider && provider) return handOn(req, res, at, at.provider, provider);
    const release = await credentials.release(sandboxId, host);
    if (release.status === "refused") {
      logger.warn("egress_credential_refused", { status: 502, reason: release.reason, sandboxId, host });
      req.resume();
      return reply(res, 502, `the credential for ${host} could not be used`);
    }
    const header = release.status === "released" ? release.header.toLowerCase() : undefined;
    const headers = forwardable(req.rawHeaders, header);
    if (release.status === "released") {
      headers[header!] = [release.value];
      at.tally.credentialIds.add(release.credentialId);
    }
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

  /**
   * One request of a provider host, handed to the provider's forward route as the sandbox sent
   * it: its own headers stay (the provider replaces the bound one), `host` and any
   * `nylorun-provider-*` it sent go, and the engine's provider headers are set.
   */
  function handOn(req: IncomingMessage, res: ServerResponse, at: Terminated, route: ProviderRoute, to: CredentialProvider): void {
    const { sandboxId, host } = at;
    if (!req.url?.startsWith("/")) {
      req.resume();
      return reply(res, 400, "requests on this connection name a path");
    }
    const target = to.forwardUrl(req.url);
    const headers = forwardable(req.rawHeaders, (name) => name === "host" || name.startsWith(PROVIDER_HEADER_PREFIX));
    for (const [name, value] of Object.entries(to.forwardHeaders({ host, agentId: route.agentId, owner: route.owner })))
      headers[name] = [value];
    const upstream =
      target.protocol === "https:"
        ? request(target, { method: req.method, headers, agent: providerAgent as Agent })
        : httpRequest(target, { method: req.method, headers, agent: providerAgent as HttpAgent });
    upstream.on("response", (response) => {
      res.writeHead(response.statusCode ?? 502, response.statusMessage, forwardable(response.rawHeaders));
      response.pipe(res);
      response.on("error", () => res.destroy());
    });
    upstream.on("error", (error: NodeJS.ErrnoException) => {
      logger.warn("egress_provider_failed", { status: 502, sandboxId, host, code: error.code });
      reply(res, 502, `could not reach the credential provider for ${host}`);
    });
    req.on("error", () => upstream.destroy());
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  }

  return {
    close() {
      providerAgent?.destroy();
    },
    async terminate(client, target) {
      const { sandboxId, host, addresses, tally } = target;
      const leaf = await credentials.leaf(host);
      if (client.destroyed) return;
      // Requests go to the addresses the gate checked, never to the name resolved again.
      const lookup: LookupFunction = (_name, lookupOptions, callback) => {
        if (lookupOptions.all) (callback as (e: null, a: typeof addresses) => void)(null, addresses);
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      };
      const agent = new Agent({
        keepAlive: true,
        maxSockets: hostTuning().egress.credentialsMaxSockets,
        lookup,
        ...(credentials.upstreamCa ? { ca: credentials.upstreamCa } : {}),
      });
      client.write(CONNECT_ESTABLISHED);
      const tls = new TLSSocket(client as Socket, {
        isServer: true,
        secureContext: createSecureContext({ key: leaf.key, cert: leaf.cert }),
        ALPNProtocols: ["http/1.1"],
      });
      terminated.set(tls, { sandboxId, host, agent, tally, ...(target.provider ? { provider: target.provider } : {}) });
      tls.on("error", () => tls.destroy());
      tls.on("close", () => {
        agent.destroy();
        client.destroy();
      });
      logger.info("egress_terminated", { sandboxId, host, ...(target.provider ? { via: "provider" } : {}) });
      http.emit("connection", tls);
    },
  };
}
