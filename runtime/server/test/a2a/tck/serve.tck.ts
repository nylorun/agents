/**
 * The example agent the A2A TCK runs against (A2A-E18, `.github/workflows/a2a-tck.yml`): a Runtime
 * with one Agent, `tck`, published over A2A, behind a small app server that does what an app
 * server does for its partners (README "Serving people through an app server"): it holds the
 * application key, acts for one subject, serves the agent's card at
 * `/.well-known/agent-card.json` (where the TCK looks) with its own JSON-RPC URL, and relays
 * `POST /a2a` and the task files (`/v1/a2a/files/…`) to the Runtime.
 *
 * The agent's model is scripted: every message completes the task with "Hello from TCK", the
 * TCK's default scenario. The scenarios that need an agent to act on the message id (input
 * required, rejection, a direct message) are not scripted: what they test is listed with the known
 * failures (`../tck-known-failures.txt`).
 *
 * Runs only with NYLORUN_A2A_TCK=1, and serves until the process is stopped.
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFile } from "node:fs/promises";
import { it } from "vitest";
import { Agent, createClient } from "@nylorun/agents";
import type { ModelProvider } from "../../../src/core/provider.js";
import { startTestTenant } from "../../support/tenant.js";

const SUBJECT = "u:tck:partner";
const AGENT = "tck";

const model: ModelProvider = async () => ({ output: [{ type: "text", text: "Hello from TCK" }] });

it.runIf(process.env.NYLORUN_A2A_TCK === "1")("serves an example agent for the A2A TCK", async () => {
  const runtime = await startTestTenant({
    vaultKek: null,
    modelProvider: model,
    // Pushes reach the TCK's webhook receiver on this machine, on a port it picks.
    a2a: {
      push: {
        secret: `whsec_${Buffer.alloc(32, 1).toString("base64")}`,
        allowHosts: ["localhost:*", "127.0.0.1:*"],
      },
    },
  });
  const client = createClient({ url: runtime.url, key: runtime.applicationKey, tenant: runtime.tenantId });
  const agent = Agent({ id: AGENT, name: "TCK", description: "The Nylorun example agent the A2A TCK runs against." }).build();
  await client.agentManifests.save({ agent });
  await client.agents.put(AGENT, { manifest: AGENT });

  const port = Number(process.env.NYLORUN_A2A_TCK_PORT ?? 9999);
  const base = `http://localhost:${port}`;
  const started = new Date().toUTCString();
  const asSubject = { ...runtime.headers(), "Nylorun-Subject": SUBJECT, "Nylorun-Scopes": "sessions:own" };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const path = new URL(request.url ?? "/", base).pathname;
    const forward: Record<string, string> = { ...asSubject };
    for (const name of ["a2a-version", "a2a-extensions", "traceparent", "content-type", "range"]) {
      const value = request.headers[name];
      if (typeof value === "string") forward[name] = value;
    }
    const version = new URL(request.url ?? "/", base).searchParams.get("A2A-Version");
    let target: string;
    if (request.method === "GET" && path === "/.well-known/agent-card.json") {
      const card = await (await fetch(`${runtime.url}/v1/a2a/agents/${AGENT}/card`, { headers: asSubject })).json();
      const body = JSON.stringify({
        ...card,
        supportedInterfaces: [{ url: `${base}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
      });
      // As an app server publishing a card does: cacheable, with a validator.
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "public, max-age=300",
        etag: `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`,
        "last-modified": started,
      });
      return void response.end(body);
    }
    // The TCK posts to the interface URL with a trailing slash.
    if (request.method === "POST" && (path === "/a2a" || path === "/a2a/"))
      target = `${runtime.url}/v1/a2a/agents/${AGENT}${version ? `?A2A-Version=${encodeURIComponent(version)}` : ""}`;
    else if (request.method === "GET" && path.startsWith("/v1/a2a/files/")) target = `${runtime.url}${path}`;
    else return void response.writeHead(404).end();
    const answer = await fetch(target, {
      method: request.method!,
      headers: forward,
      ...(request.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
    });
    const headers: Record<string, string> = {};
    for (const name of ["content-type", "a2a-extensions", "content-range", "retry-after"]) {
      const value = answer.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    response.writeHead(answer.status, headers);
    response.end(Buffer.from(await answer.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(port, "0.0.0.0", resolve));
  const ready = process.env.NYLORUN_A2A_TCK_READY;
  if (ready) await writeFile(ready, `http://localhost:${(server.address() as AddressInfo).port}\n`);
  console.log(`A2A TCK example agent at ${base}`);
  // Until the workflow stops the process.
  await new Promise(() => undefined);
});
