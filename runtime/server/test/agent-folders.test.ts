/**
 * Agent folders (track T6, D79): `PUT /v1/agent-manifests/{name}` with a folder by hash. The
 * Runtime reads the files the compiler needs from the definition file store, compiles them with
 * `@nylorun/core/folder`, and keeps the folder as the version's source; a folder that does not
 * compile is `422 folder_invalid` with the compiler's own diagnostics.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import { AGENT_FOLDER_MEDIA_TYPE } from "@nylorun/core/contracts";
import { compileAgentFolder, folderTextPaths, type AgentFolderEntry } from "@nylorun/core/folder";
import type { ModelProvider } from "../src/core/provider.js";
import { startTestTenant } from "./support/tenant.js";

const APP = "agent-folders-app-key-aaaaaaaaaaaaaaa";
const auth = { authorization: `Bearer ${APP}`, "nylorun-protocol": String(PROTOCOL_VERSION) };
const encoder = new TextEncoder();

interface Reply {
  status: number;
  body: any;
}

const model: ModelProvider = async () => ({ output: [{ type: "text", text: "ok" }] });
let runtime: Awaited<ReturnType<typeof startTestTenant>>;

beforeAll(async () => {
  runtime = await startTestTenant({ applicationKey: APP, modelProvider: model, sandbox: { backend: "virtual" } });
});

afterAll(async () => {
  await runtime?.close();
});

async function reply(response: Response): Promise<Reply> {
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* empty */
  }
  return { status: response.status, body };
}

const hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A folder's entries and bytes, from its files' text. */
function folder(files: Record<string, string>) {
  const bytes = new Map(Object.entries(files).map(([path, text]) => [path, encoder.encode(text)]));
  const entries: AgentFolderEntry[] = [...bytes].map(([path, data]) => ({ path, size: data.byteLength, sha256: hex(data) }));
  return { entries, bytes };
}

async function upload(files: Record<string, string>): Promise<void> {
  for (const data of folder(files).bytes.values()) {
    const response = await fetch(`${runtime.url}/v1/files/sha256:${hex(data)}`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/octet-stream" },
      body: data,
    });
    expect(response.status, await response.clone().text()).toBeLessThan(300);
  }
}

/** Saves (or plans, with `dryRun`) `files` as agent folder `name`, uploading them first unless `upload` is false. */
async function saveFolder(name: string, files: Record<string, string>, options: { dryRun?: boolean; upload?: boolean } = {}): Promise<Reply> {
  if (options.upload !== false) await upload(files);
  return reply(
    await fetch(`${runtime.url}/v1/agent-manifests/${name}${options.dryRun ? "?dryRun=true" : ""}`, {
      method: "PUT",
      headers: { ...auth, "content-type": AGENT_FOLDER_MEDIA_TYPE },
      body: JSON.stringify({ format: "nylorun.folder.v2", entries: folder(files).entries }),
    }),
  );
}

const get = async (path: string): Promise<Reply> => reply(await fetch(`${runtime.url}${path}`, { headers: auth }));

const TRIAGE = {
  "AGENT.md": `---
name: triage
description: Reads a GitHub issue and proposes a label and a priority.
---
Triage the GitHub issue the user names as owner/repo#number. Answer with one label and a priority.
`,
  "mcp.json": `{
  "mcpServers": {
    "github": {
      "type": "streamable-http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer \${GITHUB_TOKEN}", "X-MCP-Readonly": "true" }
    }
  }
}
`,
  "README.md": "# Triage\n",
};

