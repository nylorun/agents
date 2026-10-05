import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runStackCommand } from "../../src/stack/commands.js";
import { mcpCommand } from "../../src/stack/mcp.js";
import { stackPaths } from "../../src/stack/paths.js";
import {
  bearerIn,
  fakeDocker,
  fakeFetch,
  fakeOperate,
  json,
  temporaryHome,
  testDeps,
  type FakeKeys,
} from "./support.js";

const TENANT_ID = "tn_01TESTSTACK000000000000001";
const MCP_URL = "https://mcp.example.com/mcp";
const AUTHORIZE = "https://auth.example.com/authorize?client_id=client-1&state=s";

const hostId = (home: string) =>
  (JSON.parse(readFileSync(stackPaths(home).config, "utf8")) as { hostId: string }).hostId;

const psUp = {
  code: 0,
  stdout: JSON.stringify([
    { Service: "gateway", State: "running", Health: "healthy" },
    { Service: "runtime", State: "running", Health: "healthy" },
    { Service: "harness", State: "running", Health: "healthy" },
    { Service: "studio", State: "running", Health: "healthy" },
  ]),
  stderr: "",
};

interface Fake {
  vaults: { id: string; name: string; ownerUserId: string; createdAt: string }[];
  credentials: { id: string; vaultId: string; name: string; type: "oauth" | "bearer"; binding: { url: string }; createdAt: string; rotatedAt?: string }[];
  /** Polls of the credentials after the start before the sign-in "finishes"; undefined: never. */
  finishAfter?: number;
  started?: Record<string, unknown>;
  startStatus?: number;
}

/** A running Tenant whose Runtime answers the vault routes, and whose sign-in finishes after a few polls. */
async function running(fake: Fake) {
  const home = await temporaryHome();
  const keys: FakeKeys = new Map();
  const operate = fakeOperate(() => keys);
  const docker = fakeDocker({ respond: (args) => (args.includes("ps") ? psUp : operate(args)) });
  let polls = 0;
  const fetch = fakeFetch((url, init) => {
    if (url.endsWith("/health")) return json({ status: "ok", version: "0.10.0-beta", hostId: hostId(home) });
    if (url.endsWith("/v1/admin/status"))
      return json({ tenant: { id: TENANT_ID, name: "home-root", state: "open", envelope: null } });
    if (url.endsWith("/_studio/login-tokens")) return json({ token: "t" }, 201);
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    if (path === "/v1/me")
      return bearerIn(keys.values(), init)
        ? json({ kind: "application" })
        : json({ status: "rejected", code: "not_found", message: "Not found" }, 404);
    // The vault routes are the Management API's: the management key cli-management.
    if (!bearerIn([keys.get("cli-management") ?? { key: "" }], init))
      return json({ status: "rejected", code: "key_role_mismatch", message: "A management key" }, 403);
    if (path === "/v1/tenant/vaults" && method === "GET") return json({ vaults: fake.vaults });
    if (path === "/v1/tenant/vaults" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { name: string; scope: string };
      expect(body.scope).toBe("installation");
      const vault = { id: `vault-${fake.vaults.length + 1}`, name: body.name, ownerUserId: "installation", createdAt: "2026-10-04T00:00:00.000Z" };
      fake.vaults.push(vault);
      return json(vault);
    }
    const start = /^\/v1\/tenant\/vaults\/([^/]+)\/oauth\/start$/.exec(path);
    if (start && method === "POST") {
      fake.started = { vaultId: decodeURIComponent(start[1]!), ...JSON.parse(String(init?.body)) };
      if (fake.startStatus)
        return json({ status: "rejected", code: "oauth_client_required", message: "The authorization server offers no dynamic client registration" }, fake.startStatus);
      return json({ authorizeUrl: AUTHORIZE, expiresAt: new Date(Date.now() + 600_000).toISOString() });
    }
    const list = /^\/v1\/tenant\/vaults\/([^/]+)\/credentials$/.exec(path);
    if (list && method === "GET") {
      const vaultId = decodeURIComponent(list[1]!);
      if (fake.started) {
        polls += 1;
        if (fake.finishAfter !== undefined && polls > fake.finishAfter) {
          const existing = fake.credentials.find((item) => item.vaultId === vaultId && item.binding.url === MCP_URL);
          if (existing) existing.rotatedAt = "2026-10-04T01:00:00.000Z";
          else
            fake.credentials.push({ id: "cred-new", vaultId, name: "linear", type: "oauth", binding: { url: MCP_URL }, createdAt: "2026-10-04T01:00:00.000Z" });
        }
      }
      return json({ credentials: fake.credentials.filter((item) => item.vaultId === vaultId) });
    }
    return undefined;
  });
  const deps = testDeps(home, { docker, fetch });
  await runStackCommand("start", ["--no-open"], deps);
  deps.lines.length = 0;
  deps.errors.length = 0;
  deps.opened.length = 0;
  return { deps, fetch, keys };
}

