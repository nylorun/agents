/**
 * The triggers capability (D83): `engine.triggers: true` in an agent-folder/2 folder's AGENT.md
 * compiles to `harness.engine.triggers`; the root agent gets the `triggers` tool (a `runtime`
 * effect, operation `triggers`) and the text block `triggers@1`; a subagent never does.
 */
import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  agentFolderJsonSchemas,
  compileAgentFolder,
  folderOfManifest,
  folderTextPaths,
  type AgentFolderDiagnostic,
  type AgentFolderEntry,
} from "../src/folder/index.js";
import {
  ENGINE_BLOCK_NAMES,
  ENGINE_BLOCK_VERSIONS,
  RUNTIME_TRIGGERS,
  TRIGGERS_TEXT,
  TRIGGERS_TOOL,
  blockHash,
  engineProjection,
  DEFAULT_ENGINE_TOOL_LIMITS,
  explainEngine,
  previewTurn,
  triggersToolOf,
} from "../src/engine/index.js";
import {
  HarnessEngineSchema,
  TriggerToolInputSchema,
  TriggerToolOutputSchema,
  ToolRuleSchema,
  EnvironmentLimitsSchema,
} from "../src/contracts.js";
import { EffectTargetSchema, TurnAgentSchema } from "../src/harness-api/schema.js";
import type { AgentManifest } from "../src/types/manifest.js";

const encoder = new TextEncoder();

function compile(files: Record<string, string>) {
  const entries: AgentFolderEntry[] = [];
  const bytes = new Map<string, Uint8Array>();
  for (const [path, content] of Object.entries(files)) {
    const data = encoder.encode(content);
    entries.push({ path, size: data.byteLength, sha256: bytesToHex(sha256(data)) });
    bytes.set(path, data);
  }
  return compileAgentFolder({ entries, files: new Map(folderTextPaths(entries).map((path) => [path, bytes.get(path)!])) });
}

const codes = (diagnostics: readonly AgentFolderDiagnostic[], severity: AgentFolderDiagnostic["severity"] = "error") =>
  diagnostics.filter((item) => item.severity === severity).map((item) => item.code);

const agent = (front: string, body = "Help.") => `---\nname: helper\ndescription: Helps.\n${front}---\n${body}\n`;
const sub = (front: string) => `---\nname: scout\ndescription: Looks around.\n${front}---\nLook.\n`;
const engineOf = (manifest: unknown) => (manifest as { harness: { engine?: Record<string, unknown> } }).harness.engine;

