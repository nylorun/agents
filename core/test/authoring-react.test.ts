import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Agent,
  AgentBuildError,
  hashManifest,
  tool,
} from "../src/define.js";
import { addPart } from "./support/parts.js";

/**
 * Flow Agents Phase 1: the new ReAct methods compile to exactly today's manifests.
 * The hashes below were recorded with the builder before the change; they move only with the
 * manifest schema version (re-recorded for manifest v7, the flat manifest, after checking each
 * printed manifest: top-level instructions, tools and mcpServers, no capabilities, no runtime).
 */
const GOLDEN = {
  options: "06dad435681aa7a4f62bdf3feec4c111d2981843eb73fd2e44f94f8c6d18af16",
  optionsOutput: "34fd67eba222160a774bd68cd56765dd5f9d402b9b34d72ebc69164e2c02992d",
  usePart: "d18f0f71e8286314712334ee6af56179c8477918ba379773de757fdaad478aa5",
  useMcp: "089eec9953183547e8ba51bb27032bc6d5db3867467e4cee4cda179b8f5fc211",
  subagent: "f2cdfb048c17aac65ac156ba6d26bf3955610d1b84a6d1d4aa4bf9a5f897e5b1",
  empty: "fd549eaa4c3765c40809cd8551c7ef40f20fa936d33cf8f58f42fc70d8d3e850",
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
    expect(Agent({ id: "a", name: "A", instructions: "Do it.", tools: [look] }).build().manifest).toEqual({
      manifestSchemaVersion: 7,
      id: "a",
      name: "A",
      instructions: ["Do it."],
      tools: [expect.objectContaining({ name: "look", description: "Look." })],
    });
    const legacySub = Agent({ id: "sub", description: "Helps.", instructions: "Help." });
    expect(hash(Agent({ id: "a", name: "A", instructions: "Do it.", tools: [look] }))).toBe(GOLDEN.options);
    expect(hash(Agent({ id: "a", instructions: "Do it.", outputSchema: z.object({ x: z.number() }) }))).toBe(
      GOLDEN.optionsOutput
    );
    expect(hash(addPart(Agent({ id: "a" }), { id: "cap", instructions: ["c"], tools: [look] }))).toBe(
      GOLDEN.usePart
    );
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
    expect(
      hash(Agent({ id: "a" }).instructions("x").mcp({ gh: { type: "streamable-http", url: "https://x.example/mcp" } }))
    ).toBe(GOLDEN.useMcp);
    expect(hash(Agent({ id: "a" }).instructions("x").tools(look).subagents(sub))).toBe(GOLDEN.subagent);
  });

  it("accumulates list methods across calls", () => {
    const agent = Agent({ id: "a" }).instructions("one").tools(look).instructions("two", "three");
    expect(agent.build().manifest).toMatchObject({ instructions: ["one", "two", "three"], tools: [{ name: "look" }] });
  });

  it("merges .mcp() calls and defaults a server's name to its key", () => {
    const agent = Agent({ id: "a" })
      .mcp({ gh: { type: "streamable-http", url: "https://x.example/gh" } })
      .mcp({ docs: { type: "sse", url: "https://x.example/docs" } });
    const servers = agent.build().manifest.mcpServers;
    expect(Object.keys(servers ?? {})).toEqual(["gh", "docs"]);
    expect(servers?.gh?.name).toBe("gh");
  });

  it("is immutable: two agents can branch from one base", () => {
    const base = Agent({ id: "a" }).instructions("shared");
    const one = base.instructions("one");
    const two = base.instructions("two");
    expect(one.build().manifest.instructions).toEqual(["shared", "one"]);
    expect(two.build().manifest.instructions).toEqual(["shared", "two"]);
    expect(base.build().manifest.instructions).toEqual(["shared"]);
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
