/**
 * egress-gate (F7.2, `gates/egress.ts`): a CONNECT proxy that opens a tunnel only with a live
 * egress token, only to a host the sandbox's spec allows, on 443 or 80, never to an IP literal or
 * a private address. Name resolution and dialling go through test hooks: every allowed name
 * "resolves" to a local echo server, which the hook's address check lets through.
 */
import { createServer as createTcpServer, connect, type Server as TcpServer, type Socket } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  egressAllows,
  isEgressBlocked,
  proxyToken,
  startEgressGate,
  storeEgressSandboxes,
  type EgressGate,
  type EgressSandboxes,
  type StartEgressGateOptions,
} from "../../src/gates/egress.js";
import { mintEgressToken, verifyEgressToken, type EgressTokenKeyCache } from "../../src/sandbox/egress-token.js";
import { subjectTokenIssuer } from "@nylorun/core/contracts";
import { runFixture, type RunFixture } from "../support/run-tokens.js";
import { startEgress } from "../../src/host/gates.js";
import type { TenantVault, TenantVaults } from "../../src/gates/tenant-vaults.js";

let runs: RunFixture;
let echo: TcpServer;
let echoPort: number;
const logs: { message: string; fields?: Record<string, unknown> }[] = [];
const logger = {
  info: (message: string, fields?: Record<string, unknown>) => logs.push({ message, ...(fields ? { fields } : {}) }),
  warn: (message: string, fields?: Record<string, unknown>) => logs.push({ message, ...(fields ? { fields } : {}) }),
  error: (message: string, fields?: Record<string, unknown>) => logs.push({ message, ...(fields ? { fields } : {}) }),
};

/** The sandboxes egress-gate reads: id → epoch and allowlist; absent means gone or lost. */
const sandboxes = new Map<string, { epoch: number; allow: string[] }>();
let reads = 0;
const fake: EgressSandboxes = {
  async live(id) {
    reads += 1;
    const sandbox = sandboxes.get(id);
    return sandbox && { epoch: sandbox.epoch, allow: [...sandbox.allow] };
  },
};

/** Names and what they "resolve" to. */
const DNS: Record<string, string[]> = {
  "allowed.test": ["127.0.0.1"],
  "a.wild.test": ["127.0.0.1"],
  "wild.test": ["127.0.0.1"],
  "other.test": ["127.0.0.1"],
  "private.test": ["10.0.0.5"],
  "metadata.test": ["169.254.169.254"],
  "mixed.test": ["192.168.1.10", "127.0.0.1"],
  "loopback6.test": ["::1"],
};

const gates: EgressGate[] = [];
async function gate(overrides: Partial<StartEgressGateOptions> = {}): Promise<EgressGate> {
  const keys: EgressTokenKeyCache = new Map();
  const started = await startEgressGate({
    listen: { host: "127.0.0.1", port: 0 },
    logger,
    verify: (raw) => verifyEgressToken(runs.store, runs.tenantId, raw, keys),
    sandboxes: fake,
    cacheMs: 0,
    async lookup(host) {
      const addresses = DNS[host];
      if (!addresses) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
      return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
    // The echo server is on loopback: let 127.0.0.1 through, refuse everything else as usual.
    blocked: (address) => address !== "127.0.0.1" && isEgressBlocked(address),
    dial: (address) => connect({ host: address, port: echoPort }),
    ...overrides,
  });
  gates.push(started);
  return started;
}

const token = async (sandboxId = "sbx_1", epoch = 1) =>
  (await mintEgressToken({ keys: runs.keys }, { tenantId: runs.tenantId, sandboxId, epoch, podUid: "pod-1" })).token;
const basic = (raw: string) => `Basic ${Buffer.from(`nylo:${raw}`).toString("base64")}`;

interface Answer {
  status: number;
  head: string;
  socket: Socket;
}

/** Sends `request` to the gate and reads the answer's head. */
function send(proxy: EgressGate, request: string): Promise<Answer> {
  const port = Number(new URL(proxy.url).port);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("latin1");
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) return;
      socket.off("data", onData);
      const head = buffer.slice(0, end);
      const rest = buffer.slice(end + 4);
      if (rest) socket.unshift(Buffer.from(rest, "latin1"));
      resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1]), head, socket });
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.write(request);
  });
}

