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
  // Session tools are offered with the `runtime` part, after the agent's own.
  const parts = agent.getBinding().parts;
  expect(parts.map((part) => part.id)).toEqual(["agent", "runtime"]);
  expect(parts[1]?.sessionTools?.[0]?.name).toBe("github__get_issue");
  expect(parts[1]?.sessionInstructions).toEqual(["Read issues with github__get_issue."]);
  expect(JSON.stringify(agent.manifest)).not.toContain("Read issues with");
  expect(agent.toJSON()).toEqual(plain.manifest);
});

it("refuses a session tool without code, or named like a declared tool", () => {
  const manifest = {
    manifestSchemaVersion: 7 as const,
    id: "bot",
    runtime: { tools: [{ name: "bash", inputSchema: { type: "object" } }] },
  };
  expect(() => agentFrom(manifest, {}, { sessionTools: [{ name: "github__get_issue" }] })).toThrow(
    /Missing session tool implementation 'github__get_issue'/,
  );
  expect(() => agentFrom(manifest, {}, { sessionTools: [{ name: "bash" }] })).toThrow(
    /Session tool 'bash' collides with a declared tool/,
  );
  // A Runtime tool without code is a stub that says it runs in the Runtime.
  const bash = agentFrom(manifest, {}).getBinding().tools[0]!;
  return expect(bash.execute({}, {} as never)).rejects.toMatchObject({ code: "tool.runtime-only" });
});
