/**
 * The exit test of track R2d step 1 (Environments, protocol 11; Agents since protocol 16), the
 * lines a Runtime without a cluster can run, end to end over the Runtime API the way an app
 * would, with the SDK (`@nylorun/agents`, protocol 16):
 *
 * - the app saves its agent manifests, makes Agent `users/alice/web` with Alice as its owner and
 *   writes her GitHub token and the team's npm token into it;
 * - one of her sessions writes into the workspace; a new session on her Agent finds it, and the
 *   shell sees each secret only as the sentinel `nylorun_managed`;
 * - Bob's session on her Agent is refused by the owner guard (an application key's `403`, the
 *   opaque `404` acting for Bob), and setting the guard later stops his next turn;
 * - a second credential for `github.com` is refused at the write;
 * - a `kind: none` Agent runs an MCP-only agent with its key, and a rotated key works on the next
 *   request;
 * - `lifecycle.deleteAfter` removes an unused Agent and its vault.
 *
 * The pod lines (a push through egress-gate with Alice's token, an image change at the next
 * wake with the disk intact) run in the full tier's kind job.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Agent, createClient, type AgentsClient } from "@nylorun/agents";
import type { ModelCall } from "@nylorun/core/define";
import type { ModelProvider } from "../src/core/provider.js";
import { startTestTenant } from "./support/tenant.js";

const APP = "r2d-exit-app-key-aaaaaaaaaaaaaaaa";
const GH_TOKEN = "ghp_exit-token-plaintext-1a2b3c";
const NPM_TOKEN = "npm_exit-token-plaintext-4d5e6f";
const LINEAR_KEY = "lin_exit-key-plaintext-7a8b9c";
const LINEAR_ROTATED = "lin_exit-key-rotated-0d1e2f";

interface Step {
  readonly name: string;
  readonly args: Record<string, unknown>;
}
let steps: Step[] = [];
let results: { status: string; text: string }[] = [];
let calls = 0;

/** The model makes the current script's calls in turn, keeping each result it sees. */
const model: ModelProvider = async (effect: { input: unknown }) => {
  const input = effect.input as ModelCall;
  const last = input.prompt.at(-1);
  if (last?.kind === "tool-result")
    results.push({
      status: last.status,
      text: last.content
        .filter((part) => part.type === "text")
        .map((part) => (part as { text: string }).text)
        .join(""),
    });
  const step = steps.shift();
  if (!step) return { output: [{ type: "text", text: "done" }] };
  calls += 1;
  return { output: [{ type: "tool-call", id: `call-${calls}`, name: step.name, args: step.args }] };
};

let linearKey = LINEAR_KEY;
let server: Server;
let linearUrl: string;
const linearSeen: (string | undefined)[] = [];

type Runtime = Awaited<ReturnType<typeof startTestTenant>>;
let runtime: Runtime;
let client: AgentsClient;

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${runtime.url}${path}`, {
    method,
    headers: { ...runtime.headers(), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, text, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
}

let sessions = 0;
/** Opens a session on Agent `agent` for `owner`, runs `script`, and waits. */
async function run(agent: string, owner: string, ...script: Step[]) {
  steps = [...script];
  results = [];
  sessions += 1;
  const session = await client.createSession({
    id: `r2d-${sessions}`,
    agent,
    ownerUserId: owner,
  });
  await session.input("go", { idempotencyKey: `m-${sessions}` });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const view = await session.inspect();
    if (["idle", "completed", "failed", "uncertain", "cancelled"].includes(view.status))
      return { status: view.status, results: [...results], session };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for the turn to settle: ${JSON.stringify(await session.inspect())}`);
}

