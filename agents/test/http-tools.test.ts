/**
 * R2 M3: `http()` declares a tool the Runtime runs as an HTTP request. It projects into the
 * manifest with `http` (and `approval`), and the app serves no implementation for it.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentManifestSchema } from "@nylorun/core/contracts";
import { Agent, capability, hashManifest, http, tool } from "../src/index.js";
import { buildAgents } from "../src/served-definitions.js";
import { implementationsFor } from "@nylorun/core/define";

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

  it("is served beside code tools without an implementation of its own", () => {
    const agent = Agent({ id: "orders" })
      .tools(
        refund,
        tool({ name: "note", input: z.object({ text: z.string() }), run: async ({ text }) => text }),
      )
      .build();
    const served = buildAgents([agent], "createActionHandler");
    expect([...served.keys()]).toEqual(["orders"]);
    const implementations = Object.values(implementationsFor(agent)).flatMap((item) =>
      Object.keys(item.tools ?? {}),
    );
    expect(implementations).toContain("note");
  });
});
