/**
 * egress-gate's credential path (R2c, D50, `gates/egress-credentials.ts`): for a host an
 * `environment_secret` is bound to, the gate terminates TLS with a leaf the egress CA signed and
 * sets the credential's header on every request, read afresh each time; every other host stays
 * an opaque tunnel. The upstream is a local HTTPS server with its own test CA; every name
 * "resolves" to it.
 */
import { once } from "node:events";
import { Agent, createServer as createHttpsServer, request, type Server as HttpsServer } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { connect, createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { EgressCredentialRelease, EgressCredentials } from "../../src/gates/egress-credentials.js";
import { isEgressBlocked, startEgressGate, type EgressGate } from "../../src/gates/egress.js";
import { createCertificateAuthority, issueLeafCertificate, leafKeyPair } from "../../src/keys/x509.js";
import { mintEgressToken, verifyEgressToken, type EgressTokenKeyCache } from "../../src/sandbox/egress-token.js";
import { runFixture, type RunFixture } from "../support/run-tokens.js";

const egressCa = createCertificateAuthority({ commonName: "Nylorun egress CA (test)" });
const upstreamCa = createCertificateAuthority({ commonName: "Upstream CA (test)" });

let runs: RunFixture;
let upstream: HttpsServer;
let upstreamPort: number;
let echo: TcpServer;
let echoPort: number;
/** What the upstream server received, in order. */
const received: { host: string | undefined; url: string | undefined; headers: IncomingHttpHeaders; body: string }[] = [];

const logs: { message: string; fields?: Record<string, unknown> }[] = [];
const logger = {
  info: (message: string, fields?: Record<string, unknown>) => logs.push({ message, ...(fields ? { fields } : {}) }),
  warn: (message: string, fields?: Record<string, unknown>) => logs.push({ message, ...(fields ? { fields } : {}) }),
  error: (message: string, fields?: Record<string, unknown>) => logs.push({ message, ...(fields ? { fields } : {}) }),
};

/** Host → what the vault answers for it now; a host absent here is not bound. */
const vault = new Map<string, EgressCredentialRelease>();
let releases = 0;
const credentials = (overrides: Partial<EgressCredentials> = {}): EgressCredentials => ({
  bound: async (_sandboxId, host) => vault.has(host),
  async release(_sandboxId, host) {
    releases += 1;
    return vault.get(host) ?? { status: "none" };
  },
  async leaf(host) {
    const pair = leafKeyPair();
    return { key: pair.privateKey, cert: issueLeafCertificate({ authority: egressCa, host, publicKey: pair.publicKey }) };
  },
  upstreamCa: upstreamCa.certificate,
  upstreamPort,
  ...overrides,
});

const gates: EgressGate[] = [];
async function gate(overrides: Partial<EgressCredentials> = {}): Promise<EgressGate> {
  const keys: EgressTokenKeyCache = new Map();
  const started = await startEgressGate({
    listen: { host: "127.0.0.1", port: 0 },
    logger,
    verify: (raw) => verifyEgressToken(runs.store, runs.tenantId, raw, keys),
    sandboxes: { live: async () => ({ epoch: 1, allow: ["api.bound.test", "plain.test"] }) },
    cacheMs: 0,
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    blocked: (address) => address !== "127.0.0.1" && isEgressBlocked(address),
    dial: (address) => connect({ host: address, port: echoPort }),
    credentials: credentials(overrides),
  });
  gates.push(started);
  return started;
}

const sockets: Socket[] = [];
/** Opens a CONNECT tunnel to `target` and answers the gate's status and the socket. */
async function connectThrough(proxy: EgressGate, target: string): Promise<{ status: number; socket: Socket }> {
  const raw = (await mintEgressToken({ keys: runs.keys }, { tenantId: runs.tenantId, sandboxId: "sbx_1", epoch: 1, podUid: "pod-1" })).token;
  const socket = connect({ host: "127.0.0.1", port: Number(new URL(proxy.url).port) });
  sockets.push(socket);
  socket.write(
    `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic ${Buffer.from(`nylorun:${raw}`).toString("base64")}\r\n\r\n`,
  );
  let buffer = "";
  for (;;) {
    const [chunk] = (await once(socket, "data")) as [Buffer];
    buffer += chunk.toString("latin1");
    if (buffer.includes("\r\n\r\n")) break;
  }
  return { status: Number(/^HTTP\/1\.1 (\d{3})/.exec(buffer)?.[1]), socket };
}

/** TLS over the tunnel, trusting only the egress CA, as a pod's CLI does with its bundle. */
async function tlsThrough(socket: Socket, host: string): Promise<TLSSocket> {
  const secure = tlsConnect({ socket, servername: host, ca: egressCa.certificate, ALPNProtocols: ["h2", "http/1.1"] });
  await once(secure, "secureConnect");
  return secure;
}

/** Requests over `secure` only, kept alive between them as a CLI's client does. */
const agents = new WeakMap<TLSSocket, Agent>();
function agentOf(secure: TLSSocket): Agent {
  let agent = agents.get(secure);
  if (!agent) {
    agent = new Agent({ keepAlive: true, maxSockets: 1 });
    agent.createConnection = () => secure;
    agents.set(secure, agent);
  }
  return agent;
}

/** One request on `secure`, answering the status and the body. */
function get(secure: TLSSocket, host: string, headers: Record<string, string>, body?: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      { host, path: "/user", method: body ? "POST" : "GET", headers: { host, ...headers }, agent: agentOf(secure) },
      (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => (text += chunk.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

beforeAll(async () => {
  runs = await runFixture();
  const pair = leafKeyPair();
  upstream = createHttpsServer(
    { key: pair.privateKey, cert: issueLeafCertificate({ authority: upstreamCa, host: "api.bound.test", publicKey: pair.publicKey }) },
    (req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        received.push({ host: req.headers.host, url: req.url, headers: req.headers, body });
        res.setHeader("x-upstream", "yes");
        res.end(`hello ${req.method}`);
      });
    },
  );
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  upstreamPort = (upstream.address() as { port: number }).port;
  echo = createTcpServer((socket) => socket.pipe(socket));
  echo.listen(0, "127.0.0.1");
  await once(echo, "listening");
  echoPort = (echo.address() as { port: number }).port;
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(gates.splice(0).map((started) => started.close()));
  vault.clear();
  received.length = 0;
  logs.length = 0;
  releases = 0;
});

afterAll(async () => {
  upstream.close();
  echo.close();
});

describe("egress-gate credentials (R2c)", () => {
  it("sets the bound credential's header on every request, replacing the sentinel, and reads it afresh", async () => {
    vault.set("api.bound.test", { status: "released", header: "Authorization", value: "Bearer real-1", credentialId: "cred_1" });
    const proxy = await gate();
    const { status, socket } = await connectThrough(proxy, "api.bound.test:443");
    expect(status).toBe(200);
    const secure = await tlsThrough(socket, "api.bound.test");
    expect(secure.authorized).toBe(true);
    expect(secure.alpnProtocol).toBe("http/1.1");
    const first = await get(secure, "api.bound.test", { authorization: "Bearer nylorun-managed", "x-tool": "gh" });
    expect(first).toEqual({ status: 200, body: "hello GET" });
    // Rotated between two requests on one connection: the next request carries the new value.
    vault.set("api.bound.test", { status: "released", header: "Authorization", value: "Bearer real-2", credentialId: "cred_1" });
    expect(await get(secure, "api.bound.test", { Authorization: "token nylorun-managed" }, "payload")).toEqual({
      status: 200,
      body: "hello POST",
    });
    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({ host: "api.bound.test", url: "/user", headers: { authorization: "Bearer real-1", "x-tool": "gh" } });
    expect(received[1]).toMatchObject({ headers: { authorization: "Bearer real-2" }, body: "payload" });
    for (const request of received) expect(request.headers["proxy-authorization"]).toBeUndefined();
    expect(releases).toBe(2);
    expect(JSON.stringify(logs)).not.toContain("real-");
  });

  it("sets any header the credential names, with no tool-specific code", async () => {
    vault.set("api.bound.test", { status: "released", header: "PRIVATE-TOKEN", value: "glpat-secret", credentialId: "cred_2" });
    const proxy = await gate();
    const secure = await tlsThrough((await connectThrough(proxy, "api.bound.test:443")).socket, "api.bound.test");
    await get(secure, "api.bound.test", { "private-token": "nylorun-managed", authorization: "Basic keep" });
    expect(received[0]!.headers).toMatchObject({ "private-token": "glpat-secret", authorization: "Basic keep" });
  });

  it("keeps a host no credential is bound to an opaque tunnel", async () => {
    const proxy = await gate();
    const { status, socket } = await connectThrough(proxy, "plain.test:443");
    expect(status).toBe(200);
    socket.write("opaque bytes");
    const [chunk] = (await once(socket, "data")) as [Buffer];
    expect(chunk.toString()).toBe("opaque bytes");
    expect(releases).toBe(0);
  });

  it("answers 502 when the vault refuses the release, and logs only the reason", async () => {
    vault.set("api.bound.test", { status: "refused", reason: "ambiguous" });
    const proxy = await gate();
    const secure = await tlsThrough((await connectThrough(proxy, "api.bound.test:443")).socket, "api.bound.test");
    const answer = await get(secure, "api.bound.test", {});
    expect(answer.status).toBe(502);
    expect(received).toHaveLength(0);
    expect(logs).toContainEqual({
      message: "egress_credential_refused",
      fields: { status: 502, reason: "ambiguous", sandboxId: "sbx_1", host: "api.bound.test" },
    });
  });

  it("verifies the upstream's certificate: one the public roots do not sign is refused", async () => {
    vault.set("api.bound.test", { status: "released", header: "Authorization", value: "Bearer real", credentialId: "cred_1" });
    const proxy = await gate({ upstreamCa: undefined });
    const secure = await tlsThrough((await connectThrough(proxy, "api.bound.test:443")).socket, "api.bound.test");
    expect((await get(secure, "api.bound.test", {})).status).toBe(502);
    expect(received).toHaveLength(0);
    expect(logs.some((entry) => entry.message === "egress_upstream_failed")).toBe(true);
  });

  it("tunnels port 80 of a bound host: no credential leaves over plain HTTP", async () => {
    vault.set("api.bound.test", { status: "released", header: "Authorization", value: "Bearer real", credentialId: "cred_1" });
    const proxy = await gate();
    const { status, socket } = await connectThrough(proxy, "api.bound.test:80");
    expect(status).toBe(200);
    socket.write("GET / HTTP/1.1\r\n\r\n");
    const [chunk] = (await once(socket, "data")) as [Buffer];
    expect(chunk.toString()).toBe("GET / HTTP/1.1\r\n\r\n");
    expect(releases).toBe(0);
  });
});
