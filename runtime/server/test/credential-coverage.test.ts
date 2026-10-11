/**
 * `POST /v1/tenant/credential-coverage`: what a session of a saved agent would send for each
 * remote MCP server and HTTP tool credential it declares, in the Environment it would name, decided
 * as the session's calls decide it: the Environment's secret bound to the URL, or none.
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

async function environment(runtime: Started, id: string) {
  const created = await call(runtime, "PUT", `/v1/environments/${encodeURIComponent(id)}`, { kind: "none" });
  expect(created.status, created.text).toBe(200);
}

async function secret(runtime: Started, environmentId: string, name: string, url: string, token: string, via?: string) {
  const created = await call(
    runtime,
    "PUT",
    `/v1/environments/${encodeURIComponent(environmentId)}/secrets/${name}`,
    { type: "bearer", url, value: token, ...(via ? { via } : {}) },
  );
  expect(created.status, created.text).toBe(200);
}

const coverage = (runtime: Started, body: Record<string, unknown>) =>
  call(runtime, "POST", "/v1/tenant/credential-coverage", { agentId: "triage", ...body });

/** The entries by name, with what a test compares. */
const byName = (body: { entries: any[] }) =>
  Object.fromEntries(
    body.entries.map((entry) => [entry.name, { status: entry.status, credential: entry.credential }]),
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
  it("says what each declared URL would get in an Environment, and what a missing one does", async () => {
    const runtime = await boot();
    await environment(runtime, "support/triage");
    await secret(runtime, "support/triage", "tickets", TICKETS, SECRETS[0]!);
    // The manifest's `:443` is dropped, as the vault compares URLs.
    await secret(runtime, "support/triage", "docs", DOCS, SECRETS[3]!);

    // No Environment: nothing is sent.
    const none = await coverage(runtime, {});
    expect(none.status, none.text).toBe(200);
    expect(none.body).toMatchObject({ agentId: "triage", environmentId: null, complete: false });
    expect(byName(none.body)).toEqual({
      tickets: { status: "missing", credential: undefined },
      refund_order: { status: "missing", credential: undefined },
      docs: { status: "missing", credential: undefined },
    });
    const missing = none.body.entries.find((entry: { name: string }) => entry.name === "refund_order");
    expect(missing).toMatchObject({ kind: "http", required: true, serverName: "billing", url: BILLING });
    expect(missing.message).toBe("Without an Environment, no credential is sent: each call fails with http.credential.");
    const tickets = none.body.entries.find((entry: { name: string }) => entry.name === "tickets");
    expect(tickets).toMatchObject({ kind: "mcp", required: false });
    expect(tickets.message).toContain("only a public server accepts");

    // The Environment covers two of three.
    const some = await coverage(runtime, { environmentId: "support/triage" });
    expect(some.status, some.text).toBe(200);
    expect(some.body).toMatchObject({ agentId: "triage", environmentId: "support/triage", complete: false });
    expect(byName(some.body)).toEqual({
      tickets: { status: "covered", credential: { environmentId: "support/triage", name: "tickets" } },
      refund_order: { status: "missing", credential: undefined },
      docs: { status: "covered", credential: { environmentId: "support/triage", name: "docs" } },
    });
    expect(some.body.entries.find((entry: { name: string }) => entry.name === "docs")).toMatchObject({
      agentId: "researcher",
      url: DOCS,
      message: "Sends 'docs' from Environment support/triage.",
    });
    expect(some.body.entries.find((entry: { name: string }) => entry.name === "refund_order").message).toBe(
      "Environment support/triage holds no credential for this URL: each call fails with http.credential.",
    );

    // With the billing key, through a gateway, it is complete.
    await secret(runtime, "support/triage", "billing", BILLING, SECRETS[1]!, "https://gateway.example.com/billing");
    const all = await coverage(runtime, { environmentId: "support/triage" });
    expect(all.body.complete).toBe(true);
    expect(all.body.entries.find((entry: { name: string }) => entry.name === "refund_order")).toMatchObject({
      status: "covered",
      credential: { environmentId: "support/triage", name: "billing", via: "https://gateway.example.com/billing" },
      message: "Sends 'billing' from Environment support/triage through https://gateway.example.com/billing.",
    });

    // Another Environment's secrets are not this one's.
    await environment(runtime, "support/other");
    await secret(runtime, "support/other", "billing", BILLING, SECRETS[2]!);
    expect(byName((await coverage(runtime, { environmentId: "support/other" })).body)).toEqual({
      tickets: { status: "missing", credential: undefined },
      refund_order: { status: "covered", credential: { environmentId: "support/other", name: "billing" } },
      docs: { status: "missing", credential: undefined },
    });

    // Nothing holds a secret.
    for (const answer of [none, some, all])
      for (const value of SECRETS) expect(answer.text).not.toContain(value);
  });

  it("refuses a missing agent or Environment, and is the Management API's", async () => {
    const runtime = await boot();
    expect((await coverage(runtime, { environmentId: "missing" })).status).toBe(404);
    expect((await coverage(runtime, { agentId: "ghost" })).status).toBe(404);
    expect((await coverage(runtime, { environmentId: "not an id" })).status).toBe(400);
    // The old request's fields are gone (protocol 11).
    expect((await coverage(runtime, { vaultIds: [] })).status).toBe(400);

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
    expect(answer.body).toEqual({ agentId: "plain", environmentId: null, complete: true, entries: [] });
  });
});
