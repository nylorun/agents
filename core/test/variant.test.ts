import { describe, expect, it } from "vitest";
import type { AgentManifest } from "../src/types/manifest.js";
import { isVariantOf, withoutTools } from "../src/definition/variant.js";

const deploy = {
  name: "deploy",
  description: "Deploy",
  inputSchema: { type: "object", properties: {} },
};

const lookup = {
  name: "lookup",
  description: "Lookup",
  inputSchema: { type: "object", properties: {} },
};

const mcp = {
  github: {
    name: "github",
    type: "streamable-http" as const,
    url: "https://mcp.example.com/github",
    plugin: { name: "gh", version: "1.0.0" },
  },
};

const skills = {
  triage: {
    name: "triage",
    description: "Triage an issue.",
    files: { "SKILL.md": `sha256:${"a".repeat(64)}` },
  },
};

function manifest(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    manifestSchemaVersion: 7,
    id: "coder",
    instructions: ["Fix the tests."],
    tools: [deploy, lookup],
    ...overrides,
  };
}

describe("isVariantOf", () => {
  it("accepts the identical pinned manifest", () => {
    const pinned = manifest();
    expect(isVariantOf(pinned, pinned)).toBe(true);
  });

  it("rejects a changed id (LOOP-R16)", () => {
    const pinned = manifest();
    expect(isVariantOf(manifest({ id: "other" }), pinned)).toBe(false);
  });

  it("allows free data fields and instructions, but not the output schema (LOOP-R17)", () => {
    const pinned = manifest({ name: "Coder", description: "v1" });
    const candidate = manifest({
      name: "Coder v2",
      description: "revised",
      metadata: { lane: "l5" },
      instructions: ["Run the suite yourself before answering."],
    });
    expect(isVariantOf(candidate, pinned)).toBe(true);
    expect(isVariantOf(manifest({ instructions: undefined }), pinned)).toBe(true);
    expect(isVariantOf(manifest({ outputSchema: { type: "string" } }), pinned)).toBe(false);
    const typed = manifest({ outputSchema: { type: "string" } });
    expect(isVariantOf(manifest(), typed)).toBe(false);
    expect(isVariantOf(typed, typed)).toBe(true);
  });

  it("allows removing tools but not adding or changing them (LOOP-R18)", () => {
    const pinned = manifest();
    expect(isVariantOf(manifest({ tools: [lookup] }), pinned)).toBe(true);
    expect(isVariantOf(manifest({ tools: undefined }), pinned)).toBe(true);
    expect(
      isVariantOf(
        manifest({
          tools: [deploy, lookup, { name: "extra", inputSchema: { type: "object", properties: {} } }],
        }),
        pinned
      )
    ).toBe(false);
    expect(isVariantOf(manifest({ tools: [{ ...deploy, description: "changed" }, lookup] }), pinned)).toBe(
      false
    );
  });

  it("keeps skills as they were pinned, plugin labels included", () => {
    const pinned = manifest({ skills });
    expect(isVariantOf(manifest({ skills }), pinned)).toBe(true);
    expect(isVariantOf(manifest(), pinned)).toBe(false);
    expect(
      isVariantOf(manifest({ skills: { triage: { ...skills.triage, description: "Changed." } } }), pinned)
    ).toBe(false);
    expect(
      isVariantOf(manifest({ skills: { triage: { ...skills.triage, plugin: { name: "ops" } } } }), pinned)
    ).toBe(false);
    expect(isVariantOf(manifest({ skills }), manifest())).toBe(false);
  });

  it("keeps MCP servers, which may only be tightened (LOOP-R19, LOOP-R20)", () => {
    const pinned = manifest({ mcpServers: mcp });
    expect(isVariantOf(manifest({ mcpServers: mcp }), pinned)).toBe(true);
    // Dropped, moved or relabelled servers are refused.
    expect(isVariantOf(manifest(), pinned)).toBe(false);
    expect(
      isVariantOf(manifest({ mcpServers: { github: { ...mcp.github, url: "https://other.example" } } }), pinned)
    ).toBe(false);
    expect(
      isVariantOf(manifest({ mcpServers: { github: { ...mcp.github, plugin: { name: "gh", version: "2.0.0" } } } }), pinned)
    ).toBe(false);
    // Tightened: a tool disabled.
    expect(
      isVariantOf(
        manifest({ mcpServers: { github: { ...mcp.github, tools: { delete_repo: { enabled: false } } } } }),
        pinned
      )
    ).toBe(true);
    // Added servers are refused.
    expect(isVariantOf(manifest({ mcpServers: mcp }), manifest())).toBe(false);
  });

  it("rejects adding a tool on a variant (LOOP-A6)", () => {
    const pinned = manifest({ tools: [lookup] });
    expect(isVariantOf(manifest({ tools: [lookup, deploy] }), pinned)).toBe(false);
  });

  it("treats a self-variant as valid against the pinned session (LOOP-R15)", () => {
    const pinned = manifest({ name: "pinned" });
    const redeployed = manifest({ name: "redeployed-copy" });
    // Variant of the session pin — not of a later deploy digest.
    expect(isVariantOf(redeployed, pinned)).toBe(true);
  });
});