describe("saving an agent folder", () => {
  it("plans with dryRun, saves the compiled manifest, and keeps the folder as the version's source", async () => {
    const plan = await saveFolder("triage", TRIAGE, { dryRun: true });
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    expect(plan.body).toMatchObject({ name: "triage", from: null, to: 1, unchanged: false, errors: [], compiler: "agent-folder/1" });
    // The slot runtime.json does not declare is derived, and the plan says where from.
    expect(plan.body.manifest.runtime.secrets.GITHUB_TOKEN).toMatchObject({ type: "bearer", url: "https://api.githubcopilot.com/mcp/" });
    expect(plan.body.diagnostics).toContainEqual(expect.objectContaining({ code: "slot_derived", file: "mcp.json" }));
    expect((await get("/v1/agent-manifests/triage")).status).toBe(404);

    const saved = await saveFolder("triage", TRIAGE);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ unchanged: false, manifest: { name: "triage", version: 1, source: { compiler: "agent-folder/1", files: 3 } } });
    const latest = await get("/v1/agent-manifests/triage");
    expect(latest.body.manifest.harness.mcpServers.github.credential).toBe("GITHUB_TOKEN");

    const source = await get("/v1/agent-manifests/triage/versions/1/source");
    expect(source.status).toBe(200);
    expect(source.body).toMatchObject({ name: "triage", version: 1, compiler: "agent-folder/1", files: 3 });
    expect(source.body.entries.map((entry: { path: string }) => entry.path)).toEqual(["AGENT.md", "README.md", "mcp.json"]);
    const file = await fetch(`${runtime.url}/v1/agent-manifests/triage/versions/1/source/files/${encodeURIComponent("mcp.json")}`, {
      headers: auth,
    });
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toContain("application/json");
    expect(await file.text()).toBe(TRIAGE["mcp.json"]);
    expect((await get("/v1/agent-manifests/triage/versions/1/source/files/nothing.md")).status).toBe(404);
  });

  it("answers a change outside the agent as unchanged, and says the source was not saved", async () => {
    await saveFolder("readme", { ...TRIAGE, "AGENT.md": TRIAGE["AGENT.md"].replace("name: triage", "name: readme") });
    const again = await saveFolder("readme", {
      ...TRIAGE,
      "AGENT.md": TRIAGE["AGENT.md"].replace("name: triage", "name: readme"),
      "README.md": "# Triage, better described\n",
    });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ unchanged: true, manifest: { version: 1 } });
    expect(again.body.diagnostics).toContainEqual(expect.objectContaining({ severity: "note", code: "source_not_saved" }));
  });

  it("refuses a folder that does not compile with the same diagnostics as the compiler, by file, line and column", async () => {
    const files = { ...TRIAGE, "runtime.json": '{\n  "kind": "virtual",\n  "netwrk": { "allowedHosts": [] }\n}\n' };
    const local = folder(files);
    const offline = compileAgentFolder({
      entries: local.entries,
      files: new Map(folderTextPaths(local.entries).map((path) => [path, local.bytes.get(path)!])),
      name: "triage",
    });
    for (const dryRun of [false, true]) {
      const refused = await saveFolder("triage", files, { dryRun });
      expect(refused.status, JSON.stringify(refused.body)).toBe(422);
      expect(refused.body.code).toBe("folder_invalid");
      expect(refused.body.details.diagnostics).toEqual(JSON.parse(JSON.stringify(offline.diagnostics)));
      expect(refused.body.details.diagnostics).toContainEqual(
        expect.objectContaining({ severity: "error", file: "runtime.json", line: 3, column: 3 }),
      );
      expect(refused.body.message).toContain("runtime.json:3:3");
    }
  });

  it("refuses a folder naming files the Runtime does not hold", async () => {
    const files = { "AGENT.md": "---\nname: lonely\ndescription: Never uploaded.\n---\nWork.\n" };
    const refused = await saveFolder("lonely", files, { upload: false });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ code: "definition_files_missing", details: { missing: [`sha256:${folder(files).entries[0]!.sha256}`] } });
    expect(refused.body.message).toContain("AGENT.md");
  });

  it("has no source for a version saved as JSON", async () => {
    const saved = await saveFolder("plain", { "AGENT.md": "---\nname: plain\ndescription: Plain.\n---\nWork.\n" });
    const manifest = (await get("/v1/agent-manifests/plain")).body.manifest;
    const json = await reply(
      await fetch(`${runtime.url}/v1/agent-manifests/plain`, {
        method: "PUT",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ ...manifest, description: "Plain, as JSON." }),
      }),
    );
    expect(saved.status).toBe(200);
    expect(json.status, JSON.stringify(json.body)).toBe(200);
    expect(json.body.manifest.version).toBe(2);
    expect(json.body.manifest.source).toBeUndefined();
    expect((await get("/v1/agent-manifests/plain/versions/2/source")).status).toBe(404);
    expect((await get("/v1/agent-manifests/plain/versions/1/source")).status).toBe(200);
  });
});

