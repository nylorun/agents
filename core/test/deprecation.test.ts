import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Agent, tool } from "../src/define.js";
import { resetDeprecationWarnings } from "../src/utils/deprecate.js";

/** Flow Agents Phase 1: the old authoring forms warn once each; the new ones never do. */

const look = tool({
  name: "look",
  input: z.object({ q: z.string() }),
  async run() {
    return "";
  },
});

let codes: string[] = [];

beforeEach(() => {
  resetDeprecationWarnings();
  codes = [];
  vi.spyOn(process, "emitWarning").mockImplementation(((
    _message: string,
    options?: { code?: string }
  ) => {
    if (options?.code) codes.push(options.code);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deprecation warnings", () => {
  it("warn once per code for the old forms", () => {
    Agent({ id: "a", instructions: "x", tools: [look] });
    Agent({ id: "b", instructions: "y" });
    expect(codes).toEqual(["NYLORUN_DEP_AGENT_OPTIONS"]);
  });

  it("never warn for the new syntax", () => {
    const helper = Agent({ id: "helper", description: "Helps." }).instructions("Help.");
    Agent({ id: "a" })
      .instructions("x")
      .tools(look)
      .subagents(helper)
      .mcp({ gh: { type: "sse", url: "https://x.example/gh" } })
      .output(z.string())
      .build();
    Agent({ id: "f" }).pipe(helper).build();
    expect(codes).toEqual([]);
  });
});