const sockets: Socket[] = [];
async function tunnel(proxy: EgressGate, target: string, authorization?: string): Promise<Answer> {
  const answer = await send(
    proxy,
    `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${authorization ? `Proxy-Authorization: ${authorization}\r\n` : ""}\r\n`,
  );
  sockets.push(answer.socket);
  return answer;
}

/** Writes `text` through an open tunnel and reads it back from the echo server. */
function roundTrip(socket: Socket, text: string): Promise<string> {
  return new Promise((resolve) => {
    let got = "";
    const onData = (chunk: Buffer) => {
      got += chunk.toString();
      if (got.length >= text.length) {
        socket.off("data", onData);
        resolve(got);
      }
    };
    socket.on("data", onData);
    socket.write(text);
  });
}

const closed = (socket: Socket) =>
  new Promise<void>((resolve) => {
    if (socket.destroyed || socket.readableEnded) return resolve();
    socket.once("close", () => resolve());
    socket.resume();
  });

beforeAll(async () => {
  runs = await runFixture();
  echo = createTcpServer((socket) => socket.pipe(socket));
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
  echoPort = (echo.address() as { port: number }).port;
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(gates.splice(0).map((started) => started.close()));
  sandboxes.clear();
  logs.length = 0;
});

afterAll(async () => {
  await new Promise((resolve) => echo.close(resolve));
});

