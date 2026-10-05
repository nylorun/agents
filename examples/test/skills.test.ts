import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSkills, SKILLS_CATALOG } from "../agents/skills/agent.js";

const sha256 = (path: string) =>
  `sha256:${createHash("sha256").update(readFileSync(join(SKILLS_CATALOG, path))).digest("hex")}`;

describe("the Skills agent", () => {
  it("names each skill's files by hash and leaves their bodies out of the manifest", async () => {
    const agent = await createSkills({ provider: "configured", model: "x" } as never);
    const capability = agent.manifest.capabilities.find((item) => item.id === "skills");
    expect(capability?.skills).toEqual({
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
    expect(capability?.instructions?.join("\n")).toContain("<name>structured-summary</name>");
    expect(JSON.stringify(agent.manifest)).not.toContain("## Claim");
    // The Runtime serves load_skill; with no file besides SKILL.md there is no read_skill_resource.
    expect(capability?.tools?.map((tool) => tool.name)).toEqual(["load_skill"]);
    const declaration = agent.getBinding().declarations.find((item) => item.id === "skills");
    expect(Object.keys(declaration?.skillFiles ?? {}).sort()).toEqual(
      [sha256("code-review/SKILL.md"), sha256("structured-summary/SKILL.md")].sort(),
    );
  });
});
