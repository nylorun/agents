import { describe, expect, it } from "vitest";
import {
  AgentManifestFileSchema,
  AgentManifestV8Schema,
  HarnessManifestFileSchema,
  RuntimeManifestFileSchema,
  RuntimeSectionSchema,
  agentModelChoice,
  parseAgentManifestRef,
  type AgentManifestV8,
} from "../src/contracts.js";
import {
  Agent,
  harnessSectionOf,
  loopManifestOf,
  normalizeCredentialUrl,
  pluginsOf,
  sandboxNeedOf,
  sectionGaps,
} from "../src/define.js";
import {
  agentManifestJsonSchema,
  harnessManifestJsonSchema,
  runtimeManifestJsonSchema,
} from "../src/manifest-schemas.js";

const SKILL = { name: "labeler", description: "Labels issues", files: { "SKILL.md": `sha256:${"a".repeat(64)}` } };

/** The design's triage agent: a GitHub MCP server on a pod with its token declared. */
function triage(overrides: Partial<AgentManifestV8> = {}): AgentManifestV8 {
  return {
    manifestSchemaVersion: 8,
    name: "triage",
    description: "Sorts new GitHub issues",
    harness: {
      instructions: ["Label and route new issues."],
      skills: { labeler: SKILL },
      mcpServers: {
        github: {
          name: "github",
          type: "streamable-http",
          url: "https://api.githubcopilot.com/mcp/",
          credential: "GITHUB_TOKEN",
        },
      },
    },
    runtime: {
      kind: "pod",
      image: "ghcr.io/acme/agent-base@sha256:9f1c",
      network: { allowedHosts: ["api.github.com"] },
      secrets: { GITHUB_TOKEN: { type: "bearer", url: "https://api.githubcopilot.com/mcp/", required: true } },
    },
    ...overrides,
  };
}

describe("agent manifest v8 (protocol 16)", () => {
  it("parses a manifest with both sections", () => {
    const manifest = triage();
    expect(AgentManifestV8Schema.parse(manifest)).toEqual(manifest);
    // No runtime section: an Agent made from it is kind none.
    const { runtime: _, ...bare } = manifest;
    expect(AgentManifestV8Schema.safeParse({ ...bare, harness: { instructions: ["Hi"] } }).success).toBe(true);
  });

  it("refuses v7 with the way to rebuild, and fields in the wrong section with where they went", () => {
    const v7 = AgentManifestV8Schema.safeParse({ ...triage(), manifestSchemaVersion: 7 });
    expect(v7.success).toBe(false);
    expect(JSON.stringify(v7.error?.issues)).toContain("nylorun migrate v8");
    const requires = AgentManifestV8Schema.safeParse(triage({ harness: { requires: { sandbox: "any" } } as never }));
    expect(JSON.stringify(requires.error?.issues)).toContain("harness.requires left the API");
    const harness = RuntimeSectionSchema.safeParse({ kind: "pod", harness: "acme" });
    expect(JSON.stringify(harness.error?.issues)).toContain("runtime.harness moved to harness.id");
    // Triggers (track T4): a map by id, each with exactly one of schedule, at or webhook.
    const triggers = RuntimeSectionSchema.safeParse({ kind: "pod", triggers: { daily: { schedule: "0 9 * * *", session: "s", prompt: "Wake." } } });
    expect(triggers.success).toBe(true);
    const both = RuntimeSectionSchema.safeParse({
      kind: "pod",
      triggers: { daily: { schedule: "0 9 * * *", at: "2030-01-01T00:00:00Z", session: "s", prompt: "Wake." } },
    });
    expect(JSON.stringify(both.error?.issues)).toContain("exactly one of schedule, at or webhook");
    const list = RuntimeSectionSchema.safeParse({ kind: "pod", triggers: [{ schedule: "0 9 * * *" }] });
    expect(list.success).toBe(false);
    expect(RuntimeSectionSchema.safeParse({ image: "x" }).success).toBe(false);
    expect(AgentManifestV8Schema.safeParse({ ...triage(), name: "a/b" }).success).toBe(false);
  });

  it("checks the harness section as v7 checked an agent", () => {
    const tools = [
      { name: "a__b", inputSchema: { type: "object" } },
      { name: "dup", inputSchema: { type: "object" } },
      { name: "dup", inputSchema: { type: "object" } },
    ];
    const issues = JSON.stringify(AgentManifestV8Schema.safeParse(triage({ harness: { tools } })).error?.issues);
    expect(issues).toContain("must not contain '__'");
    expect(issues).toContain("Tool names must be unique");
    const keyed = AgentManifestV8Schema.safeParse(triage({ harness: { skills: { other: SKILL } } }));
    expect(JSON.stringify(keyed.error?.issues)).toContain("must equal the skill name");
    expect(AgentManifestV8Schema.safeParse(triage({ harness: { functions: {} } as never })).success).toBe(false);
  });

  it("reads name and name@n refs", () => {
    expect(parseAgentManifestRef("triage")).toEqual({ name: "triage" });
    expect(parseAgentManifestRef("triage@3")).toEqual({ name: "triage", version: 3 });
    expect(parseAgentManifestRef("triage@0")).toBeUndefined();
  });
});

