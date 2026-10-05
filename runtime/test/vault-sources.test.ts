/**
 * The credential resolver contract (F9 C1, `vault/sources.ts`), against an in-test resolver:
 * what it is asked, what each answer becomes, the cache, and the joins of concurrent misses.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  CredentialSources,
  RESOLVER_DEFAULT_CACHE_MS,
  RESOLVER_MAX_CACHE_MS,
  RESOLVER_TIMEOUT_MS,
  type CredentialSession,
} from "../src/vault/sources.js";
import type { AuthorizeResult } from "../src/vault/service.js";

const URL_A = "https://mcp.example.com/github";
const TOKEN = "resolver-shared-token";

type Asked = { authorization?: string; body: Record<string, any> };
type Reply = (asked: Asked, res: ServerResponse) => void | Promise<void>;

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close();
});

/** A resolver on 127.0.0.1 that answers with `reply` and records what it was asked. */
async function resolver(reply: Reply) {
  const asked: Asked[] = [];
  const held: ServerResponse[] = [];
  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const entry = {
      ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
      body: JSON.parse(Buffer.concat(chunks).toString()),
    };
    asked.push(entry);
    held.push(res);
    await reply(entry, res);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  open.push(
    () =>
      new Promise<void>((resolve) => {
        for (const res of held) res.destroy();
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  );
  return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/resolve`, asked };
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/** A vault with no credential for any URL, as the vault answers then. */
function emptyVault(result?: AuthorizeResult) {
  const calls: unknown[] = [];
  return {
    calls,
    vault: {
      async authorize(input: { url: string }): Promise<AuthorizeResult> {
        calls.push(input);
        return result ?? { status: "unauthenticated", url: input.url, headers: {} };
      },
    },
  };
}

function session(owner: string, extra: Partial<CredentialSession> = {}): CredentialSession {
  return { id: `s-${owner}`, ownerUserId: owner, activeTurnId: "t-1", vaultIds: [], ...extra };
}

function sources(url: string, options: { now?: () => number; timeoutMs?: number; vault?: any } = {}) {
  return new CredentialSources({
    vault: options.vault ?? emptyVault().vault,
    resolver: { url, token: TOKEN },
    ...(options.now ? { now: options.now } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
}

describe("CredentialSources", () => {
  it("asks the resolver with the session's owner and turn and uses its headers (200)", async () => {
    const server = await resolver((_asked, res) =>
      json(res, 200, { headers: { Authorization: "Bearer person-token", "X-Org": "acme" } }),
    );
    const result = await sources(server.url).authorize(session("u:priya"), {
      url: URL_A,
      serverName: "github",
      agentId: "support",
    });
    expect(result).toEqual({
      status: "authorized",
      url: URL_A,
      headers: { authorization: "Bearer person-token", "x-org": "acme" },
    });
    expect(server.asked).toEqual([
      {
        authorization: `Bearer ${TOKEN}`,
        body: {
          owner: "u:priya",
          session: "s-u:priya",
          turn: "t-1",
          target: { kind: "mcp", server: "github", agent: "support", url: URL_A },
        },
      },
    ]);
  });

  it("sends turn null without an active turn, and no agent for the root agent's server", async () => {
    const server = await resolver((_asked, res) => json(res, 404, { status: "not_connected" }));
    await sources(server.url).authorize(session("u:priya", { activeTurnId: null }), {
      url: URL_A,
      serverName: "github",
    });
    expect(server.asked[0]!.body).toEqual({
      owner: "u:priya",
      session: "s-u:priya",
      turn: null,
      target: { kind: "mcp", server: "github", url: URL_A },
    });
  });

  it("goes without a credential when the resolver answers 404", async () => {
    const server = await resolver((_asked, res) => json(res, 404, { status: "not_connected" }));
    expect(await sources(server.url).authorize(session("u:priya"), { url: URL_A })).toEqual({
      status: "unauthenticated",
      url: URL_A,
      headers: {},
    });
  });

  it("refuses with credential_unavailable on a 500, a bad body or a redirect", async () => {
    const answers: Reply[] = [
      (_a, res) => json(res, 500, { error: "down" }),
      (_a, res) => json(res, 200, { nope: true }),
      (_a, res) => json(res, 200, { headers: {} }),
      (_a, res) => json(res, 200, { headers: { authorization: "a\r\nb: c" } }),
      (_a, res) => json(res, 200, { headers: { host: "evil" } }),
      (_a, res) => json(res, 200, { headers: { authorization: "x" }, expiresAt: "soon" }),
      (_a, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("not json");
      },
      (_a, res) => {
        res.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" });
        res.end();
      },
    ];
    for (const answer of answers) {
      const server = await resolver(answer);
      expect(await sources(server.url).authorize(session("u:priya"), { url: URL_A })).toEqual({
        status: "refused",
        url: URL_A,
        credentialIds: [],
        reason: "credential_unavailable",
      });
    }
  });

  it("refuses with credential_unavailable when the resolver does not answer in time, and waits for a slow one", async () => {
    expect(RESOLVER_TIMEOUT_MS).toBe(5_000);
    const silent = await resolver(() => {
      /* never answers */
    });
    const started = Date.now();
    expect(
      await sources(silent.url, { timeoutMs: 200 }).authorize(session("u:priya"), { url: URL_A }),
    ).toMatchObject({ status: "refused", reason: "credential_unavailable" });
    expect(Date.now() - started).toBeLessThan(2_000);

    const slow = await resolver(async (_asked, res) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      json(res, 200, { headers: { authorization: "Bearer slow" } });
    });
    expect(
      await sources(slow.url, { timeoutMs: 1_000 }).authorize(session("u:priya"), { url: URL_A }),
    ).toMatchObject({ status: "authorized", headers: { authorization: "Bearer slow" } });
  });

  it("does not cache a failure: the next request asks again", async () => {
    let status = 500;
    const server = await resolver((_asked, res) =>
      status === 500 ? json(res, 500, {}) : json(res, 200, { headers: { authorization: "Bearer ok" } }),
    );
    const credentials = sources(server.url);
    expect(await credentials.authorize(session("u:priya"), { url: URL_A })).toMatchObject({ status: "refused" });
    status = 200;
    expect(await credentials.authorize(session("u:priya"), { url: URL_A })).toMatchObject({ status: "authorized" });
    expect(server.asked).toHaveLength(2);
  });

  it("asks once for many MCP requests, and per (owner, url)", async () => {
    const server = await resolver((asked, res) =>
      json(res, 200, { headers: { authorization: `Bearer for-${asked.body.owner}-${asked.body.target.url}` } }),
    );
    const credentials = sources(server.url);
    for (let n = 0; n < 5; n += 1)
      expect(await credentials.authorize(session("u:a"), { url: URL_A })).toMatchObject({
        headers: { authorization: `Bearer for-u:a-${URL_A}` },
      });
    expect(server.asked).toHaveLength(1);
    // Another session of the same person shares the answer; another person never does.
    expect(
      await credentials.authorize(session("u:a", { id: "s-other" }), { url: URL_A }),
    ).toMatchObject({ headers: { authorization: `Bearer for-u:a-${URL_A}` } });
    expect(await credentials.authorize(session("u:b"), { url: URL_A })).toMatchObject({
      headers: { authorization: `Bearer for-u:b-${URL_A}` },
    });
    expect(await credentials.authorize(session("u:a"), { url: `${URL_A}/other` })).toMatchObject({
      headers: { authorization: `Bearer for-u:a-${URL_A}/other` },
    });
    expect(server.asked.map((asked) => [asked.body.owner, asked.body.target.url])).toEqual([
      ["u:a", URL_A],
      ["u:b", URL_A],
      ["u:a", `${URL_A}/other`],
    ]);
  });

  it("joins concurrent misses for one key into one request, never across owners", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const server = await resolver(async (asked, res) => {
      await gate;
      json(res, 200, { headers: { authorization: `Bearer ${asked.body.owner}` } });
    });
    const credentials = sources(server.url);
    const pending = [
      ...Array.from({ length: 4 }, () => credentials.authorize(session("u:a"), { url: URL_A })),
      ...Array.from({ length: 3 }, () => credentials.authorize(session("u:b"), { url: URL_A })),
    ];
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    const results = await Promise.all(pending);
    expect(results.slice(0, 4).map((r) => (r as any).headers.authorization)).toEqual(
      Array(4).fill("Bearer u:a"),
    );
    expect(results.slice(4).map((r) => (r as any).headers.authorization)).toEqual(
      Array(3).fill("Bearer u:b"),
    );
    expect(server.asked.map((asked) => asked.body.owner).sort()).toEqual(["u:a", "u:b"]);
  });

  it("keeps an answer until expiresAt, at most 5 minutes, and 60 s without one (404s too)", async () => {
    let now = Date.parse("2030-01-01T00:00:00.000Z");
    let reply: Reply = (_a, res) =>
      json(res, 200, { headers: { authorization: "Bearer x" }, expiresAt: new Date(now + 30_000).toISOString() });
    const server = await resolver((asked, res) => reply(asked, res));
    const credentials = sources(server.url, { now: () => now });
    const ask = () => credentials.authorize(session("u:a"), { url: URL_A });

    await ask();
    now += 29_000;
    await ask();
    expect(server.asked).toHaveLength(1);
    now += 2_000; // past expiresAt
    await ask();
    expect(server.asked).toHaveLength(2);

    // A far expiry is capped at 5 minutes.
    reply = (_a, res) =>
      json(res, 200, { headers: { authorization: "Bearer x" }, expiresAt: new Date(now + 3_600_000).toISOString() });
    now += 60_000;
    await ask();
    expect(server.asked).toHaveLength(3);
    now += RESOLVER_MAX_CACHE_MS - 1;
    await ask();
    expect(server.asked).toHaveLength(3);
    now += 2;
    await ask();
    expect(server.asked).toHaveLength(4);

    // No expiry, and a 404: 60 s.
    reply = (_a, res) => json(res, 404, {});
    now += RESOLVER_MAX_CACHE_MS + 1;
    expect(await ask()).toMatchObject({ status: "unauthenticated" });
    expect(server.asked).toHaveLength(5);
    now += RESOLVER_DEFAULT_CACHE_MS - 1;
    expect(await ask()).toMatchObject({ status: "unauthenticated" });
    expect(server.asked).toHaveLength(5);
    now += 2;
    await ask();
    expect(server.asked).toHaveLength(6);
  });

  it("never asks when the vaults decided, the owner is reserved, or no resolver is set", async () => {
    const server = await resolver((_a, res) => json(res, 200, { headers: { authorization: "Bearer r" } }));
    const authorized: AuthorizeResult = { status: "authorized", url: URL_A, headers: { authorization: "Bearer v" } };
    const refused: AuthorizeResult = { status: "refused", url: URL_A, credentialIds: ["c"], reason: "ambiguous" };
    for (const result of [authorized, refused])
      expect(
        await sources(server.url, { vault: emptyVault(result).vault }).authorize(session("u:a"), { url: URL_A }),
      ).toEqual(result);
    for (const owner of ["installation", "host"])
      expect(await sources(server.url).authorize(session(owner), { url: URL_A })).toMatchObject({
        status: "unauthenticated",
      });
    const none = new CredentialSources({ vault: emptyVault().vault });
    expect(await none.authorize(session("u:a"), { url: URL_A })).toMatchObject({ status: "unauthenticated" });
    expect(server.asked).toEqual([]);
  });

  it("gives the vault the session's attached vaults and selections", async () => {
    const empty = emptyVault();
    const credentials = new CredentialSources({ vault: empty.vault });
    await credentials.authorize(
      session("u:a", { vaultIds: ["v1"], credentialSelections: [{ serverName: "github", credentialId: "c1" }] }),
      { url: URL_A, serverName: "github" },
    );
    expect(empty.calls).toEqual([
      {
        sessionId: "s-u:a",
        vaultIds: ["v1"],
        credentialSelections: [{ serverName: "github", credentialId: "c1" }],
        url: URL_A,
        serverName: "github",
      },
    ]);
  });
});
