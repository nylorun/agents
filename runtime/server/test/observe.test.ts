import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { jsonlObserver } from "../src/adapters/observe.js";

it("writes raw observe events beside the session durability directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-observe-"));
  try {
    const observer = jsonlObserver({
      agentId: "assistant",
      sessionId: "talk",
      root,
    });
    observer({ type: "model.requested", turnId: "turn-1" });
    const file = join(root, "assistant", "talk", "observe.jsonl");
    let text = "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        text = await readFile(file, "utf8");
        if (text) break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    expect(JSON.parse(text)).toMatchObject({
      type: "model.requested",
      turnId: "turn-1",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
