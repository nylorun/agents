import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Agent,
  AgentBuildError,
  capability,
  hashManifest,
  mcp,
  tool,
} from "../src/define.js";

/**
 * Flow Agents Phase 1: the new ReAct methods compile to exactly today's manifests.
 * The hashes below were recorded with the builder before the change; they move only with the
 * manifest schema version (re-recorded for manifest v5).
 */
const GOLDEN = {
  options: "6bb90193a9087d42ea95312db5e7bcce0ad1e8fcf9b97f6ab6ac2b08d32577b1",
  optionsOutput: "e596e55116ac66ec6c304511e01116c790046e3e7bc8a0e76953484f8d15abcc",
  useCapability: "1c781e56b324b9b6c0cc2fa1ea353b6a98d43c972e0d9f8e77b2285ceb5b89dd",
  useMcp: "a2438f66e72113e3f9c41af29b4f8d3af4b84ae46c9a5ac94167ffb08290895a",
  subagent: "f31101aa36ce0497ae532ff459cb65c5620900daa2711cca73735d7808986e29",
  empty: "549e1757a7fcd85e5172fb9420b06dcf26d1e44bff03a07e39268872cb16aea8",
} as const;

const look = tool({
  name: "look",
  description: "Look.",
  input: z.object({ q: z.string() }),
  async run() {
    return "";
  },
});
const sub = Agent({ id: "sub", description: "Helps." }).instructions("Help.");
const hash = (agent: { build(): { manifest: unknown } }) =>
  hashManifest(agent.build().manifest as never);
const diagnosticsOf = (build: () => unknown): string[] => {
  try {
    build();
  } catch (error) {
    if (error instanceof AgentBuildError) return error.diagnostics.map((d) => d.code);
    throw error;
  }
  return [];
};

describe("today's syntax is unchanged", () => {
  it("produces the recorded manifests", () => {
    const legacySub = Agent({ id: "sub", description: "Helps.", instructions: "Help." });
    expect(hash(Agent({ id: "a", name: "A", instructions: "Do it.", tools: [look] }))).toBe(GOLDEN.options);
    expect(hash(Agent({ id: "a", instructions: "Do it.", outputSchema: z.object({ x: z.number() }) }))).toBe(
      GOLDEN.optionsOutput
    );
    expect(hash(Agent({ id: "a" }).use(capability({ id: "cap", instructions: "c", tools: [look] })))).toBe(
      GOLDEN.useCapability
    );
    expect(
      hash(
        Agent({ id: "a", instructions: "x" }).use(
          mcp({ gh: { name: "gh", type: "streamable-http", url: "https://x.example/mcp" } })
        )
      )
    ).toBe(GOLDEN.useMcp);
    expect(hash(Agent({ id: "a", instructions: "x", tools: [look, legacySub] }))).toBe(GOLDEN.subagent);
    expect(hash(Agent({ id: "a" }))).toBe(GOLDEN.empty);
  });
});

describe("the new ReAct methods", () => {
  it("compile to the same manifests as today's syntax", () => {
    expect(hash(Agent({ id: "a", name: "A" }).instructions("Do it.").tools(look))).toBe(GOLDEN.options);
    expect(hash(Agent({ id: "a" }).instructions("Do it.").output(z.object({ x: z.number() })))).toBe(
      GOLDEN.optionsOutput
    );
    expect(hash(Agent({ id: "a" }).capability(capability({ id: "cap" }).instructions("c").tools(look)))).toBe(
      GOLDEN.useCapability
    );
    expect(
      hash(Agent({ id: "a" }).instructions("x").mcp({ gh: { type: "streamable-http", url: "https://x.example/mcp" } }))
    ).toBe(GOLDEN.useMcp);
    expect(hash(Agent({ id: "a" }).instructions("x").tools(look).subagents(sub))).toBe(GOLDEN.subagent);
  });

  it("accumulates list methods across calls", () => {
    const agent = Agent({ id: "a" }).instructions("one").tools(look).instructions("two", "three");
    expect(agent.build().manifest.capabilities[0]).toMatchObject({ id: "agent", instructions: ["one", "two", "three"] });
  });

  it("merges .mcp() calls and defaults a server's name to its key", () => {
    const agent = Agent({ id: "a" })
      .mcp({ gh: { type: "streamable-http", url: "https://x.example/gh" } })
      .mcp({ docs: { type: "sse", url: "https://x.example/docs" } });
    const servers = agent.build().manifest.capabilities.find((c) => c.id === "mcp")?.mcpServers;
    expect(Object.keys(servers ?? {})).toEqual(["gh", "docs"]);
    expect(servers?.gh?.name).toBe("gh");
  });

  it("is immutable: two agents can branch from one base", () => {
    const base = Agent({ id: "a" }).instructions("shared");
    const one = base.instructions("one");
    const two = base.instructions("two");
    expect(one.build().manifest.capabilities[0]?.instructions).toEqual(["shared", "one"]);
    expect(two.build().manifest.capabilities[0]?.instructions).toEqual(["shared", "two"]);
    expect(base.build().manifest.capabilities[0]?.instructions).toEqual(["shared"]);
  });
});

describe("build diagnostics", () => {
  it("agent.single-value for a second .output()", () => {
    expect(diagnosticsOf(() => Agent({ id: "a" }).output(z.string()).output(z.string()).build())).toEqual([
      "agent.single-value",
    ]);
  });

  it("flow.no-model for a ReAct method on a flow agent", () => {
    expect(diagnosticsOf(() => Agent({ id: "f" }).pipe(sub).instructions("x" as never).build())).toEqual([
      "flow.no-model",
    ]);
  });

  it("agent.mixed-body for a flow method on a ReAct agent", () => {
    expect(diagnosticsOf(() => Agent({ id: "a" }).instructions("x").pipe(sub).build())).toEqual(["agent.mixed-body"]);
  });

  it("mcp.duplicate-server for the same server twice", () => {
    const server = { gh: { type: "sse" as const, url: "https://x.example/gh" } };
    expect(diagnosticsOf(() => Agent({ id: "a" }).mcp(server).mcp(server).build())).toEqual(["mcp.duplicate-server"]);
  });
});
