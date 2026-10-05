import { expect, it } from "vitest";
import { agentFrom, hashManifest, schemaFromJSON } from "../src/define.js";

it("keeps session tools out of the hashed manifest", () => {
  const manifest = {
    manifestSchemaVersion: 5 as const,
    id: "bot",
    capabilities: [{ id: "issue-management", type: "agent" as const }],
  };
  const tool = {
    name: "github__get_issue",
    description: "Read an issue.",
    inputSchema: schemaFromJSON({
      type: "object",
      properties: { number: { type: "integer" } },
    }),
    async execute() {
      return { kind: "completed" as const, output: { title: "bug" } };
    },
  };
  const plain = agentFrom(manifest, { "issue-management": {} });
  const agent = agentFrom(
    manifest,
    { "issue-management": { tools: { github__get_issue: tool } } },
    {
      sessionTools: [
        { capabilityId: "issue-management", name: "github__get_issue" },
      ],
    },
  );
  expect(agent.manifest).toEqual(plain.manifest);
  expect(hashManifest(agent.manifest)).toBe(hashManifest(plain.manifest));
  expect(JSON.stringify(agent.manifest)).not.toContain("github__get_issue");
  expect(agent.getBinding().declarations[0]?.sessionTools?.[0]?.name).toBe(
    "github__get_issue",
  );
  expect(agent.toJSON()).toEqual(plain.manifest);
});