describe("egress-gate", () => {
  it("tunnels to an allowed host with Basic or Bearer credentials, exactly or by *.suffix", async () => {
    sandboxes.set("sbx_1", { epoch: 1, allow: ["allowed.test", "*.wild.test"] });
    const proxy = await gate();
    const raw = await token();
    const viaBasic = await tunnel(proxy, "allowed.test:443", basic(raw));
    expect(viaBasic.status).toBe(200);
    expect(await roundTrip(viaBasic.socket, "ping")).toBe("ping");
    const viaBearer = await tunnel(proxy, "a.wild.test:80", `Bearer ${raw}`);
    expect(viaBearer.status).toBe(200);
    expect(await roundTrip(viaBearer.socket, "pong")).toBe("pong");
    // A bare `<token>@` in the proxy URL: the token is the user name.
    const viaUser = await tunnel(proxy, "ALLOWED.test.:443", `Basic ${Buffer.from(`${raw}:`).toString("base64")}`);
    expect(viaUser.status).toBe(200);
    // `*.wild.test` does not match wild.test itself.
    expect((await tunnel(proxy, "wild.test:443", basic(raw))).status).toBe(403);
  });

  it("refuses a host the spec does not allow, and every host when the spec allows none", async () => {
    sandboxes.set("sbx_1", { epoch: 1, allow: ["allowed.test"] });
    sandboxes.set("sbx_2", { epoch: 1, allow: [] });
    const proxy = await gate();
    const refused = await tunnel(proxy, "other.test:443", basic(await token()));
    expect(refused.status).toBe(403);
    expect(refused.head).not.toMatch(/proxy-authenticate/i);
    expect((await tunnel(proxy, "allowed.test:443", basic(await token("sbx_2")))).status).toBe(403);
    expect(logs).toContainEqual({
      message: "egress_refused",
      fields: { status: 403, reason: "host_not_allowed", host: "other.test", port: 443, sandboxId: "sbx_1" },
    });
  });

  it("refuses ports other than 443 and 80", async () => {
    sandboxes.set("sbx_1", { epoch: 1, allow: ["allowed.test"] });
    const proxy = await gate();
    for (const port of [22, 5432, 8080, 444])
      expect((await tunnel(proxy, `allowed.test:${port}`, basic(await token()))).status).toBe(403);
  });

  it("refuses IP literals and names that are not host names", async () => {
    sandboxes.set("sbx_1", { epoch: 1, allow: ["allowed.test"] });
    const proxy = await gate();
    const raw = await token();
    for (const target of ["127.0.0.1:443", "1.1.1.1:443", "[::1]:443", "[2606:4700::1111]:443", "2130706433:443", "localhost:443", "*.wild.test:443", "allowed.test"])
      expect((await tunnel(proxy, target, basic(raw))).status, target).toBe(403);
  });

  it("refuses a name that resolves to a private, link-local or loopback address", async () => {
    sandboxes.set("sbx_1", { epoch: 1, allow: ["private.test", "metadata.test", "loopback6.test", "mixed.test", "gone.test"] });
    const dialled: string[] = [];
    const proxy = await gate({
      dial: (address) => {
        dialled.push(address);
        return connect({ host: "127.0.0.1", port: echoPort });
      },
    });
    const raw = await token();
    for (const host of ["private.test", "metadata.test", "loopback6.test"])
      expect((await tunnel(proxy, `${host}:443`, basic(raw))).status, host).toBe(403);
    expect((await tunnel(proxy, "gone.test:443", basic(raw))).status).toBe(502);
    // Only the checked address is dialled.
    expect((await tunnel(proxy, "mixed.test:443", basic(raw))).status).toBe(200);
    expect(dialled).toEqual(["127.0.0.1"]);
  });

  it("refuses a missing, malformed, expired or stale-epoch token, and a gone sandbox", async () => {
    sandboxes.set("sbx_1", { epoch: 2, allow: ["allowed.test"] });
    const proxy = await gate();
    const missing = await tunnel(proxy, "allowed.test:443");
    expect(missing.status).toBe(407);
    expect(missing.head).toMatch(/proxy-authenticate: Basic realm="nylorun-egress"/i);
    expect((await tunnel(proxy, "allowed.test:443", basic("not-a-token"))).status).toBe(407);
    expect((await tunnel(proxy, "allowed.test:443", "Digest abc")).status).toBe(407);
    const iat = Math.floor(Date.now() / 1000) - 600;
    const expired = await runs.keys.sign({
      typ: "nylorun-egress+jwt",
      claims: { iss: subjectTokenIssuer(runs.tenantId), aud: "nylorun-egress", sbx: "sbx_1", epc: 2, pod: "p", iat, exp: iat + 60, jti: "j" },
    });
    expect((await tunnel(proxy, "allowed.test:443", basic(expired.token))).status).toBe(407);
    // The sandbox's host epoch moved on (a relaunch): the old pod's token is stale.
    const stale = await tunnel(proxy, "allowed.test:443", basic(await token("sbx_1", 1)));
    expect(stale.status).toBe(407);
    expect((await tunnel(proxy, "allowed.test:443", basic(await token("sbx_1", 3)))).status).toBe(407);
    expect((await tunnel(proxy, "allowed.test:443", basic(await token("sbx_1", 2)))).status).toBe(200);
    // Lost or deleted.
    sandboxes.delete("sbx_1");
    expect((await tunnel(proxy, "allowed.test:443", basic(await token("sbx_1", 2)))).status).toBe(407);
    const reasons = logs.filter((entry) => entry.message === "egress_refused").map((entry) => entry.fields?.reason);
    expect(reasons).toEqual([
      "egress_token_missing",
      "egress_token_malformed",
      "egress_token_missing",
      "egress_token_expired",
      "epoch_stale",
      "epoch_stale",
      "sandbox_gone",
    ]);
    expect(JSON.stringify(logs)).not.toContain(expired.token);
  });

  it("refuses a run token or a host token presented as an egress token", async () => {
    sandboxes.set("sbx_1", { epoch: 1, allow: ["allowed.test"] });
    const proxy = await gate();
    const run = (await runs.run("egress-gate-run")).token;
    const iat = Math.floor(Date.now() / 1000);
    const host = await runs.keys.sign({
      typ: "nylorun-host+jwt",
      claims: { iss: subjectTokenIssuer(runs.tenantId), aud: "nylorun-harness", sbx: "sbx_1", epc: 1, pod: "p", iat, exp: iat + 60, jti: "h" },
    });
    for (const raw of [run, host.token]) {
      expect((await tunnel(proxy, "allowed.test:443", basic(raw))).status).toBe(407);
      expect((await tunnel(proxy, "allowed.test:443", `Bearer ${raw}`)).status).toBe(407);
    }
  });

  it("answers plain HTTP, absolute-form or not, with 405", async () => {
    sandboxes.set("sbx_1", { epoch: 1, allow: ["allowed.test"] });
    const proxy = await gate();
    const raw = await token();
    for (const request of [
      `GET http://allowed.test/ HTTP/1.1\r\nHost: allowed.test\r\nProxy-Authorization: ${basic(raw)}\r\n\r\n`,
      "GET /ready HTTP/1.1\r\nHost: gateway\r\n\r\n",
      "POST http://allowed.test/x HTTP/1.1\r\nHost: allowed.test\r\nContent-Length: 0\r\n\r\n",
    ]) {
      const answer = await send(proxy, request);
      sockets.push(answer.socket);
      expect(answer.status).toBe(405);
      expect(answer.head).toMatch(/allow: CONNECT/i);
    }
  });

  it("caps open tunnels per sandbox, and frees a slot when one closes", async () => {
    sandboxes.set("sbx_1", { epoch: 1, allow: ["allowed.test"] });
    sandboxes.set("sbx_2", { epoch: 1, allow: ["allowed.test"] });
    const proxy = await gate({ maxPerSandbox: 2 });
    const raw = await token();
    const first = await tunnel(proxy, "allowed.test:443", basic(raw));
    const second = await tunnel(proxy, "allowed.test:443", basic(raw));
    expect([first.status, second.status]).toEqual([200, 200]);
    expect((await tunnel(proxy, "allowed.test:443", basic(raw))).status).toBe(429);
    // Another sandbox has its own slots.
    expect((await tunnel(proxy, "allowed.test:443", basic(await token("sbx_2")))).status).toBe(200);
    first.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await tunnel(proxy, "allowed.test:443", basic(raw))).status).toBe(200);
  });

  it("closes a tunnel that stays idle", async () => {
    sandboxes.set("sbx_1", { epoch: 1, allow: ["allowed.test"] });
    const proxy = await gate({ idleMs: 150 });
    const open = await tunnel(proxy, "allowed.test:443", basic(await token()));
    expect(open.status).toBe(200);
    expect(await roundTrip(open.socket, "x")).toBe("x");
    const started = Date.now();
    await closed(open.socket);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("runs in the gateway over the Tenant's keys (`--service egress`)", async () => {
    sandboxes.set("sbx_1", { epoch: 1, allow: ["allowed.test"] });
    const vaults: TenantVaults = {
      open: async () => ({ tenantId: runs.tenantId, store: runs.store }) as unknown as TenantVault,
    };
    const proxy = await startEgress({
      egress: { listen: { host: "127.0.0.1", port: 0 } },
      logger,
      vaults,
      gate: {
        sandboxes: fake,
        lookup: async () => [{ address: "127.0.0.1", family: 4 }],
        blocked: () => false,
        dial: (address) => connect({ host: address, port: echoPort }),
      },
    });
    gates.push(proxy);
    expect((await tunnel(proxy, "allowed.test:443", basic(await token()))).status).toBe(200);
    expect((await tunnel(proxy, "other.test:443", basic(await token()))).status).toBe(403);
  });

  it("reuses a sandbox's epoch and allowlist for the cache window, and reads again for a newer epoch", async () => {
    sandboxes.set("sbx_1", { epoch: 1, allow: ["allowed.test"] });
    const proxy = await gate({ cacheMs: 60_000 });
    reads = 0;
    expect((await tunnel(proxy, "allowed.test:443", basic(await token("sbx_1", 1)))).status).toBe(200);
    expect((await tunnel(proxy, "allowed.test:443", basic(await token("sbx_1", 1)))).status).toBe(200);
    expect(reads).toBe(1);
    // A join bumped the epoch: the new token's epoch is newer than the cached one.
    sandboxes.set("sbx_1", { epoch: 2, allow: ["allowed.test"] });
    expect((await tunnel(proxy, "allowed.test:443", basic(await token("sbx_1", 2)))).status).toBe(200);
    expect(reads).toBe(2);
    expect((await tunnel(proxy, "allowed.test:443", basic(await token("sbx_1", 1)))).status).toBe(407);
  });
});

