import { expect, it } from "vitest";
import { agentFrom, hashManifest, schemaFromJSON } from "../src/define.js";

it("keeps session tools out of the hashed manifest", () => {
  const manifest = {
    manifestSchemaVersion: 7 as const,
    id: "bot",
    instructions: ["Triage issues."],
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
  const plain = agentFrom(manifest, {});
  const agent = agentFrom(
    manifest,
    { tools: { github__get_issue: tool } },
    {
      sessionTools: [
        { name: "github__get_issue", instructions: ["Read issues with github__get_issue."] },
      ],
    },
  );
  expect(agent.manifest).toEqual(plain.manifest);
  expect(hashManifest(agent.manifest)).toBe(hashManifest(plain.manifest));
  expect(JSON.stringify(agent.manifest)).not.toContain("github__get_issue");
  // Session tools are offered with the session part, after the agent's own.
  const parts = agent.getBinding().parts;
  expect(parts.map((part) => part.id)).toEqual(["agent", "session"]);
  expect(parts[1]?.sessionTools?.[0]?.name).toBe("github__get_issue");
  expect(parts[1]?.sessionInstructions).toEqual(["Read issues with github__get_issue."]);
  expect(JSON.stringify(agent.manifest)).not.toContain("Read issues with");
  expect(agent.toJSON()).toEqual(plain.manifest);
});

it("refuses a session tool without code, or named like a declared tool", () => {
  const manifest = {
    manifestSchemaVersion: 7 as const,
    id: "bot",
    tools: [{ name: "bash", inputSchema: { type: "object" } }],
  };
  const bash = { tools: { bash: { name: "bash", inputSchema: schemaFromJSON({ type: "object" }), execute: async () => "ok" } } };
  expect(() => agentFrom(manifest, bash, { sessionTools: [{ name: "github__get_issue" }] })).toThrow(
    /Missing session tool implementation 'github__get_issue'/,
  );
  expect(() => agentFrom(manifest, bash, { sessionTools: [{ name: "bash" }] })).toThrow(
    /Session tool 'bash' collides with a declared tool/,
  );
});

it("offers the session's text before its tools' own, unhashed", () => {
  const manifest = { manifestSchemaVersion: 7 as const, id: "bot", instructions: ["Own."] };
  const search = { name: "tool_search", inputSchema: schemaFromJSON({ type: "object" }), execute: async () => "ok" };
  const agent = agentFrom(
    manifest,
    { tools: { tool_search: search } },
    { sessionTools: [{ name: "tool_search", instructions: ["Tool note."] }], sessionInstructions: ["Engine note."] },
  );
  expect(agent.getBinding().parts[1]?.sessionInstructions).toEqual(["Engine note.", "Tool note."]);
  expect(hashManifest(agent.manifest)).toBe(hashManifest(agentFrom(manifest, {}).manifest));
  // Text alone makes a session part too.
  expect(agentFrom(manifest, {}, { sessionInstructions: ["Note."] }).getBinding().parts.map((part) => part.id)).toEqual([
    "agent",
    "session",
  ]);
});
