import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { compileAgentFolder, folderTextPaths, type AgentFolderDiagnostic, type AgentFolderEntry } from "../src/folder/index.js";
import { AgentManifestV8Schema, SessionCommandSchema } from "../src/contracts.js";

/** `disable-model-invocation: true` in a SKILL.md: a skill only a person starts. */

const encoder = new TextEncoder();
function compile(files: Record<string, string | Uint8Array>) {
  const entries: AgentFolderEntry[] = [];
  const bytes = new Map<string, Uint8Array>();
  for (const [path, content] of Object.entries(files)) {
    const data = typeof content === "string" ? encoder.encode(content) : content;
    entries.push({ path, size: data.byteLength, sha256: bytesToHex(sha256(data)) });
    bytes.set(path, data);
  }
  const text = new Map(folderTextPaths(entries).map((path) => [path, bytes.get(path)!]));
  return compileAgentFolder({ entries, files: text });
}
const errors = (diagnostics: readonly AgentFolderDiagnostic[]) => diagnostics.filter((item) => item.severity === "error");
const md = (front: string, body = "") => `---\n${front}---\n${body}`;
const BASE = { "AGENT.md": md("name: bot\ndescription: A bot.\n", "Help.\n"), "runtime.json": JSON.stringify({ kind: "virtual" }) };
type Skill = { disableModelInvocation?: boolean };
const skillsOf = (manifest: unknown) => (manifest as { harness: { skills: Record<string, Skill> } }).harness.skills;

describe("a skill only a person starts", () => {
  it("is carried as disableModelInvocation: true, and only when true", () => {
    const result = compile({
      ...BASE,
      "skills/review/SKILL.md": md("name: review\ndescription: Review.\ndisable-model-invocation: true\n", "Review.\n"),
      "skills/notes/SKILL.md": md("name: notes\ndescription: Notes.\ndisable-model-invocation: false\n", "Notes.\n"),
    });
    expect(errors(result.diagnostics)).toEqual([]);
    expect(skillsOf(result.manifest).review!.disableModelInvocation).toBe(true);
    expect(skillsOf(result.manifest).notes).not.toHaveProperty("disableModelInvocation");
    expect(AgentManifestV8Schema.safeParse(result.manifest).success).toBe(true);
  });

  it("refuses a value that isn't true or false", () => {
    const result = compile({ ...BASE, "skills/review/SKILL.md": md("name: review\ndescription: Review.\ndisable-model-invocation: yes please\n", "Review.\n") });
    expect(errors(result.diagnostics)).toEqual([expect.objectContaining({ code: "skill_invalid", file: "skills/review/SKILL.md" })]);
  });

  it("is how EGM publishes all eight of its skills", () => {
    const root = fileURLToPath(new URL("./support/egm-plugin/", import.meta.url));
    const files: Record<string, Uint8Array> = {};
    const walk = (dir: string, rel: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path, `${rel}${name}/`);
        else files[`plugins/egm/${rel}${name}`] = readFileSync(path);
      }
    };
    walk(root, "");
    const result = compile({ ...BASE, ...files });
    expect(errors(result.diagnostics)).toEqual([]);
    const egm = Object.entries(skillsOf(result.manifest)).filter(([name]) => name.startsWith("egm-"));
    expect(egm).toHaveLength(8);
    expect(egm.every(([, skill]) => skill.disableModelInvocation === true)).toBe(true);
  });

  it("is named by a message's skill", () => {
    const command = { type: "message", requestId: "r1", idempotencyKey: "k1", content: "Review it.", skill: "egm-review" };
    expect(SessionCommandSchema.parse(command)).toMatchObject({ skill: "egm-review" });
    expect(() => SessionCommandSchema.parse({ ...command, skill: "" })).toThrow();
  });
});
