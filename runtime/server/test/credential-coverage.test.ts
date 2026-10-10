/**
 * `POST /v1/tenant/credential-coverage`: what a session of a saved agent would send for each
 * remote MCP server and HTTP tool credential it declares, with the vaults it would attach, decided
 * as the session's calls decide it, and checked as its attachment is.
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, http } from "@nylorun/core/define";
import { credentialNeeds } from "../src/vault/coverage.js";
import { startTestTenant } from "./support/tenant.js";

const APP = "coverage-app-key-aaaaaaaaaaaaaaaaa";
const MANAGEMENT = "coverage-management-key-aaaaaaaaaa";
const KEK = Buffer.alloc(32, 9).toString("base64");
const TICKETS = "https://mcp.tickets.example/mcp";
const BILLING = "https://billing.example.com/refunds";
const DOCS = "https://docs.example.com/mcp/";
const SECRETS = ["tickets-secret-1a2b3c4d", "billing-secret-a-5e6f", "billing-secret-b-7a8b", "docs-secret-9c0d1e2f"];

const management = { authorization: `Bearer ${MANAGEMENT}`, "content-type": "application/json" };
const application = { authorization: `Bearer ${APP}`, "content-type": "application/json" };

type Started = Awaited<ReturnType<typeof startTestTenant>>;
const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close().catch(() => undefined);
});

async function call(
  runtime: Started,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = path.startsWith("/v1/tenant") ? management : application,
): Promise<{ status: number; body: any; text: string }> {
  const response = await fetch(`${runtime.url}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined, text };
}

const refund = http({
  name: "refund_order",
  description: "Refund an order.",
  input: z.object({ orderId: z.string() }),
  url: BILLING,
  credential: "billing",
});
const lookup = http({
  name: "lookup",
  description: "Look an order up.",
  input: z.object({ orderId: z.string() }),
  url: "https://orders.example.com/lookup",
});
const researcher = Agent({ id: "researcher", description: "Reads the docs." })
  .instructions("Read the docs.")
  // The default port is dropped when the vault compares URLs.
  .mcp({ docs: { type: "streamable-http", url: "https://docs.example.com:443/mcp/" } });
const triage = Agent({ id: "triage" })
  .instructions("Triage.")
  .mcp({ tickets: { type: "streamable-http", url: TICKETS } })
  .tools(refund, lookup)
  .subagents(researcher)
  .build();

async function boot() {
  const runtime = await startTestTenant({ applicationKey: APP, managementKey: MANAGEMENT, vaultKek: KEK });
  open.push(() => runtime.close());
  const saved = await call(runtime, "PUT", "/v1/agents/triage", {
    requestId: "put-triage",
    manifest: triage.manifest,
    implementationVersion: "dev",
  });
  expect(saved.status, saved.text).toBe(200);
  return runtime;
}

async function vault(runtime: Started, name: string, owner?: string) {
  const created = await call(runtime, "POST", "/v1/tenant/vaults", {
    requestId: `vault-${name}`,
    idempotencyKey: `vault-${name}`,
    name,
    ...(owner ? { ownerUserId: owner } : { scope: "installation" }),
  });
  expect(created.status, created.text).toBe(200);
  return created.body.id as string;
}

async function credential(runtime: Started, vaultId: string, name: string, url: string, token: string) {
  const created = await call(runtime, "POST", `/v1/tenant/vaults/${vaultId}/credentials`, {
    requestId: `cred-${token}`,
    idempotencyKey: `cred-${token}`,
    name,
    auth: { type: "bearer", url, token },
  });
  expect(created.status, created.text).toBe(200);
  return created.body.id as string;
}

const coverage = (runtime: Started, body: Record<string, unknown>) =>
  call(runtime, "POST", "/v1/tenant/credential-coverage", { agentId: "triage", ...body });

/** The entries by name, with what a test compares. */
const byName = (body: { entries: any[] }) =>
  Object.fromEntries(
    body.entries.map((entry) => [
      entry.name,
      {
        status: entry.status,
        credential: entry.credential?.credentialId,
        matches: entry.matches.map((item: { credentialId: string }) => item.credentialId),
        available: entry.available.map((item: { vaultId: string }) => item.vaultId),
      },
    ]),
  );

describe("credentialNeeds", () => {
  it("lists an agent's credentialed HTTP tools and MCP servers in capability order, then its agents'", () => {
    expect(credentialNeeds(triage.manifest)).toEqual([
      { kind: "http", name: "refund_order", serverName: "billing", url: BILLING },
      { kind: "mcp", name: "tickets", serverName: "tickets", url: TICKETS },
      {
        kind: "mcp",
        agentId: "researcher",
        name: "docs",
        serverName: "docs",
        url: "https://docs.example.com:443/mcp/",
      },
    ]);
  });

  it("lists a flow's HTTP stages under their stage keys, and its agents' needs", () => {
    const stage = http({
      name: "open_pr",
      input: z.object({ summary: z.string() }),
      url: "https://ci.example.com/pull-requests",
      credential: "github",
    });
    const writer = Agent({ id: "writer" })
      .instructions("Write.")
      .mcp({ tickets: { type: "streamable-http", url: TICKETS } })
      .output(z.object({ summary: z.string() }));
    const flow = Agent({ id: "ship" }).pipe(writer, stage).build();
    expect(credentialNeeds(flow.manifest)).toEqual([
      {
        kind: "http",
        stage: "open_pr",
        name: "open_pr",
        serverName: "github",
        url: "https://ci.example.com/pull-requests",
      },
      { kind: "mcp", agentId: "writer", name: "tickets", serverName: "tickets", url: TICKETS },
    ]);
  });
});

