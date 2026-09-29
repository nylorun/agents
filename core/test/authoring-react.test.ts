import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Agent,
  AgentBuildError,
  capability,
  hashManifest,
  mcp,
  sandbox,
  tool,
  Loop,
} from "../src/define.js";

/**
 * Flow Agents Phase 1: the new ReAct methods compile to exactly today's manifests.
 * The hashes below were recorded with the builder before the change; they must never move.
 */
const GOLDEN = {
  options: "426b82ff265379ee15a6cbbd63b5bc9571fc0c0d16e003c149e1af80d6b255c2",
  optionsOutput: "4af1235113c93b9ad21d0630b976ac50d66026bf6b767578d7bd47cc6742fddc",
  hookOnly: "fc5cebf3a618b93f39b24d2305099db9bab0da18c1c8b12e47310612095b7ab8",
  hooksAfterOptions: "e7d6a4dd389cba4104d0af5acfb61414216fc2b2ac0b0a44b6ebe82cbc7d1fa0",
  useThenHook: "64fb4967897fdccb4cce39885e8c28828772a48bba3e0b0417a312ce2f0bed7e",
  useSandbox: "92aff0fe5a0281e085b634320ce325e1bc7cd5a3c63c97aab0ec0dab5286f743",
  useCapability: "f97bb5a2d315073e085ee5228d166605869646f47bdff62bf99f1297e8a6e40d",
  useMcp: "33f7ba25af773420f44ccaebdae47fea2915dad96bd39204dc9885db1164d2ad",
  subagent: "fda680e798c6f208599537893929cf8f53e2f8590717eae81233855d35d3a341",
  empty: "a3e5d8d035e1c8cec9c40a66c2d3980b7784e7b6b7c1dc41430589174c14bc7d",
  loopWorkflow: "5ddba0cf4b2845fa3e0c17e4bc37eee5d0a4d46b9b904a396c79b220af6cc768",
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
    expect(hash(Agent({ id: "a" }).before("turn", () => ({})))).toBe(GOLDEN.hookOnly);
    expect(
      hash(Agent({ id: "a", instructions: "x", tools: [look] }).before("turn", () => ({})).after("step", () => ({})))
    ).toBe(GOLDEN.hooksAfterOptions);
    expect(hash(Agent({ id: "a" }).use(sandbox()).before("turn", () => ({})))).toBe(GOLDEN.useThenHook);
    expect(hash(Agent({ id: "a", instructions: "x" }).use(sandbox({ image: "node:24" })))).toBe(GOLDEN.useSandbox);
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
    const loop = Loop({ id: "polish", run: legacySub, verify: () => ({ pass: true }), decide: ({ output }) => ({ output }) });
    expect(hashManifest(loop.manifest)).toBe(GOLDEN.loopWorkflow);
  });
});

describe("the new ReAct methods", () => {
  it("compile to the same manifests as today's syntax", () => {
    expect(hash(Agent({ id: "a", name: "A" }).instructions("Do it.").tools(look))).toBe(GOLDEN.options);
    expect(hash(Agent({ id: "a" }).instructions("Do it.").output(z.object({ x: z.number() })))).toBe(
      GOLDEN.optionsOutput
    );
    expect(hash(Agent({ id: "a" }).beforeTurn(() => ({})))).toBe(GOLDEN.hookOnly);
    expect(
      hash(Agent({ id: "a" }).instructions("x").tools(look).beforeTurn(() => ({})).afterModel(() => ({})))
    ).toBe(GOLDEN.hooksAfterOptions);
    expect(hash(Agent({ id: "a" }).sandbox().beforeTurn(() => ({})))).toBe(GOLDEN.useThenHook);
    expect(hash(Agent({ id: "a" }).instructions("x").sandbox({ image: "node:24" }))).toBe(GOLDEN.useSandbox);
    expect(hash(Agent({ id: "a" }).capability(capability({ id: "cap" }).instructions("c").tools(look)))).toBe(
      GOLDEN.useCapability
    );
    expect(
      hash(Agent({ id: "a" }).instructions("x").mcp({ gh: { type: "streamable-http", url: "https://x.example/mcp" } }))
    ).toBe(GOLDEN.useMcp);
    expect(hash(Agent({ id: "a" }).instructions("x").tools(look).subagents(sub))).toBe(GOLDEN.subagent);
  });

  it("keeps hooks when instructions and tools are added after them", () => {
    const later = Agent({ id: "a" }).beforeTurn(() => ({})).instructions("x").tools(look);
    const capabilityOf = (agent: typeof later) => agent.build().manifest.capabilities.find((c) => c.id === "agent");
    expect(capabilityOf(later)).toMatchObject({
      instructions: ["x"],
      tools: [{ name: "look" }],
      hooks: [{ at: "before", scope: "turn" }],
    });
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
  it("agent.single-value for a second .output() or .sandbox()", () => {
    expect(diagnosticsOf(() => Agent({ id: "a" }).output(z.string()).output(z.string()).build())).toEqual([
      "agent.single-value",
    ]);
    expect(diagnosticsOf(() => Agent({ id: "a" }).sandbox().sandbox().build())).toEqual(["agent.single-value"]);
  });

  it("flow.no-model for a ReAct method on a flow agent", () => {
    expect(diagnosticsOf(() => Agent({ id: "f" }).step(sub).instructions("x" as never).build())).toEqual([
      "flow.no-model",
    ]);
  });

  it("agent.mixed-body for a flow method on a ReAct agent", () => {
    expect(diagnosticsOf(() => Agent({ id: "a" }).instructions("x").step(sub).build())).toEqual(["agent.mixed-body"]);
  });

  it("hook.duplicate across the old and new hook names", () => {
    expect(diagnosticsOf(() => Agent({ id: "a" }).beforeTurn(() => ({})).before("turn", () => ({})).build())).toEqual([
      "hook.duplicate",
    ]);
  });

  it("mcp.duplicate-server for the same server twice", () => {
    const server = { gh: { type: "sse" as const, url: "https://x.example/gh" } };
    expect(diagnosticsOf(() => Agent({ id: "a" }).mcp(server).mcp(server).build())).toEqual(["mcp.duplicate-server"]);
  });

  it("delegation.flow-unsupported for a workflow built with the v1 primitives", () => {
    const old = Loop({ id: "old", run: sub, verify: () => ({ pass: true }), decide: ({ output }) => ({ output }) });
    expect(diagnosticsOf(() => Agent({ id: "a" }).subagents(old as never).build())).toEqual([
      "delegation.flow-unsupported",
    ]);
  });
});
