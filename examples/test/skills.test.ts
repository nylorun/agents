import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SANDBOX_TOOL_LIMITS, engineToolsFor } from "@nylorun/harness";
import { describe, expect, it } from "vitest";
import { createSkills, SKILLS_CATALOG } from "../agents/skills/agent.js";

const sha256 = (path: string) =>
  `sha256:${createHash("sha256").update(readFileSync(join(SKILLS_CATALOG, path))).digest("hex")}`;

describe("the Skills agent", () => {
  it("names each skill's files by hash and leaves their bodies out of the manifest", async () => {
    const agent = await createSkills({ provider: "configured", model: "x" } as never);
    expect(agent.manifest.skills).toEqual({
      "code-review": {
        name: "code-review",
        description: expect.any(String),
        files: { "SKILL.md": sha256("code-review/SKILL.md") },
      },
      "structured-summary": {
        name: "structured-summary",
        description: expect.any(String),
        files: { "SKILL.md": sha256("structured-summary/SKILL.md") },
      },
    });
    expect(JSON.stringify(agent.manifest)).not.toContain("## Claim");
    // Our harness adds the catalog and load_skill when it runs a turn (protocol 15); with no file
    // besides SKILL.md there is no read_skill_resource.
    const engine = engineToolsFor(agent.manifest, undefined, {
      artifactPageBytes: 1024,
      sandboxTools: DEFAULT_SANDBOX_TOOL_LIMITS,
      skillReadBytes: 1024,
    });
    expect(engine.instructions.join("\n")).toContain("<name>structured-summary</name>");
    expect(engine.tools.map((tool) => tool.name)).toEqual(["load_skill", "read_artifact"]);
    // `.skills(dir)` names its part after the folder.
    const declaration = agent.getBinding().parts.find((item) => item.id === "skills:catalog");
    expect(Object.keys(declaration?.skillFiles ?? {}).sort()).toEqual(
      [sha256("code-review/SKILL.md"), sha256("structured-summary/SKILL.md")].sort(),
    );
  });
});
