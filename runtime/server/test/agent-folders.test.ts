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
