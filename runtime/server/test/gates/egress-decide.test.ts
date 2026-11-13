/**
 * The keys provider's decide route (ADR-142, `gates/egress-decide.ts`): the verified actor must be
 * the sandbox's current incarnation; a vault binding wins and returns the header value; a host the
 * outside source lists for the owner, inside the ceiling, is allowed with no value; anything else
 * is not found. The token gates the route, and the route is off without one.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { decide, egressDecideHandler, EGRESS_DECIDE_PATH, type EgressDecideOptions } from "../../src/gates/egress-decide.js";
import type { CredentialProvider } from "../../src/gates/credential-provider.js";
import type { EgressCredentialRelease } from "../../src/gates/egress-credentials.js";

const TOKEN = "a".repeat(64);
const quiet = { info() {}, warn() {}, error() {}, debug() {} } as never;

function provider(hosts: readonly string[]): CredentialProvider {
  return {
    url: "http://source",
    environment: async () => [],
    hosts: async () => hosts,
    forwardUrl: (path) => new URL(`http://source/v1/forward${path}`),
    forwardHeaders: () => ({}),
  };
}

function options(over: Partial<EgressDecideOptions> & { bound?: Record<string, EgressCredentialRelease> } = {}): EgressDecideOptions {
  const bound = over.bound ?? {};
  return {
    token: TOKEN,
    logger: quiet,
    sandboxes: {
      live: async (id) =>
        id === "local/probe"
          ? { name: "sbx-abc-g1", owner: "u:acme:ana", ceiling: ["*.github.com", "api.vercel.com"] }
          : id === "no-owner"
            ? { name: "sbx-def-g0" }
            : undefined,
    },
    release: async (_id, host) => bound[host] ?? { status: "none" },
    ...over,
  };
}

describe("decide", () => {
  const input = { actor: "sbx-abc-g1", sandboxId: "local/probe", host: "api.openai.com" };

  it("returns the vault's header value for a bound host", async () => {
    const d = await decide(
      options({ bound: { "api.openai.com": { status: "released", header: "Authorization", value: "Bearer sk-real", credentialId: "cred_1" } } }),
      input,
    );
    expect(d).toMatchObject({ status: 200, body: { value: "Bearer sk-real" }, outcome: "vault", credentialId: "cred_1" });
  });

  it("refuses an actor that is not the sandbox's current incarnation", async () => {
    expect(await decide(options(), { ...input, actor: "sbx-abc-g0" })).toMatchObject({ status: 403 });
    expect(await decide(options(), { ...input, sandboxId: "gone" })).toMatchObject({ status: 403 });
  });

  it("refuses when the vault cannot read the secret", async () => {
    const d = await decide(options({ bound: { "api.openai.com": { status: "refused", reason: "ambiguous" } } }), input);
    expect(d).toMatchObject({ status: 403, outcome: "vault_ambiguous" });
  });

  it("allows a host the owner connected, with no value, inside the ceiling", async () => {
    const d = await decide(options({ provider: provider(["api.github.com"]) }), { ...input, host: "api.github.com" });
    expect(d).toEqual({
      status: 200,
      body: { fetch: { agentId: "local/probe", owner: "u:acme:ana", host: "api.github.com" } },
      outcome: "outside",
    });
    expect(JSON.stringify(d)).not.toContain("gho_");
  });

  it("refuses an owner's host outside the ceiling, and finds nothing for an Agent with no owner", async () => {
    expect(await decide(options({ provider: provider(["api.stripe.com"]) }), { ...input, host: "api.stripe.com" })).toMatchObject({
      status: 403,
      outcome: "outside_ceiling",
    });
    expect(
      await decide(options({ provider: provider(["api.github.com"]) }), { actor: "sbx-def-g0", sandboxId: "no-owner", host: "api.github.com" }),
    ).toMatchObject({ status: 404 });
  });

  it("finds nothing for a host with no key", async () => {
    expect(await decide(options({ provider: provider([]) }), input)).toMatchObject({ status: 404, code: "not_found" });
  });
});

describe("the route", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  async function serve(opts: EgressDecideOptions): Promise<string> {
    const handler = egressDecideHandler(opts);
    server = createServer((req, res) => {
      if (handler(req, res)) return;
      res.writeHead(405).end();
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  const body = JSON.stringify({ actor: "sbx-abc-g1", sandboxId: "local/probe", host: "api.openai.com" });

  it("answers the keys provider with its token, and refuses without it", async () => {
    const url = await serve(
      options({ bound: { "api.openai.com": { status: "released", header: "Authorization", value: "Bearer sk-real", credentialId: "c" } } }),
    );
    const ok = await fetch(url + EGRESS_DECIDE_PATH, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ value: "Bearer sk-real" });
    const wrong = await fetch(url + EGRESS_DECIDE_PATH, { method: "POST", headers: { authorization: `Bearer ${"b".repeat(64)}` }, body });
    expect(wrong.status).toBe(401);
    const bad = await fetch(url + EGRESS_DECIDE_PATH, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "{}" });
    expect(bad.status).toBe(400);
    const other = await fetch(url + "/other", { method: "POST", body });
    expect(other.status).toBe(405);
  });

  it("is off without a token", async () => {
    const { token: _token, ...rest } = options();
    const url = await serve(rest);
    const off = await fetch(url + EGRESS_DECIDE_PATH, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body });
    expect(off.status).toBe(404);
  });

  it("answers 503 when the decision fails", async () => {
    const url = await serve(
      options({
        sandboxes: {
          live: async () => {
            throw new Error("store down");
          },
        },
      }),
    );
    const down = await fetch(url + EGRESS_DECIDE_PATH, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body });
    expect(down.status).toBe(503);
  });
});
