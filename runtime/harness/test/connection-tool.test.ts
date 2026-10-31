/**
 * `request_connection` (A2A profile v2, `interactions/v1` kind `connection`): offered to the root
 * agent when the session's version sets `harness.loop.connections`; a first call waits on a
 * `response` interaction whose metadata says `kind: "connection"`, and the answer says whether
 * the app is connected.
 */
import { describe, expect, it } from "vitest";
import type { AgentManifest } from "@nylorun/core/define";
import type { HostEffect } from "../src/run/index.js";
import { engineToolsFor } from "../src/tools/engine-tools.js";
import {
  CONNECTION_LIMITS,
  REQUEST_CONNECTION_TOOL,
  connectedIn,
  isConnectionTool,
  runConnectionTool,
} from "../src/tools/connection.js";
import { UPDATE_PLAN_TOOL } from "../src/tools/plan.js";
import { DEFAULT_SANDBOX_TOOL_LIMITS } from "../src/tools/sandbox.js";

const options = { artifactPageBytes: 1024, sandboxTools: DEFAULT_SANDBOX_TOOL_LIMITS, skillReadBytes: 1024 };
const names = (agent: Pick<AgentManifest, "skills" | "tools">, plan = false, connections = false) =>
  engineToolsFor(agent, undefined, options, undefined, plan, connections).tools.map((tool) => tool.name);

const effect = (input: unknown, resume?: unknown) =>
  ({
    kind: "tool",
    effectId: "t1:0:tool:c0",
    toolName: REQUEST_CONNECTION_TOOL,
    target: { kind: "harness" },
    input,
    context: resume === undefined ? {} : { resume },
  }) as unknown as HostEffect;

describe("request_connection in our engine's tools", () => {
  it("is off by default, offered after update_plan when the version opts in", () => {
    expect(names({})).not.toContain(REQUEST_CONNECTION_TOOL);
    expect(names({}, true, true).slice(-2)).toEqual([UPDATE_PLAN_TOOL, REQUEST_CONNECTION_TOOL]);
    const { tools, instructions } = engineToolsFor({}, undefined, options, undefined, false, true);
    const tool = tools.at(-1)!;
    expect(tool).toMatchObject({ name: REQUEST_CONNECTION_TOOL, target: { kind: "harness" } });
    expect(tool.inputSchema).toMatchObject({ required: ["app", "reason"], additionalProperties: false });
    expect(instructions.at(-1)).toContain("request_connection");
    expect(isConnectionTool(effect({}))).toBe(true);
  });

  it("leaves an agent that has its own request_connection tool with its own", () => {
    const agent = {
      tools: [{ name: REQUEST_CONNECTION_TOOL, description: "Mine", inputSchema: { type: "object" } }],
    } as unknown as Pick<AgentManifest, "tools">;
    expect(names(agent, false, true)).not.toContain(REQUEST_CONNECTION_TOOL);
  });
});

describe("a call of request_connection", () => {
  it("waits on a response interaction that says it is a connection", () => {
    expect(runConnectionTool(effect({ app: " GitHub ", reason: "To open the pull request." }))).toEqual({
      kind: "interaction-required",
      interaction: {
        kind: "response",
        prompt: "Connect GitHub: To open the pull request.",
        metadata: { kind: "connection", app: "GitHub", reason: "To open the pull request." },
      },
    });
  });

  it("cuts a long app and reason instead of refusing them", () => {
    const outcome = runConnectionTool(effect({ app: "a".repeat(200), reason: "r".repeat(1_000) })) as any;
    expect(outcome.interaction.metadata.app).toHaveLength(CONNECTION_LIMITS.appChars);
    expect(outcome.interaction.metadata.app.endsWith("…")).toBe(true);
    expect(outcome.interaction.metadata.reason).toHaveLength(CONNECTION_LIMITS.reasonChars);
  });

  it("answers what the response says", () => {
    const input = { app: "Linear", reason: "To file the bug." };
    for (const value of [true, { connected: true }])
      expect(runConnectionTool(effect(input, { kind: "response", interactionId: "i", value }))).toEqual({
        kind: "completed",
        output: "Connected: Linear",
      });
    for (const value of [false, null, "yes", { connected: "true" }, {}, undefined])
      expect(runConnectionTool(effect(input, { kind: "response", interactionId: "i", value }))).toEqual({
        kind: "completed",
        output: "Not connected: Linear",
      });
    expect(connectedIn({ connected: true, account: "acme" })).toBe(true);
  });

  it("fails a call with no app or no reason to the model", () => {
    for (const input of [{}, { app: "GitHub" }, { app: " ", reason: "x" }, { app: 3, reason: "x" }])
      expect(runConnectionTool(effect(input))).toMatchObject({ kind: "failed", code: "connection.invalid_input" });
  });
});
