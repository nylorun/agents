import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkFolder, composeManifest, packFolder } from "@nylorun/agents";
import { PROTOCOL_FEATURES, PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import type { AgentManifestV8 } from "@nylorun/core/contracts";
import { exportCommand, pullCommand } from "../../src/client/convert.js";
import { migrateCommand } from "../../src/client/migrate.js";
import { fakeFetch, json, temporaryDir, temporaryHome, testDeps } from "../stack/support.js";

const URL_ = "http://runtime.test";
const KEY = "ab".repeat(32);
const hex = (content: string | Uint8Array) => createHash("sha256").update(content).digest("hex");

type Handler = (method: string, path: string, init?: RequestInit) => Response | undefined;

/** Deps on a remote installation answering `handle`, working in `cwd`. */
async function remote(cwd: string, handle: Handler = () => undefined) {
  const fetch = fakeFetch((url, init) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/health")
      return json({ status: "ok", protocol: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION, features: [...PROTOCOL_FEATURES] } });
    return handle(init?.method ?? "GET", `${parsed.pathname}${parsed.search}`, init);
  });
  const deps = testDeps(await temporaryHome(), { fetch, cwd });
  return Object.assign(deps, { env: { ...deps.env, NYLORUN_RUNTIME_URL: URL_, NYLORUN_SERVER_KEY: KEY }, fetch });
}

async function write(root: string, files: Record<string, string | object>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
}

/** The manifest the folder at `dir` compiles to, offline. */
async function compiled(dir: string): Promise<AgentManifestV8 | undefined> {
  return (await checkFolder(await packFolder(dir))).manifest;
}

const calls = (deps: Awaited<ReturnType<typeof remote>>) =>
  deps.fetch.requests
    .filter((request) => !request.url.endsWith("/health"))
    .map((request) => `${request.init?.method ?? "GET"} ${request.url.slice(URL_.length)}`);

/** Triage as T6's TypeScript saved it: two instructions, a server with a credential, a pod-less runtime. */
const TRIAGE: AgentManifestV8 = {
  manifestSchemaVersion: 8,
  name: "triage",
  description: "Reads a GitHub issue and proposes a label and a priority.",
  harness: {
    instructions: [
      "Triage the GitHub issue the user names as owner/repo#number. Read it, and its comments, with the github tools.",
      "Answer with one label (bug, feature, question or docs), a priority from p0 (urgent) to p3, and one sentence on why. Change nothing on GitHub.",
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
    secrets: { GITHUB_TOKEN: { type: "bearer", url: "https://api.githubcopilot.com/mcp/", description: "A GitHub token that may read issues" } },
  },
};

const view = (manifest: AgentManifestV8, version = 1, source?: object) => ({
  name: manifest.name,
  version,
  hash: "h",
  manifest,
  savedBy: { actor: "key:app" },
  createdAt: "2026-10-20T00:00:00Z",
  agents: 0,
  ...(source ? { source } : {}),
});

describe("nylorun export --folder", () => {
  it("writes the folder of a manifest saved as JSON, which compiles back to it, and writes over nothing", async () => {
    const dir = await temporaryDir();
    const deps = await remote(dir, (method, path) =>
      method === "GET" && path === "/v1/agent-manifests/triage" ? json(view(TRIAGE, 4)) : undefined,
    );
    expect(await exportCommand(deps, ["--folder", "triage"])).toBe(0);
    expect(deps.lines).toEqual(["Wrote 4 files to triage."]);
    expect(deps.errors).toEqual(["It compiles back to the same manifest. Check it with nylorun check triage, and save it with nylorun apply triage."]);
    expect(await readFile(join(dir, "triage", "instructions", "01-answer-with-one-label-bug.md"), "utf8")).toBe(`${TRIAGE.harness.instructions![1]}\n`);
    expect(await compiled(join(dir, "triage"))).toEqual(TRIAGE);

    // Again: every file is there with the same bytes, so nothing is written.
    expect(await exportCommand(deps, ["triage", "--folder"])).toBe(0);
    expect(deps.lines.at(-1)).toBe("Wrote 0 files to triage (4 files already there, the same).");

    // A file with other bytes is a conflict: nothing is written.
    await writeFile(join(dir, "triage", "AGENT.md"), "edited\n");
    await expect(exportCommand(deps, ["--folder", "triage"])).rejects.toMatchObject({ exitCode: 1, message: expect.stringContaining("triage/AGENT.md exists with other bytes") });
    expect(await readFile(join(dir, "triage", "AGENT.md"), "utf8")).toBe("edited\n");
    expect(calls(deps)).toEqual(["GET /v1/agent-manifests/triage", "GET /v1/agent-manifests/triage", "GET /v1/agent-manifests/triage"]);
  });

  it("reads one version into --out, says when it was saved from a folder, and notes what differs", async () => {
    const dir = await temporaryDir();
    const shop: AgentManifestV8 = {
      manifestSchemaVersion: 8,
      name: "shop",
      description: "Orders.",
      harness: {
        tools: [
          { name: "zeta", inputSchema: { type: "object" }, http: { url: "https://z.example.com/" } },
          { name: "alpha", inputSchema: { type: "object" }, http: { url: "https://a.example.com/" } },
        ],
      },
    };
    const deps = await remote(dir, (method, path) =>
      path === "/v1/agent-manifests/shop/versions/2" ? json(view(shop, 2, { compiler: "agent-folder/1", files: 3, bytes: 90 })) : undefined,
    );
    expect(await exportCommand(deps, ["--folder", "shop@2", "--out", "out/shop"])).toBe(0);
    expect(deps.lines).toEqual(["Wrote 3 files to out/shop."]);
    expect(deps.errors).toEqual([
      "shop@2 was saved from a folder: nylorun pull shop@2 writes it as it was saved.",
      "  note: harness.tools are listed in file name order (alpha, zeta), as tools/ gives them.",
      "It compiles to a different manifest: see the notes, then check it with nylorun check out/shop.",
    ]);
    expect(existsSync(join(dir, "out", "shop", "tools", "alpha.json"))).toBe(true);
  });

  it("refuses a flow, which the compiler does not take yet, and a call without --folder", async () => {
    const dir = await temporaryDir();
    const flow = {
      manifestSchemaVersion: 8,
      name: "brief",
      description: "A flow.",
      harness: { kind: "workflow", root: { agent: "a" }, agents: { a: { manifestSchemaVersion: 7, id: "a", instructions: ["Go."] } } },
    } as AgentManifestV8;
    const deps = await remote(dir, (_, path) => (path === "/v1/agent-manifests/brief" ? json(view(flow)) : undefined));
    await expect(exportCommand(deps, ["--folder", "brief"])).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining("flows are exported once the compiler supports them"),
    });
    expect(existsSync(join(dir, "brief"))).toBe(false);
    await expect(exportCommand(deps, ["brief"])).rejects.toMatchObject({ exitCode: 2 });
    await expect(exportCommand(deps, ["--folder", "brief@x"])).rejects.toMatchObject({ exitCode: 2 });
  });
});

