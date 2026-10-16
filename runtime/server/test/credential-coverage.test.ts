/**
 * `POST /v1/tenant/credential-coverage`: what a session on an Agent would send for each remote
 * MCP server and HTTP tool credential its manifest version declares, decided as the session's
 * calls decide it: the Agent's secret bound to the URL, or none.
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, http } from "@nylorun/core/define";
import { credentialNeeds } from "../src/vault/coverage.js";
import { deploy, manifestOf, putAgent, putSecret, saveManifest } from "./support/agents.js";
import { startTestTenant } from "./support/tenant.js";

const APP = "coverage-app-key-aaaaaaaaaaaaaaaaa";
const MANAGEMENT = "coverage-management-key-aaaaaaaaaa";
const KEK = Buffer.alloc(32, 9).toString("base64");
const TICKETS = "https://mcp.tickets.example/mcp";
const BILLING = "https://billing.example.com/refunds";
const DOCS = "https://docs.example.com/mcp/";
const SECRETS = ["tickets-secret-1a2b3c4d", "billing-secret-a-5e6f", "billing-secret-b-7a8b", "docs-secret-9c0d1e2f"];

const GATEWAY = "https://gateway.example.com/billing";

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

/**
 * Saves `triage` with its secret slots (the HTTP tool's `credential` names `billing`, a bearer
 * through a gateway) and makes Agent `triage` from it, whose vault holds nothing.
 */
async function boot() {
  const runtime = await startTestTenant({ applicationKey: APP, managementKey: MANAGEMENT, vaultKek: KEK });
  open.push(() => runtime.close());
  await saveManifest(
    runtime.url,
    application,
    manifestOf(triage, {
      runtime: {
        kind: "none",
        secrets: {
          tickets: { type: "bearer", url: TICKETS },
          docs: { type: "bearer", url: DOCS },
          billing: { type: "bearer", url: BILLING, via: GATEWAY },
        },
      },
    }),
  );
  await agent(runtime, "triage");
  return runtime;
}

async function agent(runtime: Started, id: string) {
  await putAgent(runtime.url, application, id, { manifest: "triage" });
}

/** Writes slot `name`'s value into Agent `agentId`'s vault. */
async function secret(runtime: Started, agentId: string, name: string, token: string) {
  await putSecret(runtime.url, application, agentId, name, { value: token });
}

const coverage = (runtime: Started, body: Record<string, unknown>) =>
  call(runtime, "POST", "/v1/tenant/credential-coverage", { agentId: "triage", ...body });

/** The entries by name, with what a test compares. */
const byName = (body: { entries: any[] }) =>
  Object.fromEntries(
    body.entries.map((entry) => [entry.name, { status: entry.status, credential: entry.credential }]),
  );

describe("credentialNeeds", () => {
  it("lists an agent's credentialed HTTP tools, then its MCP servers, then its agents'", () => {
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
  it("says what each declared URL would get on an Agent, and what a missing one does", async () => {
    const runtime = await boot();
    await agent(runtime, "support/triage");
    await secret(runtime, "support/triage", "tickets", SECRETS[0]!);
    // The manifest's `:443` is dropped, as the vault compares URLs.
    await secret(runtime, "support/triage", "docs", SECRETS[3]!);

    // An Agent whose vault holds nothing: nothing is sent.
    const none = await coverage(runtime, {});
    expect(none.status, none.text).toBe(200);
    expect(none.body).toMatchObject({ agentId: "triage", complete: false });
    expect(none.body).not.toHaveProperty("environmentId");
    expect(byName(none.body)).toEqual({
      tickets: { status: "missing", credential: undefined },
      refund_order: { status: "missing", credential: undefined },
      docs: { status: "missing", credential: undefined },
    });
    const missing = none.body.entries.find((entry: { name: string }) => entry.name === "refund_order");
    expect(missing).toMatchObject({ kind: "http", required: true, serverName: "billing", url: BILLING });
    expect(missing.message).toBe("Agent triage holds no credential for this URL: each call fails with http.credential.");
    const tickets = none.body.entries.find((entry: { name: string }) => entry.name === "tickets");
    expect(tickets).toMatchObject({ kind: "mcp", required: false });
    expect(tickets.message).toContain("only a public server accepts");

    // The Agent covers two of three.
    const some = await coverage(runtime, { agentId: "support/triage" });
    expect(some.status, some.text).toBe(200);
    expect(some.body).toMatchObject({ agentId: "support/triage", complete: false });
    expect(byName(some.body)).toEqual({
      tickets: { status: "covered", credential: { agentId: "support/triage", name: "tickets" } },
      refund_order: { status: "missing", credential: undefined },
      docs: { status: "covered", credential: { agentId: "support/triage", name: "docs" } },
    });
    expect(some.body.entries.find((entry: { name: string }) => entry.name === "docs")).toMatchObject({
      agentId: "researcher",
      url: DOCS,
      message: "Sends 'docs' from Agent support/triage.",
    });
    expect(some.body.entries.find((entry: { name: string }) => entry.name === "refund_order").message).toBe(
      "Agent support/triage holds no credential for this URL: each call fails with http.credential.",
    );

    // With the billing key, through the slot's gateway, it is complete.
    await secret(runtime, "support/triage", "billing", SECRETS[1]!);
    const all = await coverage(runtime, { agentId: "support/triage" });
    expect(all.body.complete).toBe(true);
    expect(all.body.entries.find((entry: { name: string }) => entry.name === "refund_order")).toMatchObject({
      status: "covered",
      credential: { agentId: "support/triage", name: "billing", via: GATEWAY },
      message: `Sends 'billing' from Agent support/triage through ${GATEWAY}.`,
    });

    // Another Agent's secrets are not this one's.
    await agent(runtime, "support/other");
    await secret(runtime, "support/other", "billing", SECRETS[2]!);
    expect(byName((await coverage(runtime, { agentId: "support/other" })).body)).toEqual({
      tickets: { status: "missing", credential: undefined },
      refund_order: { status: "covered", credential: { agentId: "support/other", name: "billing", via: GATEWAY } },
      docs: { status: "missing", credential: undefined },
    });

    // Nothing holds a secret.
    for (const answer of [none, some, all])
      for (const value of SECRETS) expect(answer.text).not.toContain(value);
  });

  it("refuses a missing Agent, and is the Management API's", async () => {
    const runtime = await boot();
    expect((await coverage(runtime, { agentId: "missing" })).status).toBe(404);
    expect((await coverage(runtime, { agentId: "not an id" })).status).toBe(400);
    // The old requests' fields are gone (protocols 11 and 16).
    expect((await coverage(runtime, { vaultIds: [] })).status).toBe(400);
    expect((await coverage(runtime, { environmentId: "support/triage" })).status).toBe(400);

    const app = await call(runtime, "POST", "/v1/tenant/credential-coverage", { agentId: "triage" }, application);
    expect(app.status).toBe(403);
    expect(app.body.code).toBe("key_role_mismatch");
  });

  it("is empty and complete for an agent that names no credentials", async () => {
    const runtime = await boot();
    await deploy(runtime.url, application, Agent({ id: "plain" }).instructions("Hi.").tools(lookup).build());
    const answer = await coverage(runtime, { agentId: "plain" });
    expect(answer.body).toEqual({ agentId: "plain", complete: true, entries: [] });
  });
});
