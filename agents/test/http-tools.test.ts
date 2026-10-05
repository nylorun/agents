/**
 * R2 M3: `http()` declares a tool the Runtime runs as an HTTP request. It projects into the
 * manifest with `http` (and `approval`), and has no implementation. R2 M6: `saveAgent` refuses
 * a tool that would run your code.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentManifestSchema } from "@nylorun/core/contracts";
import { Agent, capability, hashManifest, http, tool } from "../src/index.js";
import { AgentsClient } from "../src/client.js";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";

const refund = http({
  name: "refund",
  description: "Refund an order.",
  input: z.object({ orderId: z.string(), amount: z.number() }),
  output: z.object({ refundId: z.string() }),
  url: "https://billing.example.com/refunds",
  method: "PUT",
  credential: "billing",
  timeoutMs: 20_000,
  approval: "always",
});

describe("http()", () => {
  it("projects into the agent's manifest with its target and approval, and no implementation", () => {
    const agent = Agent({ id: "orders", name: "Orders" }).tools(refund).build();
    const tools = agent.manifest.capabilities.flatMap((item) => item.tools ?? []);
    expect(tools).toEqual([
      {
        name: "refund",
        description: "Refund an order.",
        inputSchema: expect.objectContaining({ type: "object", required: ["orderId", "amount"] }),
        outputSchema: expect.objectContaining({ type: "object", required: ["refundId"] }),
        http: {
          url: "https://billing.example.com/refunds",
          method: "PUT",
          credential: "billing",
          timeoutMs: 20_000,
        },
        approval: "always",
      },
    ]);
    expect(AgentManifestSchema.safeParse(agent.manifest).success).toBe(true);
    // Rebuilt from the manifest alone, as the Runtime and the served definitions do.
    const restored = Agent.from(agent.manifest, {});
    expect(hashManifest(restored.manifest)).toBe(hashManifest(agent.manifest));
  });

  it("takes a JSON Schema input and leaves defaults out of the manifest", () => {
    const lookup = http({
      name: "lookup",
      input: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      url: "https://search.example.com/lookup",
    });
    const agent = Agent({ id: "search" }).capability(capability({ id: "search-tools" }).tools(lookup)).build();
    const [declared] = agent.manifest.capabilities.find((item) => item.id === "search-tools")!.tools!;
    expect(declared).toEqual({
      name: "lookup",
      inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      http: { url: "https://search.example.com/lookup" },
    });
  });

  it("is saved, and a code tool beside it is refused before anything is sent", async () => {
    const sent: string[] = [];
    const client = new AgentsClient({
      url: "http://127.0.0.1:8787",
      key: "a".repeat(64),
      fetch: async (url, init) => {
        if (String(url).endsWith("/health"))
          return Response.json({ status: "ok", service: "nylorun-runtime", protocol: { ...HOST_PROTOCOL } });
        sent.push(`${init?.method} ${new URL(String(url)).pathname}`);
        return Response.json({ ok: true });
      },
    });
    await client.saveAgent(Agent({ id: "orders" }).tools(refund).build());
    expect(sent).toEqual(["PUT /v1/agents/orders"]);
    const note = tool({ name: "note", input: z.object({ text: z.string() }), run: async ({ text }) => text });
    await expect(client.saveAgent(Agent({ id: "notes" }).tools(refund, note).build())).rejects.toThrow(
      "Tool 'note' of agent 'notes' runs your code, and the Runtime runs no code of yours during a session. Make it an http() tool or serve it from a remote MCP server (see MIGRATION.md).",
    );
    expect(sent).toEqual(["PUT /v1/agents/orders"]);
  });
});
