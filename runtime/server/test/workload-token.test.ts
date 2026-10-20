/**
 * #496: the Runtime's workload token. A platform rotates it through a file
 * (`NYLORUN_WORKLOAD_TOKEN_FILE`), read at each use: a `workload` credential sends it as the
 * bearer to its `via` only, an origin the operator lists (`NYLORUN_WORKLOAD_TOKEN_ORIGINS`), and a
 * custom model with `auth: { type: "workload" }` sends it to its endpoint. A missing or empty file
 * fails closed, a gateway's `401` names the gateway, and the token reaches no event. With
 * `NYLORUN_TEST_MODEL_GATE=http` the gates service makes every call
 * (`gates/workload-token-gate.test.ts`); otherwise the Tenant does, in process.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Agent, createClient, type AgentsClient } from "@nylorun/agents";
import type { ModelProvider } from "../src/core/provider.js";
import {
  useWorkloadToken,
  workloadOriginRefused,
  workloadToken,
  WorkloadTokenUnavailable,
} from "../src/vault/workload-token.js";
import { deploy, writeSecret } from "./support/agents.js";
import { startTestTenant } from "./support/tenant.js";

const TOKEN_ONE = "workload-token-one-1a2b3c4d5e6f";
const TOKEN_TWO = "workload-token-two-7a8b9c0d1e2f";
const VENDOR_URL = "https://api.githubcopilot.com/mcp/";

let dir: string;
let file: string;
const servers: Server[] = [];

/**
 * A gateway that answers only the bearer `accepted` holds, keeping each request's bearer; with
 * `refuseCalls` it answers `401` to `tools/call` alone, as when the token expires mid-turn.
 */
async function gateway() {
  const bearers: string[] = [];
  const state = { accepted: TOKEN_ONE, refuseCalls: false };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") return void res.writeHead(405).end();
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    bearers.push(req.headers.authorization ?? "");
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { method?: string };
    if (req.headers.authorization !== `Bearer ${state.accepted}` || (state.refuseCalls && body.method === "tools/call"))
      return void res.writeHead(401).end();
    const mcp = new McpServer({ name: "gateway", version: "0.0.0" });
    mcp.registerTool("whoami", { description: "Who.", inputSchema: { value: z.string() } }, async () => ({
      content: [{ type: "text", text: `you are ${req.headers["x-user-id"]}` }],
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
  servers.push(server);
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url: `${origin}/mcp/github`, origin, bearers, state };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "workload-token-"));
  file = join(dir, "token");
});

