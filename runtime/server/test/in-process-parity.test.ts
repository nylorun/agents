/**
 * The in-process harness uses the same seams and gates as a remote one (protocol 15): its model
 * calls go through the Model Gate (a scripted model's gate, metered), and its MCP servers open
 * through the Tool Gate by name. Core never calls a provider and never authorizes an MCP
 * connection outside a gate.
 */
import { afterEach, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import type { LiveConnection, McpClient } from "../src/mcp/connect.js";
import type { McpServerRef } from "../src/mcp/pool.js";
import type { ToolGate } from "../src/gates/tool-gate.js";
import type { ModelProvider } from "../src/core/provider.js";
import { boot, server, until, view, type Started } from "./host/execution-support.js";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const agent = Agent({ id: "bot", name: "Bot" })
  .mcp({ remote: { type: "streamable-http", url: "https://mcp.example.invalid/mcp" } })
  .build();

it("calls the model through its gate, metered, and opens MCP servers only through the Tool Gate", async () => {
  const opened: McpServerRef[] = [];
  const called: string[] = [];
  const client: McpClient = {
    listTools: async () => ({ tools: [{ name: "echo", inputSchema: { type: "object" } }] }),
    callTool: async (params) => {
      called.push(params.name);
      return { result: { content: [{ type: "text", text: "echoed" }] } };
    },
  };
  const toolGate: ToolGate = {
    async openMcp(server) {
      opened.push(server);
      return { client, close: async () => {} } satisfies LiveConnection;
    },
  };
  const effects: string[] = [];
  const model: ModelProvider = async (effect) => {
    effects.push(effect.effectId);
    const prompt = JSON.stringify((effect.input as { prompt: unknown }).prompt);
    const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
    return prompt.includes("echoed")
      ? { output: [{ type: "text", text: "done" }], usage }
      : { output: [{ type: "tool-call", id: "c1", name: "remote__echo", args: {} }], usage };
  };
  const runtime: Started = await boot({ harness: "memory", modelProvider: model, toolGate });
  cleanups.push(() => runtime.close());
  const put = await fetch(`${runtime.url}/v1/agents/bot`, {
    method: "PUT",
    headers: server,
    body: JSON.stringify({ requestId: "put-1", manifest: agent.manifest, implementationVersion: "dev" }),
  });
  expect(put.ok).toBe(true);
  const session = await fetch(`${runtime.url}/v1/sessions/s1`, {
    method: "PUT",
    headers: server,
    body: JSON.stringify({ requestId: "session-s1", agentId: "bot", ownerUserId: "u" }),
  });
  expect(session.ok).toBe(true);
  const message = await fetch(`${runtime.url}/v1/sessions/s1/commands`, {
    method: "POST",
    headers: server,
    body: JSON.stringify({ type: "message", requestId: "m1", idempotencyKey: "m1", content: "echo" }),
  });
  expect(message.ok).toBe(true);
  await until(() => view(runtime), (s) => s.status === "completed" || s.status === "failed", "the turn to end");
  expect((await view(runtime)).status).toBe("completed");

  // MCP: opened by name through the gate, never with a URL or a credential here.
  expect(opened).toEqual([{ sessionId: "s1", serverName: "remote" }]);
  expect(called).toEqual(["echo"]);
  // Model: every call went through the gate, which metered what it reported.
  expect(effects).toHaveLength(2);
  const usage = await fetch(`${runtime.url}/v1/tenant/usage`, { headers: runtime.managementHeaders() });
  expect(((await usage.json()) as { calls: number }).calls).toBe(2);
});