beforeAll(async () => {
  // An MCP server that takes Linear's key as a bearer, and answers `401` to any other.
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") return void res.writeHead(405).end();
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    linearSeen.push(req.headers.authorization);
    if (req.headers.authorization !== `Bearer ${linearKey}`)
      return void res.writeHead(401, { "www-authenticate": 'Bearer error="invalid_token"' }).end("no");
    const mcp = new McpServer({ name: "linear", version: "0.0.0" });
    mcp.registerTool("issues", { description: "Lists issues.", inputSchema: { team: z.string() } }, async ({ team }) => ({
      content: [{ type: "text", text: `issues of ${team}` }],
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    res.on("close", () => {
      void transport.close().catch(() => {});
      void mcp.close().catch(() => {});
    });
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  linearUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;

  runtime = await startTestTenant({ applicationKey: APP, modelProvider: model });
  client = createClient({ url: runtime.url, key: runtime.applicationKey });
  const coder = Agent({ id: "coder" }).instructions("Write and review code in the workspace.").build();
  const network = { allowedHosts: ["github.com", "registry.npmjs.org"] };
  await client.agentManifests.save({ agent: coder, name: "web", runtime: { kind: "virtual", network } });
  await client.agentManifests.save({
    agent: coder,
    name: "scratch",
    runtime: { kind: "virtual", lifecycle: { deleteAfter: "1s" } },
  });
  // No runtime section: an Agent made from it is of kind none.
  await client.agentManifests.save({
    agent: Agent({ id: "triage" }).mcp({ linear: { type: "streamable-http", url: linearUrl } }).build(),
  });
}, 60_000);

afterAll(async () => {
  await runtime?.close();
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
});

describe("the R2d exit, step 1", { timeout: 60_000 }, () => {
  it("an app makes Alice's Agent and writes her GitHub token and the team npm token into it", async () => {
    const agent = await client.agents.put("users/alice/web", {
      manifest: "web",
      labels: { user: "alice" },
      owner: "alice",
    });
    expect(agent).toMatchObject({
      id: "users/alice/web",
      manifest: "web",
      resolvedVersion: 1,
      kind: "virtual",
      owner: "alice",
      runtime: { network: { allowedHosts: ["github.com", "registry.npmjs.org"] }, harness: "nylorun" },
    });
    await client.agents.secrets.put("users/alice/web", "GH_TOKEN", {
      type: "environment_secret",
      value: GH_TOKEN,
      allowedHosts: ["github.com"],
      inject: { header: "Authorization", format: "Basic {base64:x-access-token:{value}}" },
    });
    await client.agents.secrets.put("users/alice/web", "NPM_TOKEN", {
      type: "environment_secret",
      value: NPM_TOKEN,
      allowedHosts: ["registry.npmjs.org"],
    });
    const listed = await api("GET", "/v1/agents/users%2Falice%2Fweb/secrets");
    expect(listed.status).toBe(200);
    expect(listed.body.secrets.map((secret: { name: string }) => secret.name)).toEqual(["GH_TOKEN", "NPM_TOKEN"]);
    // Write-only: no value in any answer.
    for (const secret of [GH_TOKEN, NPM_TOKEN]) expect(listed.text).not.toContain(secret);
  });

  it("one of her sessions writes into the workspace; a new one on her Agent finds it, and the shell sees only the sentinel", async () => {
    const coder = await run("users/alice/web", "alice", {
      name: "write",
      args: { path: "app/README.md", content: "cloned by the coder\n" },
    });
    expect(coder.status, JSON.stringify(coder.results)).toBe("completed");
    expect(coder.results.map((result) => result.status)).toEqual(["completed"]);

    const reviewer = await run(
      "users/alice/web",
      "alice",
      { name: "read", args: { path: "app/README.md" } },
      { name: "bash", args: { command: 'echo "token=$GH_TOKEN npm=$NPM_TOKEN"' } },
    );
    expect(reviewer.status, JSON.stringify(reviewer.results)).toBe("completed");
    expect(reviewer.results[0]!.text).toContain("cloned by the coder");
    expect(reviewer.results[1]!.text).toContain("token=nylorun_managed npm=nylorun_managed");
    for (const result of reviewer.results) {
      expect(result.text).not.toContain(GH_TOKEN);
      expect(result.text).not.toContain(NPM_TOKEN);
    }
    const view = await client.session(reviewer.session.id).inspect();
    expect(view).toMatchObject({ agentId: "users/alice/web", manifest: { name: "web", version: 1 } });
  });

  it("Bob's session is refused by the owner guard; acting for Bob it is the 404 of a missing one", async () => {
    const asApp = await api("PUT", "/v1/sessions/bob-1", {
      requestId: "bob-1",
      agent: "users/alice/web",
      ownerUserId: "bob",
    });
    expect(asApp.status, asApp.text).toBe(403);
    expect(asApp.body.code).toBe("agent_owner_mismatch");
    const asBob = await api(
      "PUT",
      "/v1/sessions/bob-2",
      { requestId: "bob-2", agent: "users/alice/web", ownerUserId: "bob" },
      { "nylorun-subject": "bob", "nylorun-scopes": "sessions:own" },
    );
    expect(asBob.status, asBob.text).toBe(404);
  });

  it("a guard set later stops another owner's next turn", async () => {
    await client.agents.put("teams/shared", { manifest: "web" });
    const bob = await run("teams/shared", "bob", { name: "bash", args: { command: "true" } });
    expect(bob.status).toBe("completed");
    await client.agents.put("teams/shared", { manifest: "web", owner: "alice" });
    const refused = await api("POST", `/v1/sessions/${bob.session.id}/commands`, {
      requestId: "again",
      idempotencyKey: "again",
      type: "message",
      content: "again",
    });
    expect(refused.status, refused.text).toBe(403);
    expect(refused.body.code).toBe("agent_owner_mismatch");
  });

  it("a second credential for github.com is refused at the write", async () => {
    const refused = await api("PUT", "/v1/agents/users%2Falice%2Fweb/secrets/GITHUB_ALT", {
      type: "environment_secret",
      value: "ghp_other",
      allowedHosts: ["api.github.com", "github.com"],
    });
    expect(refused.status, refused.text).toBe(409);
    expect(refused.body).toMatchObject({
      code: "credential_conflict",
      details: { host: "github.com", existing: "GH_TOKEN" },
    });
  });

  it("a kind none Agent runs an MCP-only agent with its key, and a rotated key works on the next request", async () => {
    const none = await client.agents.put("users/alice/linear", { manifest: "triage", owner: "alice" });
    expect(none).toMatchObject({ kind: "none", state: "sleeping", compute: { state: "ready" } });
    await client.agents.secrets.put("users/alice/linear", "linear", {
      type: "bearer",
      url: linearUrl,
      value: LINEAR_KEY,
    });
    const first = await run("users/alice/linear", "alice", {
      name: "linear__issues",
      args: { team: "web" },
    });
    expect(first.status, JSON.stringify(first.results)).toBe("completed");
    expect(first.results).toEqual([{ status: "completed", text: expect.stringContaining("issues of web") }]);

    // The server now takes only the new key; the app rotates it.
    linearKey = LINEAR_ROTATED;
    await client.agents.secrets.put("users/alice/linear", "linear", {
      type: "bearer",
      url: linearUrl,
      value: LINEAR_ROTATED,
    });
    const second = await run("users/alice/linear", "alice", {
      name: "linear__issues",
      args: { team: "api" },
    });
    expect(second.status, JSON.stringify(second.results)).toBe("completed");
    expect(second.results[0]!.text).toContain("issues of api");
    expect(linearSeen.at(-1)).toBe(`Bearer ${LINEAR_ROTATED}`);
  });

  it("lifecycle.deleteAfter removes an unused Agent and its vault", async () => {
    await client.agents.put("users/alice/scratch", { manifest: "scratch" });
    await client.agents.secrets.put("users/alice/scratch", "REGION", {
      type: "environment_variable",
      value: "eu-west-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await runtime.handle.worker!.sweep();
    const gone = await api("GET", "/v1/agents/users%2Falice%2Fscratch");
    expect(gone.status).toBe(404);
    const secrets = await api("GET", "/v1/agents/users%2Falice%2Fscratch/secrets");
    expect(secrets.status).toBe(404);
    const events = await client.agents.events("users/alice/scratch");
    expect(events.at(-1)).toMatchObject({ type: "agent.deleted", payload: { reason: "deleteAfter" } });
    // One in use stays.
    expect((await client.agents.get("users/alice/web")).id).toBe("users/alice/web");
  });
});
