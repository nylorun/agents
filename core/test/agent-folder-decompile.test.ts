import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { AgentManifestV8Schema, type AgentManifestV8 } from "../src/contracts.js";
import { hashManifest } from "../src/utils/hash.js";
import { compileAgentFolder, folderOfManifest, folderTextPaths, type AgentFolderEntry } from "../src/folder/index.js";

const encoder = new TextEncoder();
const hashOf = (content: string | Uint8Array) => `sha256:${bytesToHex(sha256(typeof content === "string" ? encoder.encode(content) : content))}`;

/** Compiles a folder of text or bytes, as the Runtime and the CLI hand it to the compiler. */
function compile(files: ReadonlyMap<string, string | Uint8Array>, name?: string) {
  const entries: AgentFolderEntry[] = [];
  const bytes = new Map<string, Uint8Array>();
  for (const [path, content] of files) {
    const data = typeof content === "string" ? encoder.encode(content) : content;
    entries.push({ path, size: data.byteLength, sha256: bytesToHex(sha256(data)) });
    bytes.set(path, data);
  }
  return compileAgentFolder({ entries, files: new Map(folderTextPaths(entries).map((path) => [path, bytes.get(path)!])), ...(name ? { name } : {}) });
}

const manifestHash = (manifest: AgentManifestV8) => hashManifest(manifest as never);