const SKILL = "---\nname: labels\ndescription: Pick a label.\n---\nUse the house labels.\n";

/** A three-file folder, as `nylorun apply` composes it. */
async function threeFile(root: string, skill = SKILL): Promise<string> {
  await write(root, {
    "agents/support/agent.manifest.json": {
      manifestSchemaVersion: 8,
      name: "support",
      description: "Answers billing questions.",
      harness: "./harness.manifest.json",
      runtime: "./runtime.manifest.json",
    },
    "agents/support/harness.manifest.json": {
      instructions: ["Answer questions about invoices.", "Be brief."],
      tools: [{ name: "lookup", inputSchema: { type: "object" }, http: { url: "https://billing.example.com/lookup", method: "POST" } }],
      skills: "./skills",
      mcpServers: "./mcp.json",
      credentials: { lookup: "BILLING", billing: "BILLING_MCP" },
    },
    "agents/support/mcp.json": { $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: { billing: { type: "sse", url: "https://mcp.billing.example.com/sse" } } },
    "agents/support/skills/labels/SKILL.md": skill,
    "agents/support/skills/labels/labels.txt": "bug\nfeature\n",
    "agents/support/runtime.manifest.json": {
      kind: "virtual",
      secrets: {
        BILLING: { type: "bearer", url: "https://billing.example.com/lookup", required: true },
        BILLING_MCP: { type: "bearer", url: "https://mcp.billing.example.com/sse", description: "The billing MCP key" },
        LABELS_TOKEN: { type: "environment_secret", allowedHosts: ["labels.example.com"] },
      },
    },
  });
  return join(root, "agents", "support");
}

