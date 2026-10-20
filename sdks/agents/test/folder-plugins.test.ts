import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { agentManifest } from "../src/agent-manifests.js";
import { Agent } from "../src/builder.js";
import { checkFolder } from "../src/folder-check.js";
import { packFolder } from "../src/folder-pack.js";

/**
 * A vendored Agent Plugin (track T7): `plugins/<name>/` in an agent folder folds into the manifest
 * exactly as `.plugin()` folds the same package into a TypeScript agent.
 */

function write(directory: string, path: string, contents: string): void {
  const file = join(directory, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, contents);
}

it("folds plugins/<name>/ as .plugin() folds the same package", async () => {
  const root = mkdtempSync(join(tmpdir(), "nylorun-folder-plugin-"));
  write(root, "AGENT.md", "---\nname: parent\ndescription: Uses a plugin.\n---\nParent.\n");
  // The plugin's skill needs a sandbox, as any skill does.
  write(root, "runtime.json", '{ "kind": "virtual" }');
  const plugin = join(root, "plugins/docs");
  write(plugin, "plugin.json", JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "docs", version: "1.2.0" }));
  write(
    plugin,
    "mcp.json",
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { github: { type: "streamable-http", url: "https://mcp.example.com/github", headers: { "X-MCP-Readonly": "true" } } },
    }),
  );
  write(plugin, "skills/triage/SKILL.md", "---\nname: triage\ndescription: Triage an issue.\n---\nRead the issue.\n");
  write(plugin, "skills/triage/references/labels.md", "# Labels\n");

  const compiled = await checkFolder(await packFolder(root));
  expect(compiled.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  const typescript = agentManifest({ agent: Agent({ id: "parent", description: "Uses a plugin." }).instructions("Parent.").plugin(plugin), runtime: { kind: "virtual" } });
  expect(compiled.manifest).toEqual(typescript);
});
