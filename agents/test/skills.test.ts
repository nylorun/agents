import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@nylorun/core/define";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import { expect, it } from "vitest";
import { AgentsClient } from "../src/client.js";
import {
  loadSkillsFromDirectory,
  skills,
  SkillsError,
} from "../src/skills/index.js";

function catalog(): string {
  return mkdtempSync(join(tmpdir(), "nylorun-skills-"));
}

function write(directory: string, path: string, contents: string | Uint8Array): void {
  const file = join(directory, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, contents);
}

const sha256 = (contents: string | Uint8Array) =>
  `sha256:${createHash("sha256").update(contents).digest("hex")}`;

it("loads an agentskills.io catalog as files named by hash, binary included, without .env files", async () => {
  const root = catalog();
  const skillMd =
    "---\nname: triage\ndescription: Triage an issue. Use when labeling.\n---\nBody stays stored.\n";
  const logo = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
  write(root, "triage/SKILL.md", skillMd);
  write(root, "triage/references/labels.md", "# Labels\n");
  write(root, "triage/assets/logo.png", logo);
  write(root, "triage/.DS_Store", "junk");
  write(root, "triage/.env", "SECRET=1");
  write(root, "triage/scripts/.env.local", "SECRET=2");
  write(root, "triage/.prettierrc", "{}");
  write(root, "triage/.git/HEAD", "ref: main");

  const declaration = skills(root);
  expect(declaration.id).toBe(realpathSync(root).split(/[/\\]/).pop());
  expect(declaration.skills?.triage).toEqual({
    name: "triage",
    description: "Triage an issue. Use when labeling.",
    files: {
      ".prettierrc": sha256("{}"),
      "SKILL.md": sha256(skillMd),
      "assets/logo.png": sha256(logo),
      "references/labels.md": sha256("# Labels\n"),
    },
  });
  // Other dotfiles are part of the skill; environment files never are.
  expect(Object.keys(declaration.skillFiles ?? {}).sort()).toEqual(
    [sha256("{}"), sha256(skillMd), sha256(logo), sha256("# Labels\n")].sort()
  );
  const source = declaration.skillFiles![sha256(logo)]!;
  expect(source.size).toBe(logo.length);
  expect(await source.read()).toEqual(logo);
  expect(declaration.instructions?.join("\n")).toContain("<name>triage</name>");
  expect(declaration.instructions?.join("\n")).not.toContain("Body stays stored.");

  const agent = Agent({
    id: "assistant",
    name: "Order assistant",
    instructions: "Use lookup_order for orders.",
  })
    .use(skills(root))
    .build();

  const capability = agent.manifest.capabilities.find(
    (item) => item.id === declaration.id
  );
  expect(capability?.skills?.triage?.files).toEqual(declaration.skills?.triage?.files);
  expect(capability?.tools?.map((item) => item.name)).toEqual(["load_skill", "read_skill_resource"]);
  expect(JSON.stringify(agent.manifest)).not.toContain("Body stays stored.");
  expect(JSON.stringify(agent.manifest)).not.toContain("# Labels");
  // The Runtime serves the skill tools; in this process they only say so.
  const load = agent.getBinding().tools.find((item) => item.name === "load_skill");
  await expect(load!.execute({ name: "triage" }, {} as never)).rejects.toThrow(
    "Skills are served by the Nylorun Runtime"
  );
});