describe("engine.triggers in an agent folder (D83)", () => {
  it("compiles to harness.engine.triggers with the triggers@1 block, after wake", () => {
    const compiled = compile({ "AGENT.md": agent("format: agent-folder/2\nengine:\n  triggers: true\n") });
    expect(codes(compiled.diagnostics)).toEqual([]);
    expect(engineOf(compiled.manifest)).toEqual({
      triggers: true,
      blocks: [{ name: "triggers", version: 1, sha256: blockHash("triggers") }],
    });
    expect(ENGINE_BLOCK_VERSIONS.triggers).toBe(1);
    expect(ENGINE_BLOCK_NAMES.indexOf("triggers")).toBe(ENGINE_BLOCK_NAMES.indexOf("wake") + 1);
    expect(HarnessEngineSchema.parse(engineOf(compiled.manifest))).toMatchObject({ triggers: true });
  });

  it("is off without the key: no tool, no text", () => {
    const compiled = compile({ "AGENT.md": agent("format: agent-folder/2\nengine:\n  triggers: false\n") });
    expect(codes(compiled.diagnostics)).toEqual([]);
    const preview = previewTurn(compiled.manifest!);
    expect(preview.tools.map((tool) => tool.name)).not.toContain(TRIGGERS_TOOL);
    expect(preview.system).not.toContain(TRIGGERS_TEXT);
    expect(preview.blocks.map((block) => block.name)).not.toContain("triggers");
  });

  it("refuses a value that is not true or false, and the key under agent-folder/1", () => {
    expect(codes(compile({ "AGENT.md": agent("format: agent-folder/2\nengine:\n  triggers: yes please\n") }).diagnostics)).toEqual([
      "value_invalid",
    ]);
    expect(codes(compile({ "AGENT.md": agent("engine:\n  triggers: true\n") }).diagnostics)).toEqual(["engine_format"]);
  });

  it("is the root agent's: a subagent is refused, whether or not its parent declares it", () => {
    const without = compile({
      "AGENT.md": agent("format: agent-folder/2\nengine: {}\n"),
      "agents/scout/AGENT.md": sub("engine:\n  triggers: true\n"),
    });
    expect(codes(without.diagnostics)).toEqual(["engine_subset"]);
    const withIt = compile({
      "AGENT.md": agent("format: agent-folder/2\nengine:\n  triggers: true\n"),
      "agents/scout/AGENT.md": sub("engine:\n  triggers: true\n"),
    });
    expect(codes(withIt.diagnostics)).toEqual(["nested_refused"]);
    expect(withIt.diagnostics.find((item) => item.code === "nested_refused")!.message).toContain("triggers are the root agent's");
  });

  it("gives the tool and text to the root agent only", () => {
    const compiled = compile({
      "AGENT.md": agent("format: agent-folder/2\nengine:\n  triggers: true\n"),
      "agents/scout/AGENT.md": sub("engine: {}\n"),
    });
    expect(codes(compiled.diagnostics)).toEqual([]);
    const preview = previewTurn(compiled.manifest!);
    expect(preview.tools.map((tool) => tool.name)).toContain(TRIGGERS_TOOL);
    expect(preview.system).toContain(TRIGGERS_TEXT);
    expect(preview.blocks).toEqual([{ name: "triggers", version: 1 }]);
    expect(preview.agents.scout!.tools.map((tool) => tool.name)).not.toContain(TRIGGERS_TOOL);
    expect(preview.agents.scout!.system).not.toContain(TRIGGERS_TEXT);
    // A preview can turn it off, as a session on a version without it.
    expect(previewTurn(compiled.manifest!, { triggers: false }).tools.map((tool) => tool.name)).not.toContain(TRIGGERS_TOOL);
  });

  it("replaces the block's wording from engine.instructions.triggers", () => {
    const compiled = compile({
      "AGENT.md": agent("format: agent-folder/2\nengine:\n  triggers: true\n  instructions:\n    triggers: engine/triggers.md\n"),
      "engine/triggers.md": "Set up a routine only when the person asks for one.\n",
    });
    expect(codes(compiled.diagnostics)).toEqual([]);
    const engine = engineOf(compiled.manifest)!;
    expect(engine.blocks).toEqual([
      {
        name: "triggers",
        version: 1,
        sha256: blockHash("triggers", "Set up a routine only when the person asks for one."),
        source: "engine/triggers.md",
      },
    ]);
    const { system } = previewTurn(compiled.manifest!);
    expect(system).toContain("Set up a routine only when the person asks for one.");
    expect(system).not.toContain(TRIGGERS_TEXT);
  });

  it("warns of a triggers wording without the capability", () => {
    const compiled = compile({
      "AGENT.md": agent("format: agent-folder/2\nengine:\n  instructions:\n    triggers: engine/triggers.md\n"),
      "engine/triggers.md": "x",
    });
    expect(codes(compiled.diagnostics, "warning")).toEqual(["engine_text_unused"]);
  });

  it("writes engine.triggers back, and compiles to the same manifest", () => {
    const compiled = compile({
      "AGENT.md": agent("format: agent-folder/2\nengine:\n  triggers: true\n  instructions:\n    triggers: engine/triggers.md\n"),
      "engine/triggers.md": "Only when asked.\n",
    });
    const folder = folderOfManifest(compiled.manifest!);
    expect(folder.notes).toEqual([]);
    expect(folder.exact).toBe(true);
    expect(String(folder.files.get("AGENT.md"))).toMatch(/triggers: true/);
    expect(String(folder.files.get("engine/triggers.md"))).toBe("Only when asked.\n");
  });

  it("names it in the folder's AGENT.md schema, revision 3", () => {
    const schema = agentFolderJsonSchemas()["agent-md"] as {
      $id: string;
      properties: { engine: { properties: Record<string, unknown> } };
    };
    expect(schema.$id).toBe("https://docs.nylorun.com/schemas/agent-folder/v1/agent-md.3.json");
    expect(schema.properties.engine.properties.triggers).toMatchObject({ type: "boolean" });
  });

  it("explains the feature, its tool and its block", () => {
    const compiled = compile({ "AGENT.md": agent("format: agent-folder/2\nengine:\n  triggers: true\n") });
    const [root] = explainEngine(compiled.manifest!);
    expect(root!.features.find((feature) => feature.feature === "triggers")).toEqual({
      feature: "triggers",
      on: true,
      declaredBy: "engine.triggers",
      tools: [TRIGGERS_TOOL],
      blocks: ["triggers@1"],
    });
  });
});