describe("withoutTools", () => {
  const helper: AgentManifest = {
    manifestSchemaVersion: 7,
    id: "helper",
    instructions: ["Help."],
    tools: [deploy, lookup],
    mcpServers: { github: { ...mcp.github, tools: { "*": { enabled: true }, read: { deferred: true } } } },
  };
  const pinned = manifest({
    tools: [deploy, lookup, { name: "helper", inputSchema: { type: "object" }, agent: helper }],
    mcpServers: mcp,
  });

  it("removes declared tools by name, in the root and in the agents it uses as tools", () => {
    const next = withoutTools(pinned, ["deploy"]);
    expect(next.tools?.map((tool) => tool.name)).toEqual(["lookup", "helper"]);
    expect((next.tools?.[1]?.agent as AgentManifest).tools?.map((tool) => tool.name)).toEqual(["lookup"]);
    expect(isVariantOf(next, pinned)).toBe(true);
    // An agent used as a tool goes as a whole by its name.
    expect(withoutTools(pinned, ["helper"]).tools?.map((tool) => tool.name)).toEqual(["deploy", "lookup"]);
  });

  it("disables an MCP server's tool by server__tool, and a whole server by its name", () => {
    const one = withoutTools(pinned, ["github__create_issue"]);
    expect(one.mcpServers?.github?.tools).toEqual({ create_issue: { enabled: false } });
    const child = (one.tools?.[2]?.agent as AgentManifest).mcpServers?.github?.tools;
    expect(child).toEqual({ "*": { enabled: true }, read: { deferred: true }, create_issue: { enabled: false } });
    expect(isVariantOf(one, pinned)).toBe(true);

    const all = withoutTools(pinned, ["github"]);
    expect(all.mcpServers?.github?.tools).toEqual({ "*": { enabled: false } });
    expect((all.tools?.[2]?.agent as AgentManifest).mcpServers?.github?.tools).toEqual({
      "*": { enabled: false },
      read: { deferred: true, enabled: false },
    });
    expect(isVariantOf(all, pinned)).toBe(true);
  });

  it("ignores names the manifest does not have", () => {
    expect(withoutTools(pinned, ["nothing", "other__tool"])).toBe(pinned);
    expect(withoutTools(pinned, [])).toBe(pinned);
  });

  it("lets a variant narrow an agent used as a tool, and nothing more", () => {
    const narrowed = withoutTools(pinned, ["lookup"]);
    expect(isVariantOf(narrowed, pinned)).toBe(true);
    const changed = manifest({
      tools: [deploy, lookup, { name: "helper", inputSchema: { type: "object" }, agent: { ...helper, instructions: ["Other."] } }],
      mcpServers: mcp,
    });
    expect(isVariantOf(changed, pinned)).toBe(false);
    const widened = manifest({
      tools: [deploy, lookup, { name: "helper", inputSchema: { type: "object" }, agent: { ...helper, tools: [deploy, lookup, { ...deploy, name: "extra" }] } }],
      mcpServers: mcp,
    });
    expect(isVariantOf(widened, pinned)).toBe(false);
  });
});
