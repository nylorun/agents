import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { Agent, checkFolder, packFolder, previewTurn } from "../src/index.js";

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "nylorun-preview-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe("previewTurn (ADR-100)", () => {
  it("shows what a folder's agent reads and may call, offline", async () => {
    const dir = folder({
      "AGENT.md":
        "---\nname: helper\ndescription: Helps.\nformat: agent-folder/2\nmemory: {}\nengine:\n  sandbox: [bash]\n  outputs: true\n---\nHelp the person.\n",
      "runtime.json": '{ "kind": "virtual" }\n',
    });
    const { manifest } = await checkFolder(await packFolder(dir));
    const preview = previewTurn(manifest!);
    expect(preview.tools.map((tool) => tool.name)).toEqual(["bash", "memory"]);
    expect(preview.system.split("\n\n")[0]).toBe("Help the person.");
    expect(preview.system).toContain("Files you write under /workspace/outputs reach the user:");
    expect(preview.system).not.toContain("save_artifact");
    expect(preview.blocks.map((block) => `${block.name}@${block.version}`)).toEqual(["sandbox@1", "outputs@1", "memory@1"]);
    expect(preview.pinned).toEqual([expect.stringContaining("<memory-index>")]);
  });

  it("shows the triggers tool and its block for a root agent that declares engine.triggers (D83)", async () => {
    const dir = folder({
      "AGENT.md": "---\nname: helper\ndescription: Helps.\nformat: agent-folder/2\nengine:\n  triggers: true\n---\nHelp the person.\n",
    });
    const { manifest } = await checkFolder(await packFolder(dir));
    const preview = previewTurn(manifest!);
    expect(preview.tools.map((tool) => tool.name)).toEqual(["triggers"]);
    expect(preview.blocks.map((block) => `${block.name}@${block.version}`)).toEqual(["triggers@1"]);
    expect(previewTurn(manifest!, { triggers: false }).tools).toEqual([]);
  });

  it("previews an SDK-built agent with every default, with the session's facts it is given", () => {
    const { manifest } = Agent({ id: "bot" }).instructions("Be brief.").build();
    expect(previewTurn(manifest).tools.map((tool) => tool.name)).toEqual(["read_artifact"]);
    const sandboxed = previewTurn(manifest, { sandbox: true, selfWake: true });
    expect(sandboxed.tools.map((tool) => tool.name)).toEqual([
      "bash",
      "read",
      "write",
      "edit",
      "grep",
      "glob",
      "save_artifact",
      "read_artifact",
      "schedule_wake",
    ]);
    expect(sandboxed.system.startsWith("Be brief.\n\nYou have an isolated Linux sandbox")).toBe(true);
  });
});