describe("the triggers tool (D83)", () => {
  const manifest: Pick<AgentManifest, "engine" | "tools" | "skills"> = { engine: { triggers: true } };

  it("comes with the projection's triggers flag, after schedule_wake, as a runtime effect", () => {
    const projection = engineProjection(manifest, { selfWake: true }, DEFAULT_ENGINE_TOOL_LIMITS, undefined, false, false, true);
    expect(projection.tools.map((tool) => tool.name)).toEqual(["schedule_wake", TRIGGERS_TOOL]);
    expect(projection.blocks.map((block) => block.name)).toEqual(["wake", "triggers"]);
    expect(projection.tools[1]!.target).toEqual(RUNTIME_TRIGGERS);
    expect(engineProjection(manifest, undefined, DEFAULT_ENGINE_TOOL_LIMITS).tools).toEqual([]);
    expect(EffectTargetSchema.parse({ kind: "runtime", operation: "triggers" })).toEqual(RUNTIME_TRIGGERS);
    expect(TurnAgentSchema.parse({ id: "a", kind: "none", triggers: true })).toMatchObject({ triggers: true });
  });

  it("keeps an agent's own tool named triggers", () => {
    const own = { ...manifest, tools: [{ name: TRIGGERS_TOOL, inputSchema: { type: "object" } }] } as never;
    const projection = engineProjection(own, undefined, DEFAULT_ENGINE_TOOL_LIMITS, undefined, false, false, true);
    expect(projection.tools).toEqual([]);
    expect(projection.blocks).toEqual([]);
  });

  it("takes list, create and delete, with exactly one of schedule, at and in", () => {
    const tool = triggersToolOf();
    expect((tool.inputSchema.properties as { command: { enum: string[] } }).command.enum).toEqual(["list", "create", "delete"]);
    expect(TriggerToolInputSchema.parse({ command: "list" })).toEqual({ command: "list" });
    expect(TriggerToolInputSchema.parse({ command: "delete", id: "daily" })).toEqual({ command: "delete", id: "daily" });
    const create = { command: "create", id: "standup", title: "Standup", session: "own", prompt: "Ask about blockers." };
    expect(TriggerToolInputSchema.safeParse({ ...create, schedule: "0 9 * * 1-5", timezone: "Europe/Berlin" }).success).toBe(true);
    expect(TriggerToolInputSchema.safeParse({ ...create, in: "30m" }).success).toBe(true);
    expect(TriggerToolInputSchema.safeParse({ ...create, at: "2026-11-01T09:00:00+05:30" }).success).toBe(true);
    expect(TriggerToolInputSchema.safeParse(create).success).toBe(false);
    expect(TriggerToolInputSchema.safeParse({ ...create, in: "30m", at: "2026-11-01T09:00:00Z" }).success).toBe(false);
    expect(TriggerToolInputSchema.safeParse({ ...create, in: "30s" }).success).toBe(false);
    expect(TriggerToolInputSchema.safeParse({ ...create, in: "1h", timezone: "UTC" }).success).toBe(false);
    expect(TriggerToolInputSchema.safeParse({ ...create, in: "1h", session: "new" }).success).toBe(false);
    expect(TriggerToolInputSchema.safeParse({ ...create, in: "1h", title: "x".repeat(81) }).success).toBe(false);
    expect(TriggerToolInputSchema.safeParse({ ...create, id: "no spaces", in: "1h" }).success).toBe(false);
    expect(TriggerToolOutputSchema.safeParse({ id: "standup", status: "active", nextRunAt: null, session: "s_t_standup" }).success).toBe(true);
    expect(TriggerToolOutputSchema.safeParse({ id: "standup", deleted: true }).success).toBe(true);
  });
});

describe("contracts for the triggers capability (D83)", () => {
  it("takes tool rules of kind runtime, without a server", () => {
    const rule = { effect: "ask", kind: "runtime", tool: "triggers", when: { command: { equals: "create" }, session: { equals: "own" } } };
    expect(ToolRuleSchema.safeParse(rule).success).toBe(true);
    expect(ToolRuleSchema.safeParse({ ...rule, server: "x" }).success).toBe(false);
  });

  it("takes runtime.limits.triggers", () => {
    expect(EnvironmentLimitsSchema.parse({ triggers: { count: 25, minIntervalMs: 900_000, runsPerHour: 10 } })).toEqual({
      triggers: { count: 25, minIntervalMs: 900_000, runsPerHour: 10 },
    });
    expect(EnvironmentLimitsSchema.safeParse({ triggers: { every: 1 } }).success).toBe(false);
  });
});
