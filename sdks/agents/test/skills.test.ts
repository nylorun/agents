import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/builder.js";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import { expect, it } from "vitest";
import { AgentsClient } from "../src/client.js";
import { loadSkillsFromDirectory, SkillsError } from "../src/skills/index.js";
import { skills } from "../src/skills/skills.js";

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
  expect(declaration.id).toBe(`skills:${realpathSync(root).split(/[/\\]/).pop()}`);
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
  // The Runtime adds the skill catalog; the part has no instructions of its own.
  expect(declaration.instructions).toBeUndefined();

  const agent = Agent({
    id: "assistant",
    name: "Order assistant",
    instructions: "Use lookup_order for orders.",
  })
    .skills(root)
    .build();

  expect(agent.manifest.skills?.triage?.files).toEqual(declaration.skills?.triage?.files);
  expect(agent.manifest.skills?.triage).not.toHaveProperty("plugin");
  expect(JSON.stringify(agent.manifest)).not.toContain("Body stays stored.");
  expect(JSON.stringify(agent.manifest)).not.toContain("# Labels");
  // The harness adds the skill tools and the catalog when it runs a turn (protocol 15).
  expect(agent.manifest.tools ?? []).toEqual([]);
  expect(agent.manifest.skills?.triage).toMatchObject({ name: "triage", description: expect.any(String) });
  expect(Object.keys(agent.manifest.skills!.triage!.files)).toContain("references/labels.md");
});

it("uploads the skill files the Runtime lacks, binary included, before saving the agent", async () => {
  const root = catalog();
  const skillMd = "---\nname: triage\ndescription: Triage an issue.\n---\nOk.\n";
  const logo = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
  write(root, "triage/SKILL.md", skillMd);
  write(root, "triage/assets/logo.png", logo);
  const agent = Agent({ id: "assistant", instructions: "Help." }).skills(root).build();
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
      if (path === "/v1/agent-manifests/assistant" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        for (const hash of Object.values(body.harness.skills.triage.files))
          expect(held.has(hash as string)).toBe(true);
        return Response.json({ manifest: { name: "assistant", version: 1 }, unchanged: false, warnings: [] });
      }
      throw new Error(`unexpected ${init?.method} ${path}`);
    },
  });
  await client.agentManifests.save({ agent, runtime: { kind: "virtual" } });
  expect(held.get(sha256(logo))).toEqual(logo);
  expect(calls.filter((call) => call.startsWith("PUT"))).toEqual([
    `PUT /v1/files/${sha256(logo)}`,
    "PUT /v1/agent-manifests/assistant",
  ]);
  expect(calls.filter((call) => call.startsWith("HEAD"))).toHaveLength(2);
});

it("holds a file over 10 MiB and more than 500 files", async () => {
  const root = catalog();
  write(root, "big/SKILL.md", "---\nname: big\ndescription: Big.\n---\nOk.\n");
  const data = new Uint8Array(10 * 1024 * 1024 + 1).fill(3);
  write(root, "big/data.bin", data);
  for (let index = 0; index < 501; index += 1) write(root, `big/notes/${index}.md`, `# ${index}\n`);
  const declaration = skills(root);
  const files = declaration.skills!.big!.files;
  expect(Object.keys(files)).toHaveLength(503);
  expect(files["data.bin"]).toBe(sha256(data));
  const source = declaration.skillFiles![sha256(data)]!;
  expect(source.size).toBe(data.byteLength);
  expect(sha256(await source.read())).toBe(sha256(data));
});

it("omits tools when the catalog is empty", () => {
  const root = catalog();
  const declaration = skills(root);
  expect(declaration).toMatchObject({ root: realpathSync(root) });
  expect(declaration.skills).toBeUndefined();
  expect(declaration.skillFiles).toBeUndefined();
  expect(declaration.instructions).toBeUndefined();

  const agent = Agent({ id: "assistant", instructions: "Help." })
    .skills(root)
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

it("reads the secret slots a skill's scripts read from its SKILL.md's frontmatter secrets", () => {
  const root = catalog();
  write(
    root,
    "open-pr/SKILL.md",
    "---\nname: open-pr\ndescription: Open a pull request.\nsecrets: [GH_TOKEN, GH_HOST, GH_TOKEN]\n---\nRun gh.\n"
  );
  write(root, "triage/SKILL.md", "---\nname: triage\ndescription: Triage an issue.\n---\nOk.\n");
  write(root, "bad/SKILL.md", "---\nname: bad\ndescription: Bad secrets.\nsecrets: gh-token\n---\nNo.\n");
  const diagnostics: { code: string; message: string }[] = [];
  const loaded = loadSkillsFromDirectory(root, diagnostics as never);
  expect(loaded["open-pr"]!.secrets).toEqual(["GH_HOST", "GH_TOKEN"]);
  expect(loaded.triage).not.toHaveProperty("secrets");
  expect(loaded.bad).toBeUndefined();
  expect(diagnostics.map((item) => item.message)).toEqual([
    "Skipped skill 'bad' because SKILL.md has secrets that are not a list of environment variable names",
  ]);
  const part = skills(root);
  expect(part.skillSecrets).toEqual({ "open-pr": ["GH_HOST", "GH_TOKEN"] });
  // The v7 manifest's skills stay as they were: secrets belong to the harness section.
  expect(part.skills!["open-pr"]).not.toHaveProperty("secrets");
});