describe("nylorun migrate folder", () => {
  it("writes the agent folder of a three-file folder, offline, compiling to the manifest apply composes", async () => {
    const dir = await temporaryDir();
    const source = await threeFile(dir);
    const deps = await remote(dir);
    expect(await migrateCommand(deps, ["folder", "agents/support", "--out", "folders/support"])).toBe(0);
    expect(deps.lines).toEqual(["Wrote 7 files to folders/support."]);
    expect(deps.errors).toEqual([
      "It compiles back to the same manifest. Check it with nylorun check folders/support, and save it with nylorun apply folders/support.",
    ]);
    const out = join(dir, "folders", "support");
    expect(await readFile(join(out, "skills", "labels", "labels.txt"), "utf8")).toBe("bug\nfeature\n");
    expect(JSON.parse(await readFile(join(out, "mcp.json"), "utf8"))).toEqual({
      mcpServers: { billing: { type: "sse", url: "https://mcp.billing.example.com/sse", headers: { Authorization: "Bearer ${BILLING_MCP}" } } },
    });
    // The lookup tool's slot is the one the compiler derives, so runtime.json leaves it out.
    expect(Object.keys(JSON.parse(await readFile(join(out, "runtime.json"), "utf8")).secrets)).toEqual(["BILLING_MCP", "LABELS_TOKEN"]);
    expect(await compiled(out)).toEqual((await composeManifest(source)).manifest);
    expect(deps.fetch.requests).toEqual([]);
  });

  it("moves a SKILL.md's secrets to AGENT.md, and refuses to write over the three files", async () => {
    const dir = await temporaryDir();
    const source = await threeFile(dir, "---\nname: labels\ndescription: Pick a label.\nsecrets: [LABELS_TOKEN]\n---\nUse the house labels.\n");
    const deps = await remote(join(dir, "agents"));
    await expect(migrateCommand(deps, ["folder", "support"])).rejects.toMatchObject({ exitCode: 2 });
    expect(await migrateCommand(deps, ["folder", "support", "--out", "../support-folder"])).toBe(0);
    expect(deps.errors).toEqual([
      "  note: skills/labels/SKILL.md: secrets moved to AGENT.md's skills block (D80), so the file and its hash change.",
      "It compiles to a different manifest: see the notes, then check it with nylorun check ../support-folder.",
    ]);
    const out = join(dir, "support-folder");
    expect(await readFile(join(out, "skills", "labels", "SKILL.md"), "utf8")).toBe(SKILL);
    expect(await readFile(join(out, "AGENT.md"), "utf8")).toContain("skills:\n  labels:\n    secrets:\n      - LABELS_TOKEN\n");
    const composed = (await composeManifest(source)).manifest;
    const folder = (await compiled(out))!;
    const skill = (manifest: AgentManifestV8) => (manifest.harness as { skills: Record<string, { secrets?: string[]; files: Record<string, string> }> }).skills.labels!;
    expect(skill(folder).secrets).toEqual(["LABELS_TOKEN"]);
    expect(skill(folder).files["SKILL.md"]).toBe(`sha256:${hex(SKILL)}`);
    expect({ ...folder, harness: { ...folder.harness, skills: undefined } }).toEqual({ ...composed, harness: { ...composed.harness, skills: undefined } });
  });
});

describe("nylorun pull", () => {
  const AGENT = "---\nname: support\ndescription: Answers billing questions.\n---\nAnswer questions about invoices.\n";
  const README = "# Support\n";
  const source = {
    name: "support",
    version: 3,
    compiler: "agent-folder/1",
    files: 2,
    bytes: AGENT.length + README.length,
    entries: [
      { path: "AGENT.md", size: AGENT.length, sha256: hex(AGENT) },
      { path: "docs/README.md", size: README.length, sha256: hex(README) },
    ],
  };
  const bodies: Record<string, string> = { "AGENT.md": AGENT, "docs/README.md": README };
  const handler: Handler = (method, path) => {
    if (path === "/v1/agent-manifests/support")
      return json(view({ manifestSchemaVersion: 8, name: "support", harness: {} }, 3, { compiler: "agent-folder/1", files: 2, bytes: 1 }));
    if (path === "/v1/agent-manifests/support/versions/3/source") return json(source);
    const file = /^\/v1\/agent-manifests\/support\/versions\/3\/source\/files\/(.+)$/.exec(path)?.[1];
    if (method === "GET" && file !== undefined) return new Response(bodies[decodeURIComponent(file)]);
    if (path === "/v1/agent-manifests/support/versions/2/source")
      return json({ code: "not_found", message: "Version 2 of agent manifest support was saved as JSON: it has no source." }, 404);
    return undefined;
  };

  it("writes the latest version's source byte for byte, then leaves the files that are the same", async () => {
    const dir = await temporaryDir();
    const deps = await remote(dir, handler);
    expect(await pullCommand(deps, ["support"])).toBe(0);
    expect(deps.lines).toEqual(["Wrote 2 files to support."]);
    expect(deps.errors).toEqual(["support@3, compiled by agent-folder/1. Check it with nylorun check support, and save an edit with nylorun apply support."]);
    expect(await readFile(join(dir, "support", "docs", "README.md"), "utf8")).toBe(README);
    expect(calls(deps)).toEqual([
      "GET /v1/agent-manifests/support",
      "GET /v1/agent-manifests/support/versions/3/source",
      "GET /v1/agent-manifests/support/versions/3/source/files/AGENT.md",
      "GET /v1/agent-manifests/support/versions/3/source/files/docs%2FREADME.md",
    ]);
    // An edit, then a pull: the edited file is a conflict, and nothing is written.
    await writeFile(join(dir, "support", "AGENT.md"), `${AGENT}Be brief.\n`);
    await expect(pullCommand(deps, ["support@3"])).rejects.toMatchObject({ exitCode: 1 });
    await writeFile(join(dir, "support", "AGENT.md"), AGENT);
    expect(await pullCommand(deps, ["support@3"])).toBe(0);
    expect(deps.lines.at(-1)).toBe("Wrote 0 files to support (2 files already there, the same).");
  });

  it("says a version saved as JSON has no source, and names export --folder", async () => {
    const dir = await temporaryDir();
    const deps = await remote(dir, handler);
    await expect(pullCommand(deps, ["support@2", "--out", "here"])).rejects.toMatchObject({
      exitCode: 1,
      message: "support@2 was saved as JSON, not from a folder, so it has no source. nylorun export --folder support@2 writes a folder from its manifest.",
    });
    expect(existsSync(join(dir, "here"))).toBe(false);
  });
});
