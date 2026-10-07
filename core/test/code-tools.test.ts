/**
 * R2 M6: the Runtime runs no code of yours during a session. A definition whose tools would run
 * the developer's code (no `http`, no `agent`, not a built-in) is refused at save, and so is a
 * flow agent with a `tool` stage.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Agent,
  artifactsCapabilityManifest,
  codeToolRefusal,
  codeToolsOf,
  http,
  sandboxCapabilityManifest,
  tool,
} from "../src/define.js";
import type { AgentManifest } from "../src/types/manifest.js";

const lookup = tool({
  name: "lookup",
  input: z.object({ id: z.string() }),
  run: async () => "found",
});
const refund = http({
  name: "refund",
  input: z.object({ orderId: z.string() }),
  url: "https://billing.example.com/refunds",
});

describe("code tools", () => {
  it("names an agent's code tools and leaves HTTP tools and agents used as tools", () => {
    const helper = Agent({ id: "helper", description: "Helps." }).instructions("Help.").tools(lookup);
    const support = Agent({ id: "support" }).instructions("Help.").tools(refund).subagents(helper);
    expect(codeToolsOf(support.build().manifest)).toEqual([
      { name: "lookup", owner: "helper", kind: "tool" },
    ]);
    expect(codeToolRefusal(support.build().manifest)).toBe(
      "Tool 'lookup' of agent 'helper' runs your code, and the Runtime runs no code of yours during a session. Make it an http() tool or serve it from a remote MCP server (see MIGRATION.md).",
    );
    const billing = Agent({ id: "billing" }).instructions("Refund.").tools(refund);
    expect(codeToolRefusal(billing.build().manifest)).toBeUndefined();
  });

  it("leaves the Runtime's built-ins: sandbox tools, save_artifact, read_artifact and the skill tools", () => {
    const manifest: AgentManifest = {
      manifestSchemaVersion: 5,
      id: "worker",
      capabilities: [
        sandboxCapabilityManifest({ image: "node:24" }),
        artifactsCapabilityManifest({ read: true }),
        {
          id: "skills",
          type: "agent",
          skills: { review: { name: "review", description: "Review.", files: { "SKILL.md": "sha256:00" } } },
          tools: [{ name: "load_skill", inputSchema: { type: "object" } }],
        },
      ],
    };
    expect(codeToolsOf(manifest)).toEqual([]);
  });

  it("names every tool stage of a flow agent, and the code tools of the agents it embeds", () => {
    const writer = Agent({ id: "writer" }).instructions("Write.").tools(lookup);
    const publish = tool({ name: "publish", input: z.object({}), run: async () => "ok" });
    const pipeline = Agent({ id: "pipeline" }).pipe(writer, publish).build();
    expect(codeToolsOf(pipeline.manifest)).toEqual([
      { name: "publish", owner: "pipeline", kind: "stage" },
      { name: "lookup", owner: "writer", kind: "tool" },
    ]);
    expect(codeToolRefusal(pipeline.manifest)).toMatch(
      /^The tool stage 'publish' of flow agent 'pipeline' \(and 1 more\) runs your code/,
    );
  });

  it("leaves a flow agent's HTTP stages and HTTP verifiers", () => {
    const planner = Agent({ id: "planner" }).instructions("Plan.").output(z.object({ orderId: z.string() }));
    const fixer = Agent({ id: "fixer" }).instructions("Fix.");
    const checker = http({ url: "https://checks.example.com/verify" });
    const pipeline = Agent({ id: "pipeline" })
      .pipe(planner, refund)
      .loop(fixer, { verify: checker, max: 2 })
      .build();
    expect(codeToolsOf(pipeline.manifest)).toEqual([]);
  });
});