describe("POST /v1/tenant/credential-coverage", () => {
  it("says what each declared URL would get, and where a missing credential is", async () => {
    const runtime = await boot();
    const tools = await vault(runtime, "tools");
    const billingA = await vault(runtime, "billing-a");
    const billingB = await vault(runtime, "billing-b");
    const ada = await vault(runtime, "ada", "ada");
    const ticketsKey = await credential(runtime, tools, "tickets", TICKETS, SECRETS[0]!);
    const billingKeyA = await credential(runtime, billingA, "billing", BILLING, SECRETS[1]!);
    const billingKeyB = await credential(runtime, billingB, "billing", BILLING, SECRETS[2]!);
    const docsKey = await credential(runtime, ada, "docs", DOCS, SECRETS[3]!);

    // No vaults attached: nothing is covered, and the installation's vaults are where to look.
    const none = await coverage(runtime, {});
    expect(none.status, none.text).toBe(200);
    expect(none.body).toMatchObject({ agentId: "triage", vaultIds: [], complete: false });
    expect(byName(none.body)).toEqual({
      tickets: { status: "missing", credential: undefined, matches: [], available: [tools] },
      refund_order: { status: "missing", credential: undefined, matches: [], available: [billingA, billingB] },
      // A person's vault is no place to look for a session without that person.
      docs: { status: "missing", credential: undefined, matches: [], available: [] },
    });
    const missing = none.body.entries.find((entry: { name: string }) => entry.name === "refund_order");
    expect(missing).toMatchObject({ required: true, serverName: "billing" });
    expect(missing.message).toContain("http.credential");
    expect(missing.message).toContain("Vaults 'billing-a', 'billing-b' hold one: attach one of them.");
    const tickets = none.body.entries.find((entry: { name: string }) => entry.name === "tickets");
    expect(tickets).toMatchObject({ kind: "mcp", required: false });
    expect(tickets.message).toContain("Vault 'tools' holds one: attach it.");

    // Ada's session with every vault: two billing keys are ambiguous until a selection picks one.
    const all = await coverage(runtime, { ownerUserId: "ada", vaultIds: [tools, billingA, billingB, ada] });
    expect(all.status, all.text).toBe(200);
    expect(all.body.complete).toBe(false);
    expect(byName(all.body)).toEqual({
      tickets: { status: "covered", credential: ticketsKey, matches: [ticketsKey], available: [] },
      refund_order: {
        status: "ambiguous",
        credential: undefined,
        matches: [billingKeyA, billingKeyB].sort(),
        available: [],
      },
      docs: { status: "covered", credential: docsKey, matches: [docsKey], available: [] },
    });
    // The manifest's `:443` is dropped, as the vault compares URLs.
    expect(all.body.entries.find((entry: { name: string }) => entry.name === "docs")).toMatchObject({
      agentId: "researcher",
      url: DOCS,
    });

    const selected = await coverage(runtime, {
      ownerUserId: "ada",
      vaultIds: [tools, billingA, billingB, ada],
      credentialSelections: [{ serverName: "billing", credentialId: billingKeyB }],
    });
    expect(selected.body.complete).toBe(true);
    expect(byName(selected.body).refund_order).toMatchObject({ status: "covered", credential: billingKeyB });
    expect(selected.body.entries.find((entry: { name: string }) => entry.name === "refund_order").credential).toEqual({
      vaultId: billingB,
      vaultName: "billing-b",
      credentialId: billingKeyB,
      credentialName: "billing",
    });

    // A selection naming a credential bound to another URL refuses the call.
    const mismatch = await coverage(runtime, {
      vaultIds: [tools, billingA],
      credentialSelections: [{ serverName: "billing", credentialId: ticketsKey }],
    });
    expect(byName(mismatch.body).refund_order.status).toBe("selection_mismatch");

    // Nothing holds a secret.
    for (const answer of [none, all, selected, mismatch])
      for (const secret of SECRETS) expect(answer.text).not.toContain(secret);
  });

  it("checks the attachment as a session does, and is the Management API's", async () => {
    const runtime = await boot();
    const ada = await vault(runtime, "ada", "ada");
    const tools = await vault(runtime, "tools");

    expect((await coverage(runtime, { vaultIds: [ada] })).status).toBe(403);
    expect((await coverage(runtime, { ownerUserId: "cleo", vaultIds: [ada] })).status).toBe(403);
    expect((await coverage(runtime, { vaultIds: ["vlt-missing"] })).status).toBe(404);
    expect((await coverage(runtime, { vaultIds: [tools, tools] })).status).toBe(400);
    const outside = await coverage(runtime, {
      vaultIds: [tools],
      credentialSelections: [{ serverName: "billing", credentialId: "crd-missing" }],
    });
    expect(outside.status).toBe(400);
    expect((await coverage(runtime, { agentId: "ghost" })).status).toBe(404);

    const app = await call(runtime, "POST", "/v1/tenant/credential-coverage", { agentId: "triage" }, application);
    expect(app.status).toBe(403);
    expect(app.body.code).toBe("key_role_mismatch");
  });

  it("is empty and complete for an agent that names no credentials", async () => {
    const runtime = await boot();
    const plain = Agent({ id: "plain" }).instructions("Hi.").tools(lookup).build();
    expect(
      (await call(runtime, "PUT", "/v1/agents/plain", { requestId: "p", manifest: plain.manifest, implementationVersion: "dev" }))
        .status,
    ).toBe(200);
    const answer = await coverage(runtime, { agentId: "plain" });
    expect(answer.body).toEqual({ agentId: "plain", vaultIds: [], complete: true, entries: [] });
  });
});
