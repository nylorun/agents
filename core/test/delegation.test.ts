import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, AgentBuildError, tool } from "../src/define.js";
import { AgentManifestSchema } from "../src/contracts.js";
import { DELEGATE_INPUT_SCHEMA, delegateOf } from "../src/definition/delegate.js";
import { implementationsFor } from "../src/definition/binding.js";
import { hashManifest } from "../src/utils/hash.js";

const search = tool({
  name: "search_orders",
  description: "Search orders.",
  input: z.object({ query: z.string() }),
  run: async () => "none",
});

const researcher = (instructions = "Investigate one question.") =>
  Agent({
    id: "researcher",
    description: "Investigates an order's history. Returns a short summary.",
    instructions,
    tools: [search],
    outputSchema: z.object({ summary: z.string() }),
  });

const diagnostics = (build: () => unknown) => {
  try {
    build();
  } catch (error) {
    if (error instanceof AgentBuildError) return error.diagnostics.map((item) => item.code);
    throw error;
  }
  return [];
};

describe("agents used as tools", () => {
  it("adds a tool with an inlined agent body and nothing else", () => {
    const child = researcher();
    const parent = Agent({ id: "support", instructions: "Help.", tools: [child] }).build();
    const [declared] = parent.manifest.capabilities[0]!.tools!;
    expect(declared).toEqual({
      name: "researcher",
      description: child.manifest.description,
      inputSchema: DELEGATE_INPUT_SCHEMA,
      agent: child.manifest,
    });
    expect(AgentManifestSchema.safeParse(parent.manifest).success).toBe(true);
  });

  it("accepts a built agent in a capability's tools", () => {
    const parent = Agent({ id: "support" })
      .use({ id: "research", tools: [researcher().build()] })
      .build();
    expect(parent.manifest.capabilities[0]!.tools![0]!.agent?.id).toBe("researcher");
  });

  it("keeps the local child on the binding for the engine and the executor", () => {
    const child = researcher().build();
    const parent = Agent({ id: "support", tools: [child] }).build();
    const bound = implementationsFor(parent).agent!.tools!.researcher;
    expect(delegateOf(bound)?.agent).toBe(child);
  });

  it("round-trips through Agent.from with the same hash", () => {
    const parent = Agent({ id: "support", tools: [researcher()] }).build();
    const restored = Agent.from(JSON.parse(JSON.stringify(parent.manifest)), {});
    expect(hashManifest(restored.manifest)).toBe(hashManifest(parent.manifest));
    expect(delegateOf(implementationsFor(restored).agent!.tools!.researcher)?.manifest.id).toBe(
      "researcher"
    );
  });

  it("re-versions the parent when the child changes", () => {
    const a = Agent({ id: "support", tools: [researcher("One.")] }).build();
    const b = Agent({ id: "support", tools: [researcher("Two.")] }).build();
    expect(hashManifest(a.manifest)).not.toBe(hashManifest(b.manifest));
  });

  it("leaves agents without delegates unchanged", () => {
    const plain = Agent({ id: "plain", tools: [search] }).build();
    expect(plain.manifest.capabilities[0]!.tools![0]).not.toHaveProperty("agent");
  });

  it("requires a description", () => {
    const child = Agent({ id: "researcher", tools: [search] });
    expect(diagnostics(() => Agent({ id: "support", tools: [child] }).build())).toContain(
      "delegation.description-required"
    );
  });

  it("rejects nested delegation", () => {
    const verifier = Agent({ id: "verifier", description: "Checks." });
    const middle = Agent({ id: "researcher", description: "Researches.", tools: [verifier] });
    expect(diagnostics(() => Agent({ id: "support", tools: [middle] }).build())).toContain(
      "delegation.nested"
    );
  });

  it("rejects child tools that need approval", () => {
    const refund = tool({
      name: "refund_order",
      input: z.object({}),
      approval: () => "Refund?",
      run: async () => "ok",
    });
    const child = Agent({ id: "refunder", description: "Refunds.", tools: [refund] });
    expect(diagnostics(() => Agent({ id: "support", tools: [child] }).build())).toContain(
      "delegation.approval-unsupported"
    );
  });

  it("rejects ids that cannot be tool names and duplicate names", () => {
    const spaced = Agent({ id: "order researcher", description: "Researches." });
    expect(diagnostics(() => Agent({ id: "support", tools: [spaced] }).build())).toContain(
      "delegation.invalid-name"
    );
    const clash = tool({ name: "researcher", input: z.object({}), run: async () => "" });
    expect(
      diagnostics(() =>
        Agent({ id: "support", tools: [clash] })
          .use({ id: "more", tools: [researcher()] })
          .build()
      )
    ).toContain("tool.duplicate-name");
  });

  it("refuses a sandbox declared anywhere in the tree", () => {
    const boxed = Agent({ id: "coder", description: "Codes." }).use({
      id: "box",
      sandbox: { image: "a" },
    } as never);
    expect(diagnostics(() => Agent({ id: "lead", tools: [boxed] }).build())).toContain(
      "sandbox.in-definition"
    );
  });

  it("rejects malformed agent tools on the wire", () => {
    const parent = Agent({ id: "support", tools: [researcher()] }).build();
    const json = JSON.parse(JSON.stringify(parent.manifest));
    const declared = json.capabilities[0].tools[0];
    for (const change of [
      { name: "investigate" },
      { description: "Something else." },
      { inputSchema: { type: "object" } },
      { outputSchema: { type: "object" } },
    ]) {
      const broken = structuredClone(json);
      Object.assign(broken.capabilities[0].tools[0], change);
      expect(AgentManifestSchema.safeParse(broken).success).toBe(false);
    }
    const nested = structuredClone(json);
    nested.capabilities[0].tools[0].agent.capabilities[0].tools.push({ ...declared });
    expect(AgentManifestSchema.safeParse(nested).success).toBe(false);
  });
});