describe("nylorun mcp connect", () => {
  it("creates the installation vault mcp, starts the sign-in, opens the browser and waits for the credential", async () => {
    const fake: Fake = { vaults: [], credentials: [], finishAfter: 2 };
    const { deps, fetch, keys } = await running(fake);
    expect(await mcpCommand(deps, ["connect", "https://mcp.example.com:443/mcp", "--server", "linear"])).toBe(0);
    expect(fake.vaults).toEqual([expect.objectContaining({ id: "vault-1", name: "mcp", ownerUserId: "installation" })]);
    expect(fake.started).toEqual({ vaultId: "vault-1", url: MCP_URL, server: "linear" });
    expect(deps.opened).toEqual([AUTHORIZE]);
    expect(deps.lines).toEqual([
      "Sign in to linear in your browser:",
      `  ${AUTHORIZE}`,
      "Waiting for the sign-in to finish…",
      `Connected linear (${MCP_URL}): credential cred-new in installation vault vault-1.`,
      'Sessions use it when they attach the vault: vaultIds: ["vault-1"].',
    ]);
    const startRequest = fetch.requests.find((item) => item.url.endsWith("/oauth/start"))!;
    const headers = new Headers(startRequest.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${keys.get("cli-management")!.key}`);
    expect(headers.get("nylorun-protocol")).toBe("7");
  });

  it("reuses the vault mcp, passes --client-id, and sees a reconnect rotate the credential", async () => {
    const fake: Fake = {
      vaults: [{ id: "vault-9", name: "mcp", ownerUserId: "installation", createdAt: "2026-10-04T00:00:00.000Z" }],
      credentials: [
        { id: "cred-old", vaultId: "vault-9", name: "linear", type: "oauth", binding: { url: MCP_URL }, createdAt: "2026-10-03T00:00:00.000Z" },
      ],
      finishAfter: 1,
    };
    const { deps } = await running(fake);
    expect(
      await mcpCommand(deps, ["connect", MCP_URL, "--server", "linear", "--client-id", "my-app", "--no-open"]),
    ).toBe(0);
    expect(fake.vaults).toHaveLength(1);
    expect(fake.started).toEqual({ vaultId: "vault-9", url: MCP_URL, server: "linear", clientId: "my-app" });
    expect(deps.opened).toEqual([]);
    expect(deps.lines.at(-2)).toBe(`Connected linear (${MCP_URL}): credential cred-old in installation vault vault-9.`);
  });

  it("uses --vault as given, and reports the Runtime's refusal", async () => {
    const fake: Fake = { vaults: [], credentials: [], startStatus: 400 };
    const { deps } = await running(fake);
    await expect(
      mcpCommand(deps, ["connect", MCP_URL, "--server", "linear", "--vault", "shared"]),
    ).rejects.toMatchObject({ exitCode: 1, message: expect.stringContaining("no dynamic client registration") });
    expect(fake.started).toMatchObject({ vaultId: "shared" });
    expect(fake.vaults).toEqual([]);
  });

  it("checks its arguments", async () => {
    const { deps } = await running({ vaults: [], credentials: [] });
    for (const args of [[], ["connect"], ["connect", MCP_URL], ["connect", "not a url", "--server", "x"], ["connect", "ftp://x/y", "--server", "x"], ["nope"]])
      await expect(mcpCommand(deps, args), JSON.stringify(args)).rejects.toMatchObject({ exitCode: 2 });
  });
});