/** The folder of `manifest`, compiled back: it must give the same manifest hash, with no notes. */
function roundTrip(input: AgentManifestV8) {
  const manifest = AgentManifestV8Schema.parse(input);
  const folder = folderOfManifest(manifest);
  const compiled = compile(folder.files, manifest.name);
  expect(compiled.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  expect(folder.notes).toEqual([]);
  expect(folder.exact).toBe(true);
  expect(compiled.manifest).toEqual(manifest);
  expect(manifestHash(compiled.manifest!)).toBe(manifestHash(manifest));
  return folder;
}

const text = (folder: { files: ReadonlyMap<string, string | Uint8Array> }, path: string) => {
  const content = folder.files.get(path);
  return typeof content === "string" ? content : new TextDecoder().decode(content);
};

const TRIAGE: AgentManifestV8 = {
  manifestSchemaVersion: 8,
  name: "triage",
  description: "Reads a GitHub issue and proposes a label and a priority.",
  harness: {
    instructions: [
      "Triage the GitHub issue the user names as owner/repo#number. Read it, and its comments,\nwith the github tools.\n\nAnswer with one label (bug, feature, question or docs), a priority from p0 (urgent) to\np3, and one sentence on why. Change nothing on GitHub.",
    ],
    mcpServers: {
      github: {
        name: "github",
        type: "streamable-http",
        url: "https://api.githubcopilot.com/mcp/",
        headers: { "X-MCP-Toolsets": "issues", "X-MCP-Readonly": "true" },
        credential: "GITHUB_TOKEN",
      },
    },
  },
  runtime: {
    kind: "virtual",
    network: { allowedHosts: [] },
    secrets: {
      GITHUB_TOKEN: {
        type: "bearer",
        url: "https://api.githubcopilot.com/mcp/",
        description: "A GitHub token that may read issues, for GitHub's MCP server",
      },
    },
  },
};

describe("folderOfManifest: the folder compiles back to the same manifest", () => {
  it("writes T6's triage as AGENT.md, mcp.json with Bearer ${GITHUB_TOKEN}, and runtime.json", () => {
    const folder = roundTrip(TRIAGE);
    expect([...folder.files.keys()]).toEqual(["AGENT.md", "mcp.json", "runtime.json"]);
    expect(text(folder, "AGENT.md")).toBe(
      `---\nname: triage\ndescription: Reads a GitHub issue and proposes a label and a priority.\n---\n${TRIAGE.harness.instructions![0]}\n`,
    );
    expect(JSON.parse(text(folder, "mcp.json"))).toEqual({
      mcpServers: {
        github: {
          type: "streamable-http",
          url: "https://api.githubcopilot.com/mcp/",
          headers: { "X-MCP-Toolsets": "issues", "X-MCP-Readonly": "true", Authorization: "Bearer ${GITHUB_TOKEN}" },
        },
      },
    });
    // The slot has a description the compiler would not derive, so runtime.json keeps it.
    expect(JSON.parse(text(folder, "runtime.json"))).toEqual(TRIAGE.runtime);
  });

  it("leaves out a slot the compiler derives identically, and runtime.json with it when nothing else is left", () => {
    const manifest: AgentManifestV8 = {
      ...TRIAGE,
      runtime: { kind: "none", secrets: { GITHUB_TOKEN: { type: "bearer", url: "https://api.githubcopilot.com/mcp/", required: true } } },
    };
    const folder = roundTrip(manifest);
    expect([...folder.files.keys()]).toEqual(["AGENT.md", "mcp.json"]);
  });

  it("writes a headers slot as ${NAME} in the header its description names", () => {
    const folder = roundTrip({
      manifestSchemaVersion: 8,
      name: "acme",
      description: "Uses Acme.",
      harness: {
        mcpServers: { acme: { name: "acme", type: "sse", url: "https://mcp.acme.test/sse", credential: "ACME_KEY", deferred: true, tools: { "*": { enabled: false } } } },
      },
      runtime: {
        kind: "none",
        secrets: { ACME_KEY: { type: "headers", url: "https://mcp.acme.test/sse", required: true, description: "Sets the X-Acme-Key header" } },
      },
    });
    expect(JSON.parse(text(folder, "mcp.json")).mcpServers.acme.headers).toEqual({ "X-Acme-Key": "${ACME_KEY}" });
    expect(folder.files.has("runtime.json")).toBe(false);
    expect(text(folder, "AGENT.md")).toContain("mcpServers:\n  acme:\n    deferred: true\n");
  });

  it("writes HTTP tools as tools/<name>.json, keeping a declared slot and dropping a derived one", () => {
    const folder = roundTrip({
      manifestSchemaVersion: 8,
      name: "shop",
      description: "Looks up orders and refunds them.",
      harness: {
        instructions: ["Look the order up before you refund it."],
        tools: [
          {
            name: "get_order",
            description: "One order.",
            inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
            outputSchema: { type: "object" },
            http: { url: "https://shop.example.com/orders/{id}", method: "GET", credential: "SHOP_READ" },
          },
          {
            name: "refund",
            inputSchema: { type: "object", properties: { order: { type: "string" } } },
            http: { url: "https://shop.example.com/refunds", method: "POST", credential: "SHOP_WRITE", timeoutMs: 5000 },
          },
        ],
      },
      runtime: {
        kind: "none",
        secrets: {
          SHOP_READ: { type: "bearer", url: "https://shop.example.com/orders/{id}", required: true },
          SHOP_WRITE: { type: "bearer", url: "https://shop.example.com/refunds", required: false, description: "A refunds key" },
        },
      },
    });
    expect([...folder.files.keys()]).toEqual(["AGENT.md", "runtime.json", "tools/get_order.json", "tools/refund.json"]);
    expect(JSON.parse(text(folder, "runtime.json"))).toEqual({
      kind: "none",
      secrets: { SHOP_WRITE: { type: "bearer", url: "https://shop.example.com/refunds", required: false, description: "A refunds key" } },
    });
    expect(JSON.parse(text(folder, "tools/refund.json"))).not.toHaveProperty("name");
  });

  it("writes triggers as triggers/<id>.md, and keeps one whose prompt Markdown would change in runtime.json", () => {
    const folder = roundTrip({
      manifestSchemaVersion: 8,
      name: "nightly",
      description: "Writes the nightly brief.",
      harness: { instructions: ["Write the brief."] },
      runtime: {
        kind: "virtual",
        triggers: {
          nightly: { schedule: "0 2 * * *", timezone: "Asia/Kolkata", session: "new", prompt: "Write the nightly brief.\n\nKeep it short." },
          often: { schedule: "* * * * *", session: "main", prompt: "Check." },
          launch: { at: "2026-11-01T09:00:00+05:30", session: "new", prompt: "Launch day." },
          hook: { webhook: "standard-webhooks", session: "new", prompt: "A delivery came." },
          padded: { schedule: "0 3 * * *", session: "new", prompt: "\nPadded.\n" },
        },
      },
    });
    expect([...folder.files.keys()].filter((path) => path.startsWith("triggers/"))).toEqual([
      "triggers/hook.md",
      "triggers/launch.md",
      "triggers/nightly.md",
      "triggers/often.md",
    ]);
    expect(text(folder, "triggers/often.md")).toBe('---\nschedule: "* * * * *"\nsession: main\n---\nCheck.\n');
    expect(JSON.parse(text(folder, "runtime.json"))).toEqual({
      kind: "virtual",
      triggers: { padded: { schedule: "0 3 * * *", session: "new", prompt: "\nPadded.\n" } },
    });
  });

  it("needs no runtime.json for kind none when triggers make the section", () => {
    const folder = roundTrip({
      manifestSchemaVersion: 8,
      name: "pinger",
      description: "Pings.",
      harness: {},
      runtime: { kind: "none", triggers: { hourly: { schedule: "0 * * * *", session: "new", prompt: "Ping." } } },
    });
    expect([...folder.files.keys()]).toEqual(["AGENT.md", "triggers/hourly.md"]);
  });

  it("writes runtime.json for each kind, with files by hash and an explicit kind none", () => {
    roundTrip({ manifestSchemaVersion: 8, name: "bare", description: "Bare.", harness: {}, runtime: { kind: "none" } });
    const pod = roundTrip({
      manifestSchemaVersion: 8,
      name: "builder",
      description: "Builds.",
      harness: { id: "nylorun", instructions: ["Build it."] },
      runtime: {
        kind: "pod",
        image: "node:24",
        resources: { cpus: 2, memory: "2GiB" },
        storage: "10GiB",
        network: { allowedHosts: ["registry.npmjs.org"] },
        setup: [{ command: "npm ci" }],
        files: [{ path: "/workspace/kit", files: { "run.sh": hashOf("echo kit\n") } }],
        secrets: { NPM_TOKEN: { type: "environment_secret", allowedHosts: ["registry.npmjs.org"] } },
        selfWake: true,
      },
    } as AgentManifestV8);
    expect(JSON.parse(text(pod, "runtime.json")).files).toEqual([{ path: "/workspace/kit", files: { "run.sh": hashOf("echo kit\n") } }]);
    expect(text(pod, "AGENT.md")).toContain("\nharness: nylorun\n");
  });

  it("writes outputSchema, memory, loop, metadata and the harness id in AGENT.md, with YAML that reads back", () => {
    const folder = roundTrip({
      manifestSchemaVersion: 8,
      name: "writer.v2",
      description: "yes: it writes\n  and checks the brief",
      metadata: { team: "docs", tier: 1, flags: { beta: true, owners: ["*", "&a", "null"] }, empty: null, version: "1.0" },
      harness: {
        id: "nylorun",
        outputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
        memory: { access: "read_only", instructions: "Remember the house style." },
        loop: { maxTurns: 8, model: "fast" },
        instructions: ["# Writer\n\nWrite the brief."],
      },
    });
    expect(text(folder, "AGENT.md")).toContain("outputSchema: ./output.schema.json\n");
    expect(JSON.parse(text(folder, "output.schema.json"))).toEqual({ type: "object", properties: { title: { type: "string" } }, required: ["title"] });
  });

  it("writes each instruction after the first as instructions/NN-<slug>.md, padded so path order is natural order", () => {
    const instructions = Array.from({ length: 12 }, (_, index) => `## Rule ${index}\n\nFollow rule ${index}.`);
    const folder = roundTrip({ manifestSchemaVersion: 8, name: "rules", description: "Follows rules.", harness: { instructions } });
    expect([...folder.files.keys()].filter((path) => path.startsWith("instructions/"))).toEqual(
      Array.from({ length: 11 }, (_, index) => `instructions/${String(index + 1).padStart(2, "0")}-rule-${index + 1}.md`),
    );
  });

  it("writes skills from their bytes, and moves a SKILL.md's secrets to AGENT.md (the hash changes, said in a note)", () => {
    const skill = "---\nname: repo-brief\ndescription: Write a repo brief.\n---\nWrite it.\n";
    const script = new Uint8Array([35, 33, 47, 98, 105, 110, 47, 115, 104, 10, 0, 255]);
    const manifest: AgentManifestV8 = {
      manifestSchemaVersion: 8,
      name: "writer",
      description: "Writes the brief.",
      harness: {
        skills: {
          "repo-brief": {
            name: "repo-brief",
            description: "Write a repo brief.",
            files: { "SKILL.md": hashOf(skill), "scripts/check.sh": hashOf(script) },
            secrets: ["PUBLISH_TOKEN"],
          },
        },
      },
      runtime: { kind: "virtual", secrets: { PUBLISH_TOKEN: { type: "environment_secret", allowedHosts: ["publish.example.com"] } } },
    };
    const bytes = new Map([
      [hashOf(skill), encoder.encode(skill)],
      [hashOf(script), script],
    ]);
    const folder = folderOfManifest(manifest, { files: bytes });
    expect(folder.notes).toEqual([]);
    expect(folder.exact).toBe(true);
    expect(folder.files.get("skills/repo-brief/scripts/check.sh")).toBe(script);
    expect(text(folder, "AGENT.md")).toContain("skills:\n  repo-brief:\n    secrets:\n      - PUBLISH_TOKEN\n");
    expect(compile(folder.files).manifest).toEqual(manifest);

    // The TypeScript loader read secrets from SKILL.md: the folder keeps them in AGENT.md instead.
    const old = "---\nname: repo-brief\ndescription: Write a repo brief.\nsecrets: [PUBLISH_TOKEN]\n---\nWrite it.\n";
    const legacy = structuredClone(manifest);
    (legacy.harness as { skills: Record<string, { files: Record<string, string> }> }).skills["repo-brief"]!.files["SKILL.md"] = hashOf(old);
    const migrated = folderOfManifest(legacy, { files: new Map([...bytes, [hashOf(old), encoder.encode(old)]]) });
    expect(text(migrated, "skills/repo-brief/SKILL.md")).toBe(skill);
    expect(migrated.notes).toEqual([expect.stringContaining("secrets moved to AGENT.md's skills block")]);
    expect(migrated.exact).toBe(false);
    expect(compile(migrated.files).manifest).toEqual(manifest);
  });

  it("writes a placeholder SKILL.md, and a note naming each file to copy in, when it has hashes only", () => {
    const manifest: AgentManifestV8 = {
      manifestSchemaVersion: 8,
      name: "writer",
      description: "Writes.",
      harness: { skills: { pub: { name: "pub", description: "Publish.", files: { "SKILL.md": hashOf("x"), "run.sh": hashOf("y") } } } },
      runtime: { kind: "virtual" },
    };
    const folder = folderOfManifest(manifest);
    expect(folder.exact).toBe(false);
    expect(folder.notes).toEqual([expect.stringMatching(/^Skill pub: .*copy the skill's folder into skills\/pub\/\. Missing: SKILL\.md \(sha256:[0-9a-f]{64}\), run\.sh/)]);
    expect(text(folder, "skills/pub/SKILL.md")).toMatch(/^---\nname: pub\ndescription: Publish\.\n---\nA placeholder/);
    expect(compile(folder.files).manifest).toBeDefined();
  });

  it("seeds files/ from a last /workspace entry when it has the bytes", () => {
    const csv = "a,b\n1,2\n";
    const folder = roundTrip({
      manifestSchemaVersion: 8,
      name: "data",
      description: "Reads data.",
      harness: {},
      runtime: { kind: "pod", files: [{ path: "/workspace", files: { "data/a.csv": hashOf(csv) } }] },
    });
    expect(folder.files.has("runtime.json")).toBe(true);
    const seeded = folderOfManifest(
      { manifestSchemaVersion: 8, name: "data", description: "Reads data.", harness: {}, runtime: { kind: "pod", files: [{ path: "/workspace", files: { "data/a.csv": hashOf(csv) } }] } },
      { files: new Map([[hashOf(csv), encoder.encode(csv)]]) },
    );
    expect([...seeded.files.keys()].sort()).toEqual(["AGENT.md", "files/data/a.csv", "runtime.json"]);
    expect(seeded.exact).toBe(true);
  });
});

describe("folderOfManifest: what it cannot write the same way, in notes", () => {
  it("leaves a tool's approval out, naming the Tenant's tool policy", () => {
    const folder = folderOfManifest({
      manifestSchemaVersion: 8,
      name: "shop",
      description: "Refunds.",
      harness: {
        tools: [
          {
            name: "refund",
            inputSchema: { type: "object" },
            http: { url: "https://shop.example.com/refunds", method: "POST" },
            approval: "always",
          },
        ],
      },
    } as AgentManifestV8);
    expect(folder.notes).toEqual([expect.stringContaining("Tool refund has approval \"always\"")]);
    expect(folder.exact).toBe(false);
    expect(compile(folder.files).diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  });

  it("writes no files for a flow, and says flows come with the compiler", () => {
    const folder = folderOfManifest({
      manifestSchemaVersion: 8,
      name: "brief",
      description: "A flow.",
      harness: { kind: "workflow", root: { agent: "a" }, agents: { a: { manifestSchemaVersion: 7, id: "a", instructions: ["Go."] } } },
    } as AgentManifestV8);
    expect(folder.files.size).toBe(0);
    expect(folder.exact).toBe(false);
    expect(folder.notes).toEqual([expect.stringContaining("flows are exported once the compiler supports them")]);
  });

  it("names each normalization: tool order, blank instructions, a missing description, a subagent tool", () => {
    const folder = folderOfManifest({
      manifestSchemaVersion: 8,
      name: "messy",
      harness: {
        instructions: ["\nFirst.\n", "   ", "Second.\r\nLine."],
        tools: [
          { name: "zeta", inputSchema: { type: "object" }, http: { url: "https://z.example.com/" } },
          { name: "alpha", inputSchema: { type: "object" }, http: { url: "https://a.example.com/" } },
          { name: "helper", inputSchema: { type: "object" }, agent: { manifestSchemaVersion: 7, id: "helper", instructions: ["Help."] } },
        ],
      },
    } as AgentManifestV8);
    expect(folder.exact).toBe(false);
    expect(folder.notes).toEqual([
      "The manifest has no description, which AGENT.md needs: write one there (a placeholder stands in).",
      expect.stringContaining("Tool helper is a subagent"),
      "harness.tools are listed in file name order (alpha, zeta), as tools/ gives them.",
      "Instruction 1 loses its leading and trailing blank lines, as Markdown files are read.",
      "Instruction 2 is blank, and a blank file gives no instruction: it is left out.",
      "Instruction 3 loses its leading and trailing blank lines and its CRLF line ends, as Markdown files are read.",
    ]);
    const compiled = compile(folder.files).manifest!;
    expect(compiled.harness).toMatchObject({ instructions: ["First.", "Second.\nLine."] });
    expect((compiled.harness as { tools: { name: string }[] }).tools.map((tool) => tool.name)).toEqual(["alpha", "zeta"]);
  });
});
