import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";
import manifest from "../package.json";

describe("public API", () => {
  it("exports the documented construction helpers and no provider adapters", () => {
    expect(Object.keys(api)).toEqual(
      expect.arrayContaining([
        "run",
        "runDurable",
        "createRunState",
        "createDurableCheckpoint",
        "createExecutionState",
        "checkCompatibility",
        // A harness of your own words the same facts with our helpers (protocol 15).
        "engineToolsFor",
        "memoryIndexBlock",
        "memoryTool",
        "sandboxTools",
        "skillCatalogText",
        "mcpToolSet",
        "shapeToolOutcome",
        "StepBudget",
      ]),
    );
    expect(api).not.toHaveProperty("Agent");
    expect(api).not.toHaveProperty("tool");
    expect(api).not.toHaveProperty("bindAgent");
    expect(api).not.toHaveProperty("BuiltAgent");
    expect(api).not.toHaveProperty("defineToolFamily");
    expect(manifest.exports).toHaveProperty(".");
    expect(manifest.exports).not.toHaveProperty("./model/adapters");
    expect(manifest.exports).toHaveProperty("./run");
    expect(Object.keys(manifest.exports).sort()).toEqual([
      ".",
      "./api",
      "./compatibility",
      "./run",
    ]);
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(["@nylorun/core"]);
    expect(manifest.dependencies?.["@nylorun/core"]).toMatch(/^\d+\.\d+\.\d+(?:-beta(?:\.\d+)?)?$/);
  });

  it("exports the Harness API client from ./api", async () => {
    const harnessApi = await import("../src/api/index.js");
    expect(Object.keys(harnessApi).sort()).toEqual(
      [
        "ABORT_MESSAGES",
        "DEFAULT_SANDBOX_TOOL_LIMITS",
        "DEFAULT_SKILL_READ_BYTES",
        "LOAD_SKILL_TOOL",
        "READ_SKILL_RESOURCE_TOOL",
        "RunAbort",
        "SKILLS_USAGE",
        "TranscriptCache",
        "apiHost",
        "artifactInstructions",
        "artifactToolsFor",
        "createHarness",
        "engineToolsFor",
        "formatSkillCatalog",
        "isArtifactTool",
        "isSkillTool",
        "memoryIndexBlock",
        "memoryTool",
        "runAbortKind",
        "runArtifactTool",
        "runSkillTool",
        "runTurn",
        "sandboxInstructions",
        "sandboxToolLimitsOf",
        "sandboxTools",
        "skillCatalogText",
        "skillFolderNote",
        "skillOfToolCall",
        "skillTools",
        // Our engine's MCP naming and deferral, and its tool-result shaping (protocol 15).
        "DEFAULT_MCP_TOOL_CONFIG",
        "MODEL_TOOL_NAME_MAX",
        "mcpToolConfigOf",
        "mcpToolKey",
        "mcpToolName",
        "mcpToolNames",
        "mcpToolSet",
        "TOOL_CALL_TOOL",
        "TOOL_SEARCH_TOOL",
        "deferredToolsNote",
        "deferredToolsTools",
        "isToolSearch",
        "rank",
        "runToolSearch",
        "tokens",
        "DEFAULT_TOOL_RESULT_CONFIG",
        "StepBudget",
        "cutMessage",
        "jsonBytes",
        "mayNeedShaping",
        "previewOf",
        "resultBytes",
        "shapeToolOutcome",
        "spillKey",
        "toolResultConfigOf",
        "utf8Boundary",
        // Our engine's workspace conventions: skill folders and the outputs folder (protocol 15).
        "definitionFileChunks",
        "mountSkills",
        "sandboxSkillsOf",
        "DEFAULT_OUTPUTS_CONFIG",
        "outputsConfigOf",
        // Our flow engine's failure text (B15).
        "DEFAULT_FLOW_VALUE_CHARS",
        "saveOutputs",
        // Our engine's loop and harness settings, each with its default (B15).
        "DEFAULT_COMPACTION_CONFIG",
        "DEFAULT_LEASE_RETRY_MS",
        "DEFAULT_LOOP_CONFIG",
        "DEFAULT_PARTIAL_OUTPUT_CHARS",
        "DEFAULT_RESEND_DELAYS_MS",
        "DEFAULT_TRANSCRIPT_CACHE_MB",
        "compactionConfigOf",
        "loopConfigOf",
      ].sort(),
    );
  });
});