describe("checks between the sections", () => {
  it("finds no gap in a manifest whose sections fit", () => {
    expect(sectionGaps(triage())).toEqual([]);
  });

  it("refuses a custom harness off a pod or without an image", () => {
    const virtual = triage({ harness: { id: "acme-loop" }, runtime: { kind: "virtual" } });
    expect(sectionGaps(virtual)).toEqual(['harness.id "acme-loop" needs runtime.kind "pod"; the runtime is "virtual"']);
    const imageless = triage({ harness: { id: "acme-loop" }, runtime: { kind: "pod" } });
    expect(sectionGaps(imageless)).toEqual([
      'harness.id "acme-loop" needs runtime.image: a custom harness runs from its pod\'s image',
    ]);
    expect(sectionGaps(triage({ harness: { id: "acme-loop" } }))).toEqual([]);
  });

  it("refuses a credential that is no declared slot of the right type, bound to the right URL", () => {
    const server = (credential: string, url = "https://mcp.linear.app/mcp") => ({
      linear: { name: "linear", type: "streamable-http" as const, url, credential },
    });
    const runtime = {
      kind: "pod" as const,
      secrets: {
        MODE: { type: "environment_variable" as const },
        LINEAR_KEY: { type: "bearer" as const, url: "https://mcp.linear.app:443/mcp" },
      },
    };
    expect(sectionGaps({ harness: { mcpServers: server("LINEAR_KEY") }, runtime })).toEqual([]);
    expect(sectionGaps({ harness: { mcpServers: server("NOPE") }, runtime })).toEqual([
      'harness.mcpServers.linear.credential "NOPE" is not a secret slot in runtime.secrets',
    ]);
    expect(sectionGaps({ harness: { mcpServers: server("MODE") }, runtime })[0]).toContain(
      "is a slot of type environment_variable; an MCP server needs a bearer or headers slot",
    );
    expect(sectionGaps({ harness: { mcpServers: server("LINEAR_KEY", "https://other.example/mcp") }, runtime })[0]).toBe(
      'harness.mcpServers.linear.credential "LINEAR_KEY" is bound to https://mcp.linear.app:443/mcp, not to an MCP server\'s URL https://other.example/mcp',
    );
    // A server that names no credential keeps matching the vault by its URL (Q2).
    expect(sectionGaps({ harness: { mcpServers: { linear: { ...server("x").linear, credential: undefined } } }, runtime })).toEqual(
      [],
    );
    const tool = {
      name: "orders",
      inputSchema: { type: "object" },
      http: { url: "https://api.example.com/orders", credential: "ORDERS" },
    };
    expect(sectionGaps({ harness: { tools: [tool] }, runtime })).toEqual([
      'harness.tools.orders.http.credential "ORDERS" is not a secret slot in runtime.secrets',
    ]);
    const skill = { ...SKILL, secrets: ["MODE", "LINEAR_KEY", "MISSING"] };
    expect(sectionGaps({ harness: { skills: { labeler: skill } }, runtime })).toEqual([
      'harness.skills.labeler.secrets "LINEAR_KEY" is a slot of type bearer; a skill reads environment_secret or environment_variable slots',
      'harness.skills.labeler.secrets "MISSING" is not a secret slot in runtime.secrets',
    ]);
  });

  it("checks a flow's HTTP stages and verifiers, and embedded agents' HTTP tools, as an agent's HTTP tools", () => {
    const runtime = {
      kind: "none" as const,
      secrets: {
        MODE: { type: "environment_variable" as const },
        ORDERS: { type: "bearer" as const, url: "https://api.example.com/orders" },
        CHECKS: { type: "headers" as const, url: "https://checks.example/verify" },
      },
    };
    const http = (credential: string, url = "https://api.example.com/orders") => ({ url, credential });
    const flow = (stage: string, verifier: string, embedded: string) => ({
      kind: "workflow" as const,
      root: {
        chain: [
          { tool: { name: "fetch", http: http(stage) } },
          { loop: { run: { agent: "writer" }, verify: { http: http(verifier, "https://checks.example/verify") }, max: 3 } },
        ],
      },
      agents: {
        writer: {
          manifestSchemaVersion: 7 as const,
          id: "writer",
          tools: [{ name: "orders", inputSchema: { type: "object" }, http: http(embedded) }],
        },
      },
    });
    expect(sectionGaps({ harness: flow("ORDERS", "CHECKS", "ORDERS"), runtime })).toEqual([]);
    expect(sectionGaps({ harness: flow("NOPE", "MODE", "ORDERS"), runtime })).toEqual([
      'harness.root stage "fetch" http.credential "NOPE" is not a secret slot in runtime.secrets',
      'harness.root stage "@1.verify" http.credential "MODE" is a slot of type environment_variable; an HTTP verifier needs a bearer or headers slot',
    ]);
    expect(sectionGaps({ harness: flow("ORDERS", "ORDERS", "NOPE"), runtime })).toEqual([
      'harness.root stage "@1.verify" http.credential "ORDERS" is bound to https://api.example.com/orders, not to an HTTP verifier\'s URL https://checks.example/verify',
      'harness.agents.writer.tools.orders.http.credential "NOPE" is not a secret slot in runtime.secrets',
    ]);
    // An agent an agent's tool runs is checked too.
    const writer = flow("x", "x", "NOPE").agents.writer;
    expect(sectionGaps({ harness: { tools: [{ name: "write", inputSchema: { type: "object" }, agent: writer }] }, runtime })).toEqual([
      'harness.tools.write.agent.tools.orders.http.credential "NOPE" is not a secret slot in runtime.secrets',
    ]);
  });

  it("derives the sandbox the harness needs and checks the runtime's kind gives it", () => {
    expect(sandboxNeedOf({ instructions: ["x"] })).toBe("none");
    expect(sandboxNeedOf({ skills: { labeler: SKILL } })).toBe("sandbox");
    expect(sandboxNeedOf({ id: "acme-loop" })).toBe("pod");
    expect(sectionGaps({ harness: { skills: { labeler: SKILL } }, runtime: { kind: "none" } })).toEqual([
      'harness.skills needs a sandbox; runtime.kind "none" has none',
    ]);
    expect(sectionGaps({ harness: { skills: { labeler: SKILL } } })).toEqual([
      "harness.skills needs a sandbox; the manifest has no runtime section, so an Agent made from it has none",
    ]);
    expect(sectionGaps({ harness: { skills: { labeler: SKILL } }, runtime: { kind: "virtual" } })).toEqual([]);
  });

  it("names every gap at once", () => {
    const gaps = sectionGaps({
      harness: {
        id: "acme-loop",
        skills: { labeler: { ...SKILL, secrets: ["KEY"] } },
        mcpServers: { gh: { name: "gh", type: "sse", url: "https://gh.example/sse", credential: "GH" } },
      },
      runtime: { kind: "none" },
    });
    expect(gaps).toHaveLength(3);
  });

  it("normalizes credential URLs as the vault does", () => {
    expect(normalizeCredentialUrl("https://api.example.com:443/mcp")).toBe("https://api.example.com/mcp");
    expect(normalizeCredentialUrl("https://u:p@api.example.com/")).toBeUndefined();
    expect(normalizeCredentialUrl("ftp://api.example.com/")).toBeUndefined();
  });
});

