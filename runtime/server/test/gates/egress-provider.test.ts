/**
 * egress-gate and the outside credential provider (v0.25 CP-E, `gates/credential-provider.ts`):
 * for an Agent with an owner, a host the provider lists passes the allowlist on 443 (inside the
 * Tenant's egress ceiling), is terminated with a leaf of the egress CA, and each of its requests
 * goes to the provider's forward route with the sandbox's own headers and the engine's provider
 * headers; the Runtime never holds a value. A host it doesn't list is refused as before, an Agent
 * with no owner is never asked about, a provider that is down answers nothing, and the vault's
 * binding wins for a host it binds. The provider is a local HTTP server; every name "resolves" to
 * 127.0.0.1, which the address hook lets through.
 */
import { once } from "node:events";
import { createServer as createHttpServer, type IncomingHttpHeaders, type Server as HttpServer } from "node:http";
import { Agent, createServer as createHttpsServer, request, type Server as HttpsServer } from "node:https";
import { connect, createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { EgressCredentialRelease, EgressCredentials } from "../../src/gates/egress-credentials.js";
import { createCredentialProvider, PROVIDER_HEADERS } from "../../src/gates/credential-provider.js";
import {
  isEgressBlocked,
  startEgressGate,
  type EgressConnection,
  type EgressGate,
  type EgressSandboxes,
} from "../../src/gates/egress.js";
import { createCertificateAuthority, issueLeafCertificate, leafKeyPair } from "../../src/keys/x509.js";
import { mintEgressToken, verifyEgressToken, type EgressTokenKeyCache } from "../../src/sandbox/egress-token.js";
import { DEFAULT_HOST_TUNING, hostTuningOf, useHostTuning } from "../../src/tuning.js";
import { runFixture, type RunFixture } from "../support/run-tokens.js";

const TOKEN = "provider-token-0123456789abcdef";
const OWNER = "u:org_1:user_ada";

const egressCa = createCertificateAuthority({ commonName: "Nylorun egress CA (test)" });
const upstreamCa = createCertificateAuthority({ commonName: "Upstream CA (test)" });

let runs: RunFixture;
let provider: HttpServer;
let providerUrl: string;
let upstream: HttpsServer;
let upstreamPort: number;
let echo: TcpServer;
let echoPort: number;

/** What the provider lists now, and what it received. */
let listed: string[] = [];
let variables: string[] = [];
const calls: { url: string; headers: IncomingHttpHeaders; body: string }[] = [];
/** Requests the upstream (the vault's path) received. */
const upstreamReceived: { url: string | undefined; headers: IncomingHttpHeaders }[] = [];

const logs: { message: string; fields?: Record<string, unknown> }[] = [];
const logger = {
  info: (message: string, fields?: Record<string, unknown>) => logs.push({ message, ...(fields ? { fields } : {}) }),
  warn: (message: string, fields?: Record<string, unknown>) => logs.push({ message, ...(fields ? { fields } : {}) }),
  error: (message: string, fields?: Record<string, unknown>) => logs.push({ message, ...(fields ? { fields } : {}) }),
};

const forwards = () => calls.filter((call) => call.url.startsWith("/edge/provider/v1/forward"));
const hostCalls = () => calls.filter((call) => call.url === "/edge/provider/v1/hosts");

/** Host → what the vault answers for it; a host absent here is not bound. */
const vault = new Map<string, EgressCredentialRelease>();
const credentials = (): EgressCredentials => ({
  bound: async (_sandboxId, host) => vault.has(host),
  release: async (_sandboxId, host) => vault.get(host) ?? { status: "none" },
  async leaf(host) {
    const pair = leafKeyPair();
    return { key: pair.privateKey, cert: issueLeafCertificate({ authority: egressCa, host, publicKey: pair.publicKey }) };
  },
  upstreamCa: upstreamCa.certificate,
  upstreamPort,
});

type Live = NonNullable<Awaited<ReturnType<EgressSandboxes["live"]>>>;
const gates: EgressGate[] = [];
async function gate(
  sandbox: Partial<Live> = {},
  options: { url?: string; written?: EgressConnection[] } = {},
): Promise<EgressGate> {
  const keys: EgressTokenKeyCache = new Map();
  const started = await startEgressGate({
    listen: { host: "127.0.0.1", port: 0 },
    logger,
    verify: (raw) => verifyEgressToken(runs.store, runs.tenantId, raw, keys),
    sandboxes: { live: async () => ({ epoch: 1, allow: ["plain.test"], owner: OWNER, ...sandbox }) },
    cacheMs: 0,
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    blocked: (address) => address !== "127.0.0.1" && isEgressBlocked(address),
    dial: (address) => connect({ host: address, port: echoPort }),
    credentials: credentials(),
    provider: createCredentialProvider({ url: options.url ?? providerUrl, token: TOKEN }, { logger }),
    ...(options.written
      ? { record: { runningTurns: async () => [], write: async (connection) => void options.written!.push(connection) } }
      : {}),
  });
  gates.push(started);
  return started;
}

const sockets: Socket[] = [];
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

async function tlsThrough(socket: Socket, host: string): Promise<TLSSocket> {
  const secure = tlsConnect({ socket, servername: host, ca: egressCa.certificate, ALPNProtocols: ["http/1.1"] });
  await once(secure, "secureConnect");
  return secure;
}

const agents = new WeakMap<TLSSocket, Agent>();
function send(
  secure: TLSSocket,
  host: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  let agent = agents.get(secure);
  if (!agent) {
    agent = new Agent({ keepAlive: true, maxSockets: 1 });
    agent.createConnection = () => secure;
    agents.set(secure, agent);
  }
  return new Promise((resolve, reject) => {
    const req = request({ host, path, method: body ? "POST" : "GET", headers: { host, ...headers }, agent }, (res) => {
      let text = "";
      res.on("data", (chunk: Buffer) => (text += chunk.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

beforeAll(async () => {
  runs = await runFixture();
  provider = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      calls.push({ url: req.url ?? "", headers: req.headers, body });
      if (req.headers.authorization !== `Bearer ${TOKEN}` && req.headers[PROVIDER_HEADERS.token] !== TOKEN) {
        res.writeHead(401).end();
        return;
      }
      res.setHeader("content-type", "application/json");
      if (req.url === "/edge/provider/v1/hosts") return res.end(JSON.stringify({ hosts: listed }));
      if (req.url === "/edge/provider/v1/environment") return res.end(JSON.stringify({ variables }));
      res.setHeader("x-provider", "yes");
      res.end(JSON.stringify({ forwarded: req.url, method: req.method, length: body.length }));
    });
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/edge/provider/`;
  const pair = leafKeyPair();
  upstream = createHttpsServer(
    { key: pair.privateKey, cert: issueLeafCertificate({ authority: upstreamCa, host: "api.vercel.test", publicKey: pair.publicKey }) },
    (req, res) => {
      upstreamReceived.push({ url: req.url, headers: req.headers });
      req.resume();
      res.end("from upstream");
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
  calls.length = 0;
  upstreamReceived.length = 0;
  logs.length = 0;
  listed = [];
  variables = [];
  useHostTuning(DEFAULT_HOST_TUNING);
});

afterAll(async () => {
  provider.close();
  upstream.close();
  echo.close();
});

describe("egress-gate and the credential provider (CP-E)", () => {
  it("lets a host the provider lists through, and hands each request to its forward route as the sandbox sent it", async () => {
    listed = ["API.Vercel.test", "10.0.0.1", "*.wild.test"];
    const written: EgressConnection[] = [];
    const proxy = await gate({}, { written });
    const { status, socket } = await connectThrough(proxy, "api.vercel.test:443");
    expect(status).toBe(200);
    const secure = await tlsThrough(socket, "api.vercel.test");
    expect(secure.authorized).toBe(true);
    const first = await send(secure, "api.vercel.test", "/v9/projects?limit=2", {
      authorization: "Bearer nylorun_managed",
      "x-tool": "vercel",
      // A sandbox can't name another owner or Agent: its provider headers are dropped.
      "nylorun-provider-owner": "u:org_1:user_mallory",
      "nylorun-provider-token": "guess",
    });
    expect(first.status).toBe(200);
    expect(first.headers["x-provider"]).toBe("yes");
    expect(JSON.parse(first.body)).toEqual({ forwarded: "/edge/provider/v1/forward/v9/projects?limit=2", method: "GET", length: 0 });
    // A body streams through on the same connection.
    const second = await send(secure, "api.vercel.test", "/v1/deployments", { "x-api-key": "nylorun_managed" }, "x".repeat(70_000));
    expect(JSON.parse(second.body)).toMatchObject({ forwarded: "/edge/provider/v1/forward/v1/deployments", method: "POST", length: 70_000 });

    // The hosts call: the provider's bearer, the Agent and its owner.
    expect(hostCalls()).toHaveLength(1);
    expect(hostCalls()[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(hostCalls()[0]!.body)).toEqual({ agentId: "sbx_1", owner: OWNER });
    const [get, post] = forwards();
    expect(get!.headers).toMatchObject({
      authorization: "Bearer nylorun_managed",
      "x-tool": "vercel",
      [PROVIDER_HEADERS.host]: "api.vercel.test",
      [PROVIDER_HEADERS.agent]: "sbx_1",
      [PROVIDER_HEADERS.owner]: OWNER,
      [PROVIDER_HEADERS.token]: TOKEN,
    });
    expect(get!.headers.host).toBe(new URL(providerUrl).host);
    expect(get!.headers["proxy-authorization"]).toBeUndefined();
    expect(post!.headers).toMatchObject({ "x-api-key": "nylorun_managed", [PROVIDER_HEADERS.owner]: OWNER });
    expect(post!.headers.authorization).toBeUndefined();

    // The record counts the requests, and the token is never logged.
    secure.destroy();
    for (let i = 0; i < 250 && written.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ host: "api.vercel.test", port: 443, outcome: "allowed", mode: "credential", requests: 2 });
    expect(written[0]!.credentialIds).toEqual([]);
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
    expect(logs).toContainEqual({ message: "egress_terminated", fields: { sandboxId: "sbx_1", host: "api.vercel.test", via: "provider" } });
  });

  it("refuses a host the provider doesn't list and the spec doesn't allow, and asks once per Agent within the cache", async () => {
    listed = ["api.vercel.test"];
    const proxy = await gate();
    expect((await connectThrough(proxy, "api.other.test:443")).status).toBe(403);
    expect(logs.some((entry) => entry.message === "egress_refused" && entry.fields?.reason === "host_not_allowed")).toBe(true);
    // A host the spec allows still tunnels, and the second CONNECT reuses the provider's answer.
    const { status, socket } = await connectThrough(proxy, "plain.test:443");
    expect(status).toBe(200);
    socket.write("opaque");
    expect(((await once(socket, "data")) as [Buffer])[0].toString()).toBe("opaque");
    expect(hostCalls()).toHaveLength(1);
    expect(forwards()).toHaveLength(0);
  });

  it("keeps a provider host off port 80 unless the spec allows it", async () => {
    listed = ["api.vercel.test"];
    const proxy = await gate();
    expect((await connectThrough(proxy, "api.vercel.test:80")).status).toBe(403);
    expect(hostCalls()).toHaveLength(0);
  });

  it("never asks about an Agent with no owner", async () => {
    listed = ["api.vercel.test"];
    const proxy = await gate({ owner: undefined });
    expect((await connectThrough(proxy, "api.vercel.test:443")).status).toBe(403);
    expect((await connectThrough(proxy, "plain.test:443")).status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it("keeps a provider host inside the Tenant's egress ceiling", async () => {
    listed = ["api.vercel.test", "api.github.com"];
    const proxy = await gate({ ceiling: ["*.github.com", "plain.test"] });
    expect((await connectThrough(proxy, "api.vercel.test:443")).status).toBe(403);
    expect((await connectThrough(proxy, "api.github.com:443")).status).toBe(200);
  });

  it("refuses as before when the provider is down, logs it once, and keeps serving", async () => {
    // Every failure is asked again at once, so each CONNECT calls the dead provider.
    useHostTuning(hostTuningOf({ credentialProvider: { retryMs: 0, timeoutMs: 500 } }));
    const dead = createTcpServer();
    dead.listen(0, "127.0.0.1");
    await once(dead, "listening");
    const port = (dead.address() as { port: number }).port;
    dead.close();
    const proxy = await gate({}, { url: `http://127.0.0.1:${port}/edge/provider` });
    expect((await connectThrough(proxy, "api.vercel.test:443")).status).toBe(403);
    expect((await connectThrough(proxy, "api.vercel.test:443")).status).toBe(403);
    expect((await connectThrough(proxy, "plain.test:443")).status).toBe(200);
    const failed = logs.filter((entry) => entry.message === "credential_provider_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.fields).toMatchObject({ call: "hosts", agentId: "sbx_1", reason: "unreachable" });
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
  });

  it("answers nothing for a provider that refuses or answers another shape", async () => {
    useHostTuning(hostTuningOf({ credentialProvider: { retryMs: 0 } }));
    const client = createCredentialProvider({ url: providerUrl, token: "wrong-token-0123456789" }, { logger });
    expect(await client.hosts("sbx_1", OWNER)).toEqual([]);
    expect(logs).toContainEqual({ message: "credential_provider_failed", fields: { call: "hosts", agentId: "sbx_1", reason: "status", status: 401 } });
    expect(await client.environment("sbx_1", undefined)).toEqual([]);
    expect(calls.filter((call) => call.url.endsWith("/environment"))).toHaveLength(0);
  });

  it("lets the vault's binding win for a host it binds", async () => {
    listed = ["api.vercel.test"];
    vault.set("api.vercel.test", { status: "released", header: "Authorization", value: "Bearer from-vault", credentialId: "cred_1" });
    const proxy = await gate();
    const secure = await tlsThrough((await connectThrough(proxy, "api.vercel.test:443")).socket, "api.vercel.test");
    expect((await send(secure, "api.vercel.test", "/v9/projects", { authorization: "Bearer nylorun_managed" })).body).toBe("from upstream");
    expect(upstreamReceived[0]!.headers.authorization).toBe("Bearer from-vault");
    expect(forwards()).toHaveLength(0);
  });

  it("names the variables an Agent's owner connected, valid names only, cached per Agent", async () => {
    variables = ["VERCEL_TOKEN", "LINEAR_API_KEY", "not a name", "VERCEL_TOKEN"];
    const client = createCredentialProvider({ url: providerUrl, token: TOKEN }, { logger });
    expect(await client.environment("sbx_1", OWNER)).toEqual(["VERCEL_TOKEN", "LINEAR_API_KEY"]);
    variables = [];
    expect(await client.environment("sbx_1", OWNER)).toEqual(["VERCEL_TOKEN", "LINEAR_API_KEY"]);
    expect(await client.environment("sbx_2", OWNER)).toEqual([]);
    const asked = calls.filter((call) => call.url === "/edge/provider/v1/environment");
    expect(asked.map((call) => JSON.parse(call.body))).toEqual([
      { agentId: "sbx_1", owner: OWNER },
      { agentId: "sbx_2", owner: OWNER },
    ]);
  });
});
