/**
 * Our engine's sandbox tools (protocol 15): the six operations, each a `sandbox` effect, with the
 * harness's limits in their schemas and the session's workspace in their text.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SANDBOX_TOOL_LIMITS,
  sandboxInstructions,
  sandboxToolLimitsOf,
  sandboxTools,
} from "../src/tools/sandbox.js";

describe("the sandbox tools", () => {
  it("are the six operations, each run by the sandbox", () => {
    const tools = sandboxTools(DEFAULT_SANDBOX_TOOL_LIMITS, "/workspace");
    expect(tools.map((tool) => tool.name)).toEqual([
      "bash",
      "read",
      "write",
      "edit",
      "grep",
      "glob",
    ]);
    for (const tool of tools) expect(tool.target).toEqual({ kind: "sandbox" });
  });

  it("take their maxima and defaults from the harness's configuration", () => {
    const limits = sandboxToolLimitsOf({
      maxTimeoutS: 60,
      defaultTimeoutS: 30,
      maxReadLines: 100,
      readLines: 50,
    });
    expect(limits.maxGrepResults).toBe(DEFAULT_SANDBOX_TOOL_LIMITS.maxGrepResults);
    const [bash, read, , , grep] = sandboxTools(limits, "/workspace");
    expect(bash!.inputSchema.properties).toMatchObject({
      timeout: {
        maximum: 60,
        description: "Seconds before the command is killed. Default 30, maximum 60.",
      },
    });
    expect(read!.inputSchema.properties).toMatchObject({
      limit: { maximum: 100, description: "Maximum number of lines. Default 50." },
    });
    expect(grep!.inputSchema.properties).toMatchObject({
      max_results: { maximum: DEFAULT_SANDBOX_TOOL_LIMITS.maxGrepResults },
    });
  });

  it("name the session's workspace", () => {
    const [bash] = sandboxTools(DEFAULT_SANDBOX_TOOL_LIMITS, "/home/agent");
    expect(bash!.description).toContain("The working directory is /home/agent.");
    expect(sandboxInstructions("/home/agent")).toContain(
      "a persistent working directory at /home/agent.",
    );
  });
});
