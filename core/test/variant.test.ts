import { describe, expect, it } from "vitest";
import type { AgentManifest, CapabilityManifest } from "../src/types/manifest.js";
import { isVariantOf } from "../src/definition/variant.js";

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
  },
};

function capability(
  overrides: Partial<CapabilityManifest> & { id: string }
): CapabilityManifest {
  return {
    type: "agent",
    ...overrides,
  };
}

function manifest(
  overrides: Partial<AgentManifest> & {
    capabilities?: readonly CapabilityManifest[];
  } = {}
): AgentManifest {
  return {
    manifestSchemaVersion: 5,
    id: "coder",
    capabilities: overrides.capabilities ?? [
      capability({
        id: "main",
        instructions: ["Fix the tests."],
        tools: [deploy, lookup],
      }),
    ],
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

  it("allows free data fields (LOOP-R17)", () => {
    const pinned = manifest({ name: "Coder", description: "v1" });
    const candidate = manifest({
      name: "Coder v2",
      description: "revised",
      metadata: { lane: "l5" },
      outputSchema: { type: "string" },
      capabilities: [
        capability({
          id: "main",
          instructions: ["Run the suite yourself before answering."],
          tools: [deploy, lookup],
          name: "Main",
          description: "primary",
          metadata: { k: 1 },
        }),
      ],
    });
    expect(isVariantOf(candidate, pinned)).toBe(true);
  });

  it("allows removing tools but not adding or changing them (LOOP-R18)", () => {
    const pinned = manifest();
    expect(
      isVariantOf(
        manifest({
          capabilities: [
            capability({ id: "main", instructions: ["x"], tools: [lookup] }),
          ],
        }),
        pinned
      )
    ).toBe(true);
    expect(
      isVariantOf(
        manifest({
          capabilities: [
            capability({
              id: "main",
              tools: [
                deploy,
                lookup,
                {
                  name: "extra",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            }),
          ],
        }),
        pinned
      )
    ).toBe(false);
    expect(
      isVariantOf(
        manifest({
          capabilities: [
            capability({
              id: "main",
              tools: [{ ...deploy, description: "changed" }, lookup],
            }),
          ],
        }),
        pinned
      )
    ).toBe(false);
  });

  it("keeps a capability that declares MCP servers, and frees its data (LOOP-R19, LOOP-D3)", () => {
    const pinned = manifest({
      capabilities: [
        capability({ id: "policy", mcpServers: mcp, tools: [deploy] }),
        capability({ id: "main", tools: [lookup] }),
      ],
    });
    expect(
      isVariantOf(
        manifest({ capabilities: [capability({ id: "main", tools: [lookup] })] }),
        pinned
      )
    ).toBe(false);
    expect(
      isVariantOf(
        manifest({
          capabilities: [
            capability({ id: "policy", mcpServers: mcp, tools: [], instructions: ["stricter"] }),
            capability({ id: "main", tools: [lookup] }),
          ],
        }),
        pinned
      )
    ).toBe(true);
  });

  it("rejects MCP or sandbox changes (LOOP-R20)", () => {
    const pinned = manifest({
      capabilities: [
        capability({
          id: "main",
          tools: [deploy],
          mcpServers: mcp,
        }),
      ],
    });
    expect(
      isVariantOf(
        manifest({
          capabilities: [capability({ id: "main", tools: [deploy] })],
        }),
        pinned
      )
    ).toBe(false);
    expect(
      isVariantOf(
        manifest({
          capabilities: [
            capability({
              id: "main",
              tools: [deploy],
              mcpServers: {
                github: { ...mcp.github, url: "https://other.example" },
              },
            }),
          ],
        }),
        pinned
      )
    ).toBe(false);
  });

  it("rejects adding a tool on a variant (LOOP-A6)", () => {
    const pinned = manifest({
      capabilities: [capability({ id: "main", tools: [lookup] })],
    });
    expect(
      isVariantOf(
        manifest({
          capabilities: [
            capability({ id: "main", tools: [lookup, deploy] }),
          ],
        }),
        pinned
      )
    ).toBe(false);
  });

  it("treats a self-variant as valid against the pinned session (LOOP-R15)", () => {
    const pinned = manifest({ name: "pinned" });
    const redeployed = manifest({ name: "redeployed-copy" });
    // Variant of the session pin — not of a later deploy digest.
    expect(isVariantOf(redeployed, pinned)).toBe(true);
  });
});