describe("egress-gate helpers", () => {
  it("reads a pod sandbox's allowlist from sandbox_resources, and nothing for a virtual or unknown one", async () => {
    const now = new Date().toISOString();
    const row = (id: string, kind: "virtual" | "pod", allow?: string[]) => ({
      id,
      kind,
      spec: { network: { preset: "none" as const, ...(allow ? { allow } : {}) } },
      labels: {},
      createdAt: now,
      updatedAt: now,
    });
    await runs.store.tx(async (t) => {
      await t.createSandboxResource(row("egress-pod", "pod", ["*.example.com"]), 100);
      await t.createSandboxResource(row("egress-pod-none", "pod"), 100);
      await t.createSandboxResource(row("egress-virtual", "virtual", ["example.com"]), 100);
    });
    const store = storeEgressSandboxes(runs.store);
    expect(await store.live("egress-pod")).toEqual({ epoch: 0, allow: ["*.example.com"] });
    expect(await store.live("egress-pod-none")).toEqual({ epoch: 0, allow: [] });
    expect(await store.live("egress-virtual")).toBeUndefined();
    expect(await store.live("egress-unknown")).toBeUndefined();
  });

  it("blocks private, loopback, link-local, metadata, reserved and IPv4-embedding addresses", () => {
    for (const address of [
      "10.1.2.3", "172.16.0.1", "192.168.65.254", "127.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
      "224.0.0.1", "255.255.255.255", "198.18.0.1", "::1", "::", "fe80::1", "fd00:ec2::254",
      "::ffff:127.0.0.1", "::ffff:169.254.169.254", "64:ff9b::a00:1", "2002:a00:1::", "not-an-address",
    ])
      expect(isEgressBlocked(address), address).toBe(true);
    for (const address of ["93.184.215.14", "1.1.1.1", "2606:4700::1111", "::ffff:1.1.1.1"])
      expect(isEgressBlocked(address), address).toBe(false);
  });

  it("matches exact names and *.suffix patterns only", () => {
    const allow = ["api.github.com", "*.example.com"];
    expect(egressAllows("api.github.com", allow)).toBe(true);
    expect(egressAllows("a.b.example.com", allow)).toBe(true);
    expect(egressAllows("example.com", allow)).toBe(false);
    expect(egressAllows("evilexample.com", allow)).toBe(false);
    expect(egressAllows("github.com", allow)).toBe(false);
    expect(egressAllows("api.github.com.evil.test", allow)).toBe(false);
  });

  it("reads the token from Basic (password, or a bare user) and Bearer", () => {
    const b64 = (text: string) => Buffer.from(text).toString("base64");
    expect(proxyToken(`Basic ${b64("x:tok")}`)).toBe("tok");
    expect(proxyToken(`basic ${b64("tok:")}`)).toBe("tok");
    expect(proxyToken(`Basic ${b64("tok")}`)).toBe("tok");
    expect(proxyToken("Bearer tok")).toBe("tok");
    expect(proxyToken(`Basic ${b64(":")}`)).toBeUndefined();
    expect(proxyToken("Digest tok")).toBeUndefined();
    expect(proxyToken(undefined)).toBeUndefined();
  });
});
