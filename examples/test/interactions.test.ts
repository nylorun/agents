import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, bindingFromAgent } from "@nylorun/harness/run";
import { model } from "@nylorun/core/define";
import { afterEach, expect, it } from "vitest";
import { createInteractions } from "../agents/interactions/agent.js";

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("pauses write_note for approval before it writes", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "interactions-"));
  temps.push(dataRoot);
  const agent = createInteractions({ provider: "configured", model: "x", dataRoot } as never);
  const adapter = model(async () => ({
    output: [{ type: "tool-call" as const, id: "w-1", name: "write_note", args: { text: "groceries" } }],
    finishReason: "tool-calls" as const,
  }));
  const result = await run({
    binding: bindingFromAgent(agent),
    input: "Save a note: groceries.",
    onModelCall: adapter,
  });
  expect(JSON.stringify(result)).toContain('Approve write_note?\\n\\n{\\"text\\":\\"groceries\\"}');
  expect(result.status).toBe("paused");
  await expect(readFile(join(dataRoot, "interactions", "notes.jsonl"), "utf8")).rejects.toThrow();
});
