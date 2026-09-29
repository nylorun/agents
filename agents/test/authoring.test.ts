import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Agent,
  AgentBuilder,
  McpError,
  SandboxError,
  hashManifest,
  plugin,
  skills,
  tool,
} from "../src/index.js";
import {
  AgentBuilder as CoreAgentBuilder,
  McpError as CoreMcpError,
  SandboxError as CoreSandboxError,
} from "@nylorun/core/define";

/** Flow Agents Phase 1: the agents package's Agent adds .skills() and .plugin(). */

function write(directory: string, path: string, contents: string): void {
  const file = join(directory, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

function skillsFolder(): string {
  const directory = mkdtempSync(join(tmpdir(), "nylorun-authoring-skills-"));
  write(
    directory,
    "changelog/SKILL.md",
    "---\nname: changelog\ndescription: Write a changelog entry.\n---\nSteps.\n"
  );
  return directory;
}

function pluginFolder(): string {
  const directory = mkdtempSync(join(tmpdir(), "nylorun-authoring-plugin-"));
  write(
    directory,
    "plugin.json",
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "github",
      version: "1.0.0",
      description: "GitHub helpers.",
    })
  );
  write(
    directory,
    "skills/open-pr/SKILL.md",
    "---\nname: open-pr\ndescription: Open a pull request.\n---\nSteps.\n"
  );
  return directory;
}

const look = tool({
  name: "look",
  input: z.object({ q: z.string() }),
  async run() {
    return "";
  },
});

describe("Agent from @nylorun/agents", () => {
  it(".skills() and .plugin() match the .use() forms", () => {
    const folder = skillsFolder();
    const pkg = pluginFolder();
    const fresh = Agent({ id: "a" }).instructions("x").skills(folder).plugin(pkg);
    const legacy = Agent({ id: "a" }).instructions("x").use(skills(folder)).use(plugin(pkg));
    expect(hashManifest(fresh.build().manifest)).toBe(hashManifest(legacy.build().manifest));
    expect(fresh.build().manifest.capabilities.map((c) => c.id)).toEqual([
      "agent",
      folder.split("/").at(-1),
      "github",
    ]);
  });

  it("keeps its methods through chaining", () => {
    const agent = Agent({ id: "a" }).tools(look).output(z.object({ ok: z.boolean() })).skills(skillsFolder());
    expect(agent).toBeInstanceOf(AgentBuilder);
    expect(agent).toBeInstanceOf(CoreAgentBuilder);
    expect(agent.build().manifest.outputSchema).toBeDefined();
  });

  it("re-exports the same error classes as core", () => {
    expect(McpError).toBe(CoreMcpError);
    expect(SandboxError).toBe(CoreSandboxError);
  });
});
