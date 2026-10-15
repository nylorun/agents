/**
 * The skill a call of our engine's tool ran (protocol 15): the engine names it on the effect
 * (`skill`), and the record keeps it when the agent has that skill.
 */
import { expect, it } from "vitest";
import { skillOfToolCall } from "../src/tools/trace.js";

const sha = `sha256:${"a".repeat(64)}`;
const agent = {
  skills: {
    triage: { name: "triage", description: "Triage.", files: { "SKILL.md": sha } },
    notes: { name: "notes", description: "Notes.", files: { "SKILL.md": sha } },
  },
};
const harness = (name: string) => ({ name, target: { kind: "harness" as const } });
const sandbox = (name: string) => ({ name, target: { kind: "sandbox" as const } });

it("names the skill a skill tool loads, by its input", () => {
  expect(skillOfToolCall(agent, harness("load_skill"), { name: "triage" })).toBe("triage");
  expect(
    skillOfToolCall(agent, harness("read_skill_resource"), { name: "notes", path: "a.md" }),
  ).toBe("notes");
  expect(skillOfToolCall(agent, harness("load_skill"), { name: "missing" })).toBeUndefined();
  // An MCP tool of that name is not ours.
  expect(
    skillOfToolCall(agent, { name: "load_skill", target: { kind: "mcp" } }, { name: "triage" }),
  ).toBeUndefined();
});

it("matches a sandbox call's input on the skills' folder", () => {
  expect(
    skillOfToolCall(agent, sandbox("bash"), {
      command: "python /skills/triage/scripts/run.py --x",
    }),
  ).toBe("triage");
  expect(skillOfToolCall(agent, sandbox("read"), { path: "/skills/notes/references/a.md" })).toBe(
    "notes",
  );
  // A version's folder (D66).
  expect(
    skillOfToolCall(agent, sandbox("bash"), {
      command: "python /skills/triage@0123456789ab/scripts/run.py",
    }),
  ).toBe("triage");
  expect(skillOfToolCall(agent, sandbox("read"), { path: "/skills/notes@abcdef012345/a.md" })).toBe(
    "notes",
  );
  expect(
    skillOfToolCall(agent, sandbox("grep"), { pattern: "todo", path: "/skills/triage/" }),
  ).toBe("triage");
  // A script started without its path in the command is not traced.
  expect(
    skillOfToolCall(agent, sandbox("bash"), { command: "cd /skills && ./run" }),
  ).toBeUndefined();
  expect(
    skillOfToolCall(agent, sandbox("bash"), { command: "cat /skills/other/x" }),
  ).toBeUndefined();
  // Only sandbox calls and our skill tools are traced to a skill.
  expect(skillOfToolCall(agent, { name: "lookup" }, { path: "/skills/triage/a" })).toBeUndefined();
  expect(skillOfToolCall({}, sandbox("bash"), { command: "/skills/triage/run" })).toBeUndefined();
});