describe("loop manifests and harness sections", () => {
  it("makes the loop manifest the engine runs, and back", () => {
    const loop = loopManifestOf(triage());
    expect(loop).toEqual({
      manifestSchemaVersion: 7,
      id: "triage",
      description: "Sorts new GitHub issues",
      instructions: ["Label and route new issues."],
      skills: { labeler: SKILL },
      mcpServers: { github: { name: "github", type: "streamable-http", url: "https://api.githubcopilot.com/mcp/" } },
    });
    const built = Agent({ id: "helper", description: "Helps" }).instructions("Help.").build().manifest;
    const section = harnessSectionOf(built);
    expect(section).toEqual({ instructions: ["Help."] });
    expect(loopManifestOf({ name: "helper", description: "Helps", harness: section })).toEqual(built);
  });

  it("records the plugins a loop manifest's skills and servers came from", () => {
    const plugin = { name: "github", version: "1.2.0" };
    const loop = { manifestSchemaVersion: 7 as const, id: "a", skills: { labeler: { ...SKILL, plugin } } };
    expect(pluginsOf(loop)).toEqual([plugin]);
    expect(harnessSectionOf(loop, { harness: "acme-loop" })).toEqual({
      id: "acme-loop",
      plugins: [plugin],
      skills: { labeler: { ...SKILL, plugin } },
    });
  });

  it("carries a flow as a workflow harness section", () => {
    const leaf = { manifestSchemaVersion: 7 as const, id: "leaf", description: "Leaf" };
    const flow = {
      manifestSchemaVersion: 8 as const,
      name: "pipeline",
      harness: { kind: "workflow" as const, root: { agent: "leaf" }, agents: { leaf } },
    };
    expect(AgentManifestV8Schema.parse(flow)).toEqual(flow);
    expect(loopManifestOf(flow)).toEqual({ kind: "workflow", workflowSchemaVersion: 3, id: "pipeline", root: { agent: "leaf" }, agents: { leaf } });
    const custom = AgentManifestV8Schema.safeParse({ ...flow, harness: { ...flow.harness, id: "acme-loop" } });
    expect(JSON.stringify(custom.error?.issues)).toContain("A flow runs in our harness");
    const missing = AgentManifestV8Schema.safeParse({ ...flow, harness: { ...flow.harness, agents: {} } });
    expect(JSON.stringify(missing.error?.issues)).toContain("not embedded in agents");
  });
});