describe("saving a flow folder (track T7)", () => {
  const md = (name: string, description: string, body = "") => `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
  const BRIEF = {
    "AGENT.md": md("brief", "Drafts and publishes a brief."),
    "flow.json": `{ "chain": [{ "agent": "draft" }, { "tool": "publish" }] }`,
    "tools/publish.json": `{ "inputSchema": { "type": "object" }, "http": { "url": "https://cms.example.com/publish", "credential": "CMS_TOKEN" } }`,
    "agents/draft/AGENT.md": md("draft", "Drafts until the editor passes it."),
    "agents/draft/flow.json": `{ "loop": { "run": { "agent": "writer" }, "verify": { "agent": "editor" }, "max": 2 } }`,
    "agents/writer/AGENT.md": md("writer", "Writes.", "Write the brief.\n"),
    "agents/editor/AGENT.md": md("editor", "Checks.", "Check the brief.\n"),
  };

  it("saves a flow whose sub-flow names agents from the root's agents/, with its HTTP stage's slot derived", async () => {
    const saved = await saveFolder("brief", BRIEF);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const manifest = (await get("/v1/agent-manifests/brief")).body.manifest;
    expect(manifest.harness).toMatchObject({
      kind: "workflow",
      root: { chain: [{ agent: "draft" }, { tool: { name: "publish" } }] },
      agents: { draft: { kind: "workflow", agents: { writer: { id: "writer" }, editor: { id: "editor" } } } },
    });
    expect(Object.keys(manifest.harness.agents)).toEqual(["draft"]);
    expect(manifest.runtime.secrets.CMS_TOKEN).toMatchObject({ type: "bearer", url: "https://cms.example.com/publish" });
  });

  it("refuses an unknown stage by its file under the flow root, with line and column", async () => {
    const refused = await saveFolder("brief-typo", {
      ...BRIEF,
      "AGENT.md": md("brief-typo", "Drafts and publishes a brief."),
      "agents/draft/flow.json": `{ "loop": { "run": { "agent": "writter" }, "verify": { "agent": "editor" }, "max": 2 } }`,
    });
    expect(refused.status).toBe(422);
    expect(refused.body.details.diagnostics).toContainEqual(
      expect.objectContaining({ code: "agent_unknown", file: "agents/draft/flow.json", line: 1, column: 31 }),
    );
    expect(refused.body.message).toContain("agents/draft/flow.json:1:31");
  });
});

describe("comparing two versions' sources (track T7)", () => {
  it("lists the files added, removed and changed by hash, and how many stayed", async () => {
    const first = { ...TRIAGE, "AGENT.md": TRIAGE["AGENT.md"].replace("name: triage", "name: compare") };
    const second = {
      "AGENT.md": first["AGENT.md"].replace("one label", "one label and one sentence on why"),
      "mcp.json": first["mcp.json"],
      "notes/plan.txt": "Later: a second server.\n",
    };
    expect((await saveFolder("compare", first)).body.manifest.version).toBe(1);
    expect((await saveFolder("compare", second)).body.manifest.version).toBe(2);
    const diff = await get("/v1/agent-manifests/compare/source/diff?from=1&to=2");
    expect(diff.status, JSON.stringify(diff.body)).toBe(200);
    const agent = (files: Record<string, string>) => folder(files).entries.find((entry) => entry.path === "AGENT.md")!;
    expect(diff.body).toEqual({
      name: "compare",
      from: 1,
      to: 2,
      added: [folder(second).entries.find((entry) => entry.path === "notes/plan.txt")],
      removed: [folder(first).entries.find((entry) => entry.path === "README.md")],
      changed: [
        {
          path: "AGENT.md",
          from: { size: agent(first).size, sha256: agent(first).sha256 },
          to: { size: agent(second).size, sha256: agent(second).sha256 },
        },
      ],
      unchanged: 1,
    });
    // Backwards is the mirror, and a version against itself changes nothing.
    const back = (await get("/v1/agent-manifests/compare/source/diff?from=2&to=1")).body;
    expect(back.added.map((entry: { path: string }) => entry.path)).toEqual(["README.md"]);
    expect(back.removed.map((entry: { path: string }) => entry.path)).toEqual(["notes/plan.txt"]);
    expect((await get("/v1/agent-manifests/compare/source/diff?from=2&to=2")).body).toMatchObject({
      added: [],
      removed: [],
      changed: [],
      unchanged: 3,
    });
  });

  it("refuses versions that are not numbers, and a version with no source", async () => {
    for (const query of ["from=1", "from=0&to=1", "from=a&to=1", "from=1&to=1.5"])
      expect((await get(`/v1/agent-manifests/compare/source/diff?${query}`)).status, query).toBe(400);
    expect((await get("/v1/agent-manifests/compare/source/diff?from=1&to=9")).status).toBe(404);
    // plain's version 2 was saved as JSON.
    const json = await get("/v1/agent-manifests/plain/source/diff?from=1&to=2");
    expect(json.status).toBe(404);
    expect(json.body.message).toContain("saved as JSON");
  });
});

describe("the folder limits are the Tenant's (track T7)", () => {
  const setLimits = async (limits: Record<string, number>) => {
    const response = await fetch(`${runtime.url}/v1/tenant/limits`, {
      method: "PUT",
      headers: { ...runtime.managementHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ limits }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
  };

  it("refuses a folder with more files than folderFiles with 413, and holds the compiler to folderTextFileBytes", async () => {
    const files = { ...TRIAGE, "AGENT.md": TRIAGE["AGENT.md"].replace("name: triage", "name: limited") };
    await setLimits({ folderFiles: 2 });
    try {
      for (const dryRun of [false, true]) {
        const refused = await saveFolder("limited", files, { dryRun });
        expect(refused.status, JSON.stringify(refused.body)).toBe(413);
        expect(refused.body).toMatchObject({ code: "limit_exceeded", details: { limit: "folderFiles", value: 2 } });
        expect(refused.body.message).toContain("at most 2 files");
      }
      await setLimits({ folderBytes: 64 });
      const bytes = await saveFolder("limited", files);
      expect(bytes.status).toBe(413);
      expect(bytes.body.details).toEqual({ limit: "folderBytes", value: 64 });
      await setLimits({ folderTextFileBytes: 64 });
      const text = await saveFolder("limited", files);
      expect(text.status, JSON.stringify(text.body)).toBe(422);
      expect(text.body.details.diagnostics).toContainEqual(
        expect.objectContaining({ severity: "error", code: "limit_exceeded", file: "AGENT.md" }),
      );
    } finally {
      await setLimits({});
    }
    expect((await saveFolder("limited", files)).status).toBe(200);
  });
});
