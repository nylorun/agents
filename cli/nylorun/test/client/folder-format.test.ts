import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCommand } from "../../src/client/folder.js";
import { migrateCommand } from "../../src/client/migrate.js";
import { withFrontmatter } from "../../src/client/migrate-format.js";
import { temporaryDir, temporaryHome, testDeps } from "../stack/support.js";

async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
}

const AGENT =
  "---\nname: helper\ndescription: Helps.\nmemory:\n  instructions: Keep preferences.\nloop:\n  plan: true\n---\nHelp the person.\n";
const SCOUT = "---\nname: scout\ndescription: Looks things up.\n---\nLook it up.\n";

async function folder(files: Record<string, string>) {
  const dir = await temporaryDir();
  await write(join(dir, "helper"), files);
  const deps = testDeps(await temporaryHome(), { cwd: dir });
  return { dir, deps };
}

describe("nylorun check --explain (ADR-100)", () => {
  it("prints each engine feature, on or off, with the tools and text it adds", async () => {
    const { deps } = await folder({
      "AGENT.md":
        "---\nname: helper\ndescription: Helps.\nformat: agent-folder/2\nengine:\n  sandbox: [read]\n  artifacts: { read: true }\n---\nHelp.\n",
      "runtime.json": '{ "kind": "virtual" }\n',
    });
    expect(await checkCommand(deps, ["helper", "--explain"])).toBe(0);
    expect(deps.lines).toContain("helper: ok, agent manifest helper (2 files, agent-folder/2)");
    expect(deps.lines).toContain("  helper: declares its engine features (agent-folder/2)");
    expect(deps.lines).toContain("    on  sandbox (engine.sandbox): tools read; text sandbox@1");
    expect(deps.lines).toContain("    on  artifacts.read (engine.artifacts.read): tools read_artifact; text artifacts_read@1");
    expect(deps.lines).toContain("    off artifacts.save (engine.artifacts.save)");
    expect(deps.lines).toContain("    off outputs (engine.outputs)");
  });

  it("explains an agent-folder/1 folder's defaults, and puts the features in --json", async () => {
    const { deps } = await folder({ "AGENT.md": AGENT, "runtime.json": '{ "kind": "virtual" }\n' });
    expect(await checkCommand(deps, ["helper", "--explain", "--json"])).toBe(0);
    const [report] = JSON.parse(deps.lines.at(-1)!).folders;
    const [root] = report.explain;
    expect(root).toMatchObject({ agent: "helper", declared: false });
    expect(root.features.find((item: { feature: string }) => item.feature === "sandbox")).toMatchObject({
      on: true,
      declaredBy: "by default",
      tools: ["bash", "read", "write", "edit", "grep", "glob"],
    });
  });
});

describe("nylorun migrate folder --to 2 (ADR-100)", () => {
  it("declares what an agent-folder/1 folder gets by default, so nothing its model sees changes", async () => {
    const { dir, deps } = await folder({
      "AGENT.md": AGENT,
      "runtime.json": '{ "kind": "virtual" }\n',
      "agents/scout/AGENT.md": SCOUT,
    });
    expect(await migrateCommand(deps, ["folder", "helper", "--to", "2"])).toBe(0);
    const root = await readFile(join(dir, "helper", "AGENT.md"), "utf8");
    expect(root).toBe(
      "---\nformat: agent-folder/2\nname: helper\ndescription: Helps.\nmemory:\n  instructions: Keep preferences.\nloop:\n  plan: true\n" +
        "engine:\n  sandbox: [bash, read, write, edit, grep, glob]\n  artifacts: { read: true, save: true }\n  outputs: true\n  toolSearch: true\n---\nHelp the person.\n",
    );
    expect(await readFile(join(dir, "helper", "agents/scout/AGENT.md"), "utf8")).toContain("engine:\n  sandbox: [bash");
    expect(await checkCommand(deps, ["helper"])).toBe(0);
    expect(deps.lines.at(-1)).toBe("helper: ok, agent manifest helper (3 files, agent-folder/2)");
    // Again: nothing to do.
    expect(await migrateCommand(deps, ["folder", "helper", "--to", "2"])).toBe(0);
    expect(deps.lines.at(-1)).toBe("helper is agent-folder/2 already: nothing to do.");
  });

  it("declares read_artifact only, and no computer's features, without a computer", async () => {
    const { dir, deps } = await folder({ "AGENT.md": AGENT.replace("format: 1\n", "") });
    expect(await migrateCommand(deps, ["folder", "helper", "--to", "2"])).toBe(0);
    expect(await readFile(join(dir, "helper", "AGENT.md"), "utf8")).toContain(
      "engine:\n  artifacts: { read: true, save: false }\n  toolSearch: true\n---",
    );
  });

  it("refuses a folder that does not compile, and another --to", async () => {
    const { deps } = await folder({ "AGENT.md": "---\nname: helper\n---\nHelp.\n" });
    await expect(migrateCommand(deps, ["folder", "helper", "--to", "2"])).rejects.toMatchObject({ exitCode: 1 });
    await expect(migrateCommand(deps, ["folder", "helper", "--to", "3"])).rejects.toMatchObject({ exitCode: 2 });
  });

  it("replaces a format line and keeps the file's line ends", () => {
    expect(withFrontmatter("---\r\nname: a\r\nformat: 1\r\n---\r\nBody\r\n", ["engine: {}"], "agent-folder/2")).toBe(
      "---\r\nname: a\r\nformat: agent-folder/2\r\nengine: {}\r\n---\r\nBody\r\n",
    );
    expect(withFrontmatter("no frontmatter", [])).toBeUndefined();
  });
});