it("uploads the skill files the Runtime lacks, binary included, before saving the agent", async () => {
  const root = catalog();
  const skillMd = "---\nname: triage\ndescription: Triage an issue.\n---\nOk.\n";
  const logo = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
  write(root, "triage/SKILL.md", skillMd);
  write(root, "triage/assets/logo.png", logo);
  const agent = Agent({ id: "assistant", instructions: "Help." }).use(skills(root)).build();
  // The Runtime holds SKILL.md already, not the logo.
  const held = new Map<string, Uint8Array>([[sha256(skillMd), new TextEncoder().encode(skillMd)]]);
  const calls: string[] = [];
  const client = new AgentsClient({
    url: "http://127.0.0.1:8787",
    key: "a".repeat(64),
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/health")
        return Response.json({ status: "ok", protocol: { ...HOST_PROTOCOL } });
      calls.push(`${init?.method} ${path}`);
      const file = /^\/v1\/files\/(sha256:[0-9a-f]{64})$/.exec(path)?.[1];
      if (file && init?.method === "HEAD")
        return new Response(null, { status: held.has(file) ? 200 : 404 });
      if (file && init?.method === "PUT") {
        const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
        expect(new Headers(init.headers).get("content-type")).toBe("application/octet-stream");
        expect(sha256(bytes)).toBe(file);
        held.set(file, bytes);
        return Response.json({ sha256: file, size: bytes.length }, { status: 201 });
      }
      if (path === "/v1/agents/assistant" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        for (const hash of Object.values(body.manifest.capabilities[1].skills.triage.files))
          expect(held.has(hash as string)).toBe(true);
        return Response.json({ agentId: "assistant", manifestHash: "x", implementationVersion: "dev" });
      }
      throw new Error(`unexpected ${init?.method} ${path}`);
    },
  });
  await client.saveAgent(agent, { implementationVersion: "dev" });
  expect(held.get(sha256(logo))).toEqual(logo);
  expect(calls.filter((call) => call.startsWith("PUT"))).toEqual([
    `PUT /v1/files/${sha256(logo)}`,
    "PUT /v1/agents/assistant",
  ]);
  expect(calls.filter((call) => call.startsWith("HEAD"))).toHaveLength(2);
});

it("refuses a skill file over 10 MiB", () => {
  const root = catalog();
  write(root, "big/SKILL.md", "---\nname: big\ndescription: Big.\n---\nOk.\n");
  write(root, "big/data.bin", new Uint8Array(10 * 1024 * 1024 + 1));
  expect(() => skills(root)).toThrow("Skill 'big' file data.bin is 10485761 bytes");
});

it("accepts an explicit capability id and omits tools when the catalog is empty", () => {
  const root = catalog();
  const declaration = skills(root, { id: "assistant-skills" });
  expect(declaration).toMatchObject({
    id: "assistant-skills",
    root: realpathSync(root),
  });
  expect(declaration.skills).toBeUndefined();
  expect(declaration.skillFiles).toBeUndefined();
  expect(declaration.instructions).toBeUndefined();

  const agent = Agent({ id: "assistant", instructions: "Help." })
    .use(skills(root, { id: "assistant-skills" }))
    .build();
  expect(
    agent.getBinding().tools.some((tool) => tool.name === "load_skill")
  ).toBe(false);
});

it("throws when the catalog directory is missing", () => {
  expect(() => skills(join(tmpdir(), "missing-skills-catalog"))).toThrow(
    SkillsError
  );
  try {
    skills(join(tmpdir(), "missing-skills-catalog"));
  } catch (error) {
    expect(error).toBeInstanceOf(SkillsError);
    expect((error as SkillsError).code).toBe("skills.missing");
  }
});

it("skips invalid skills and keeps siblings", () => {
  const root = catalog();
  write(root, "broken/SKILL.md", "no frontmatter");
  write(
    root,
    "triage/SKILL.md",
    "---\nname: triage\ndescription: Triage an issue.\n---\nOk.\n"
  );
  const diagnostics: { code: string }[] = [];
  const loaded = loadSkillsFromDirectory(root, diagnostics as never);
  expect(Object.keys(loaded)).toEqual(["triage"]);
  expect(diagnostics.some((item) => item.code === "skills.skill-skipped")).toBe(
    true
  );
});

it("parses YAML frontmatter with gray-matter including quoted colons", () => {
  const root = catalog();
  write(
    root,
    "pdf-processing/SKILL.md",
    '---\nname: pdf-processing\ndescription: "Use this skill when: the user asks about PDFs"\nlicense: Apache-2.0\n---\nExtract text.\n'
  );
  write(
    root,
    "invalid-yaml/SKILL.md",
    "---\nname: invalid-yaml\ndescription: Use this skill when: unquoted colon breaks YAML\n---\nNope.\n"
  );
  const diagnostics: { code: string }[] = [];
  const loaded = loadSkillsFromDirectory(root, diagnostics as never);
  expect(loaded["pdf-processing"]).toMatchObject({
    name: "pdf-processing",
    description: "Use this skill when: the user asks about PDFs",
  });
  expect(loaded["invalid-yaml"]).toBeUndefined();
  expect(diagnostics.some((item) => item.code === "skills.skill-skipped")).toBe(
    true
  );
});