afterAll(async () => {
  useWorkloadToken({});
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

describe("the workload token file", () => {
  it("is read at each use, so a rotation applies at once", async () => {
    useWorkloadToken({ file });
    await writeFile(file, `${TOKEN_ONE}\n`);
    expect(await workloadToken()).toBe(TOKEN_ONE);
    await writeFile(file, TOKEN_TWO);
    expect(await workloadToken()).toBe(TOKEN_TWO);
  });

  it("fails closed when unset, missing or empty, naming the setting and never a token", async () => {
    useWorkloadToken({});
    await expect(workloadToken()).rejects.toThrow(/NYLORUN_WORKLOAD_TOKEN_FILE/);
    useWorkloadToken({ file: join(dir, "missing") });
    await expect(workloadToken()).rejects.toBeInstanceOf(WorkloadTokenUnavailable);
    useWorkloadToken({ file });
    await writeFile(file, "  \n");
    await expect(workloadToken()).rejects.toThrow(/is empty/);
  });

  it("goes only to an origin the operator lists", () => {
    useWorkloadToken({ file, origins: ["https://gateway.example.com"] });
    expect(workloadOriginRefused("https://gateway.example.com/mcp/github")).toBeUndefined();
    expect(workloadOriginRefused("https://attacker.example.com/mcp")).toMatch(/NYLORUN_WORKLOAD_TOKEN_ORIGINS/);
    expect(workloadOriginRefused("http://gateway.example.com/mcp")).toBeDefined();
  });
});

describe("a workload credential (MCP through a gateway)", () => {
  type Runtime = Awaited<ReturnType<typeof startTestTenant>>;
  let runtime: Runtime;
  let client: AgentsClient;
  let gate: Awaited<ReturnType<typeof gateway>>;
  let sessions = 0;
  let seenByModel: { status?: string; payload?: Record<string, unknown> } | undefined;
  const model: ModelProvider = async (effect: { input: unknown }) => {
    const input = effect.input as { prompt?: { kind?: string; status?: string; content?: { text?: string }[] }[] };
    const last = input.prompt?.at(-1);
    if (last?.kind === "tool-result") {
      seenByModel = { status: last.status, payload: JSON.parse(last.content?.[0]?.text ?? "null") };
      return { output: [{ type: "text", text: "done" }] };
    }
    return { output: [{ type: "tool-call", id: "call-1", name: "github__whoami", args: { value: "x" } }] };
  };

  async function run() {
    seenByModel = undefined;
    sessions += 1;
    const session = await client.createSession({ id: `wl-${sessions}`, agent: "workload", ownerUserId: "u:ada" });
    await session.input("go", { idempotencyKey: `m${sessions}` });
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const view = await session.inspect();
      if (["idle", "completed", "failed", "uncertain", "cancelled"].includes(view.status)) {
        const history = await session.history();
        const items = history.items as { type: string; payload: Record<string, any> }[];
        return {
          completed: items.filter((item) => item.type === "tool.completed").map((item) => item.payload),
          discovered: items.find((item) => item.type === "mcp.discovered")?.payload,
          history: JSON.stringify(history),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("timeout waiting for the turn to settle");
  }

  beforeAll(async () => {
    gate = await gateway();
    runtime = await startTestTenant({ applicationKey: "workload-app-key-aaaaaaaaaaaaaaaaa", modelProvider: model });
    client = createClient({ url: runtime.url, key: runtime.applicationKey, tenant: runtime.tenantId });
    await deploy(runtime.url, runtime.headers(), Agent({ id: "workload" }).mcp({ github: { type: "streamable-http", url: VENDOR_URL } }).build(), {
      secrets: {
        github: { type: "workload", url: VENDOR_URL, via: gate.url, identity: { header: "x-user-id" } } as never,
      },
    });
  });

  afterAll(async () => {
    await runtime?.close();
  });

  it("sends the token in the file as the bearer to via, with the identity header, and a rotated one next", async () => {
    useWorkloadToken({ file, origins: [gate.origin] });
    await writeFile(file, TOKEN_ONE);
    const first = await run();
    expect(first.completed).toEqual([expect.objectContaining({ toolName: "github__whoami", output: "you are u:ada" })]);
    expect(new Set(gate.bearers)).toEqual(new Set([`Bearer ${TOKEN_ONE}`]));
    await writeFile(file, TOKEN_TWO);
    gate.state.accepted = TOKEN_TWO;
    const before = gate.bearers.length;
    const second = await run();
    expect(second.completed).toEqual([expect.objectContaining({ output: "you are u:ada" })]);
    expect(new Set(gate.bearers.slice(before))).toEqual(new Set([`Bearer ${TOKEN_TWO}`]));
    for (const token of [TOKEN_ONE, TOKEN_TWO]) {
      expect(first.history).not.toContain(token);
      expect(second.history).not.toContain(token);
    }
  });

  it("is credential_rejected naming the gateway when the gateway refuses the token", async () => {
    useWorkloadToken({ file, origins: [gate.origin] });
    await writeFile(file, TOKEN_ONE);
    gate.state.accepted = TOKEN_ONE;
    gate.state.refuseCalls = true;
    try {
      const result = await run();
      expect(seenByModel).toMatchObject({ status: "failed", payload: { code: "credential_rejected" } });
      expect(result.completed).toEqual([
        expect.objectContaining({
          error: expect.objectContaining({
            code: "credential_rejected",
            server: "github",
            gateway: gate.origin,
            message: expect.stringContaining(`The gateway ${gate.origin} answered HTTP 401`),
          }),
        }),
      ]);
      expect(result.history).not.toContain(TOKEN_ONE);
    } finally {
      gate.state.refuseCalls = false;
    }
  });

  it("sends nothing when the file is missing or via's origin is not listed", async () => {
    gate.state.accepted = TOKEN_ONE;
    useWorkloadToken({ file: join(dir, "missing"), origins: [gate.origin] });
    const before = gate.bearers.length;
    const missing = await run();
    expect(missing.discovered).toEqual({
      servers: [expect.objectContaining({ serverName: "github", outcome: "refused", message: expect.stringMatching(/NYLORUN_WORKLOAD_TOKEN_FILE/) })],
    });
    useWorkloadToken({ file, origins: ["https://gateway.example.com"] });
    await writeFile(file, TOKEN_ONE);
    const unlisted = await run();
    expect(unlisted.discovered).toEqual({
      servers: [expect.objectContaining({ outcome: "refused", message: expect.stringMatching(/NYLORUN_WORKLOAD_TOKEN_ORIGINS/) })],
    });
    expect(gate.bearers.length).toBe(before);
  });

  it("is listed with its via and no value, and needs via", async () => {
    const listed = await fetch(`${runtime.url}/v1/agents/workload/secrets`, { headers: runtime.headers() }).then(
      (response) => response.json() as Promise<{ secrets: Record<string, unknown>[] }>,
    );
    expect(listed.secrets).toContainEqual(
      expect.objectContaining({ name: "github", type: "workload", binding: { url: VENDOR_URL }, via: gate.url }),
    );
    const refused = await writeSecret(runtime.url, runtime.headers(), "workload", "nowhere", {
      type: "workload",
      url: "https://nowhere.test/mcp",
    } as never);
    expect(refused.status).toBe(400);
  });
});

describe("a custom model on the workload token", () => {
  const PROVIDER = "https://models.workload-test.invalid/v1";
  const realFetch = globalThis.fetch;

  it("sends the token in the file as the bearer, a rotated one next, and fails closed without it", async () => {
    const bearers: (string | null)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (!url.startsWith(PROVIDER)) return realFetch(input, init);
        bearers.push(new Headers(init?.headers).get("authorization"));
        const chunk = (delta: unknown, finish: string | null) =>
          `data: ${JSON.stringify({ id: "r", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        return new Response(`${chunk({ role: "assistant", content: "hello" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );
    const runtime = await startTestTenant({ useHostModel: true, modelCall: { retryBaseDelayMs: 1 } });
    try {
      const put = (body: Record<string, unknown>) =>
        realFetch(`${runtime.url}/v1/tenant/model`, {
          method: "PUT",
          headers: runtime.managementHeaders(),
          body: JSON.stringify({ requestId: "m", idempotencyKey: JSON.stringify(body), model: "gateway-model", ...body }),
        });
      expect((await put({ provider: "anthropic", model: "claude-sonnet-4-5", auth: { type: "workload" } })).status).toBe(400);
      expect((await put({ provider: "custom", baseUrl: PROVIDER, auth: { type: "workload" } })).status).toBe(200);
      const view = await realFetch(`${runtime.url}/v1/tenant/model`, { headers: runtime.managementHeaders() }).then(
        (response) => response.json() as Promise<{ authType?: string }>,
      );
      expect(view.authType).toBe("workload");
      const client = createClient({ url: runtime.url, key: runtime.applicationKey, tenant: runtime.tenantId });
      await deploy(runtime.url, runtime.headers(), Agent({ id: "bot", name: "Bot" }).instructions("Answer.").build());
      let turns = 0;
      const turn = async () => {
        turns += 1;
        const session = await client.createSession({ id: `m${turns}`, agent: "bot", ownerUserId: "ada" });
        await session.input("hi", { idempotencyKey: `m${turns}` });
        for (let attempt = 0; attempt < 400; attempt += 1) {
          const inspected = await session.inspect();
          if (["completed", "failed", "cancelled", "uncertain"].includes(inspected.status))
            return { status: inspected.status, history: JSON.stringify(await session.history()) };
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("session did not settle");
      };
      useWorkloadToken({ file });
      await writeFile(file, TOKEN_ONE);
      expect((await turn()).status).toBe("completed");
      await writeFile(file, TOKEN_TWO);
      expect((await turn()).status).toBe("completed");
      expect(bearers).toEqual([`Bearer ${TOKEN_ONE}`, `Bearer ${TOKEN_TWO}`]);
      useWorkloadToken({ file: join(dir, "missing") });
      const failed = await turn();
      expect(failed.status).toBe("failed");
      expect(failed.history).toMatch(/NYLORUN_WORKLOAD_TOKEN_FILE/);
      expect(bearers).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
      await runtime.close();
    }
  });
});