describe("authoring files", () => {
  it("lets the agent file name its sections by path, and the harness file name folders and a credentials map", () => {
    expect(
      AgentManifestFileSchema.parse({
        $schema: "https://docs.nylorun.com/schemas/agent-manifest/v8.json",
        manifestSchemaVersion: 8,
        name: "triage",
        harness: "./harness.manifest.json",
        runtime: "../platform/pod.runtime.json",
      }).harness,
    ).toBe("./harness.manifest.json");
    const harness = {
      id: "nylorun",
      instructions: ["Label and route new issues."],
      skills: "./skills",
      mcpServers: "./mcp.json",
      plugins: ["../plugins/github"],
      credentials: { github: "GITHUB_TOKEN" },
      requires: { sandbox: "any" },
    };
    expect(HarnessManifestFileSchema.parse(harness)).toEqual(harness);
    expect(RuntimeManifestFileSchema.parse({ $schema: "x", kind: "pod" })).toEqual({ $schema: "x", kind: "pod" });
  });

  it("takes harness.model as <provider>/<model>, read as a session's model choice", () => {
    const base = { manifestSchemaVersion: 8, name: "coder", description: "Codes." } as const;
    expect(AgentManifestV8Schema.safeParse({ ...base, harness: { model: "anthropic/claude-sonnet-4-5" } }).success).toBe(true);
    for (const model of ["claude", "anthropic/", "a b/c", "a/b c", `a/${"m".repeat(200)}`, 3])
      expect(AgentManifestV8Schema.safeParse({ ...base, harness: { model } }).success, String(model)).toBe(false);
    expect(HarnessManifestFileSchema.safeParse({ model: "google/gemini-2.5-pro" }).success).toBe(true);
    expect(agentModelChoice("anthropic/claude-sonnet-4-5")).toEqual({ provider: "anthropic", model: "claude-sonnet-4-5" });
    expect(agentModelChoice("openrouter/google/gemini-2.5-pro")).toEqual({ provider: "openrouter", model: "google/gemini-2.5-pro" });
    expect(agentModelChoice("claude")).toBeUndefined();
    // The Runtime reads it; the engine's loop manifest never carries it.
    expect(loopManifestOf({ ...base, harness: { model: "anthropic/claude-sonnet-4-5", instructions: ["Code."] } })).not.toHaveProperty("model");
  });

  it("publishes the three files as JSON Schema documents", () => {
    expect(agentManifestJsonSchema().$id).toBe("https://docs.nylorun.com/schemas/agent-manifest/v8.1.json");
    expect(harnessManifestJsonSchema().$id).toBe("https://docs.nylorun.com/schemas/harness-manifest/v1.1.json");
    const runtime = runtimeManifestJsonSchema();
    expect(runtime.$id).toBe("https://docs.nylorun.com/schemas/runtime-manifest/v1.json");
    expect(Object.keys(runtime.properties as object)).toEqual(expect.arrayContaining(["$schema", "kind", "secrets"]));
  });
});

describe("runtime section (environment manifest v1's fields)", () => {
  it("checks its secret slots as environment manifests did", () => {
    const runtime = {
      kind: "pod",
      secrets: { GH_TOKEN: { type: "environment_secret", allowedHosts: ["api.github.com"], required: true } },
    };
    expect(RuntimeSectionSchema.parse(runtime)).toEqual(runtime);
    expect(RuntimeSectionSchema.safeParse({ ...runtime, secrets: { PATH: { type: "environment_variable" } } }).success).toBe(false);
    // A slot never carries a value.
    expect(RuntimeSectionSchema.safeParse({ ...runtime, secrets: { MODE: { type: "environment_variable", value: "x" } } }).success).toBe(false);
    expect(RuntimeSectionSchema.safeParse({ ...runtime, $schema: "x" }).success).toBe(false);
  });

  it("lets the runtime file take the composer's { path, from } files entry", () => {
    expect(RuntimeManifestFileSchema.parse({ kind: "pod", files: [{ path: "/workspace/data", from: "./data" }] }).files).toHaveLength(1);
    expect(RuntimeSectionSchema.safeParse({ kind: "pod", files: [{ path: "/workspace/data", from: "./data" }] }).success).toBe(false);
  });
});
