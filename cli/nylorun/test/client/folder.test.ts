import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROTOCOL_FEATURES, PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import { AGENT_FOLDER_MEDIA_TYPE } from "@nylorun/core/contracts";
import { agentFolderJsonSchemas } from "@nylorun/core/folder";
import { applyCommand } from "../../src/client/apply.js";
import { checkCommand, initCommand } from "../../src/client/folder.js";
import { schemaMappings } from "../../src/client/init.js";
import { fakeFetch, json, temporaryDir, temporaryHome, testDeps } from "../stack/support.js";

const URL_ = "http://runtime.test";
const KEY = "ab".repeat(32);
const hex = (text: string) => createHash("sha256").update(text).digest("hex");

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

const AGENT = "---\nname: support\ndescription: Answers billing questions.\n---\nAnswer questions about invoices.\n";

async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
}

describe("nylorun init and check", () => {
  it("writes an AGENT.md that checks, and refuses to write over one", async () => {
    const dir = await temporaryDir();
    const deps = await remote(dir);
    expect(await initCommand(deps, ["support", "--description", "Answers billing questions."])).toBe(0);
    expect(await readFile(join(dir, "support", "AGENT.md"), "utf8")).toContain('description: "Answers billing questions."');
    expect(await checkCommand(deps, ["support"])).toBe(0);
    expect(deps.lines.at(-1)).toBe("support: ok, agent manifest support (1 file, agent-folder/1)");
    await expect(initCommand(deps, ["support"])).rejects.toMatchObject({ exitCode: 1 });
    await expect(initCommand(deps, ["-bad name"])).rejects.toMatchObject({ exitCode: 2 });
    expect(deps.fetch.requests).toEqual([]);
  });

  it("takes a path, names the agent after its last segment, and sets the project up once", async () => {
    const dir = await temporaryDir();
    await mkdir(join(dir, ".git"));
    await mkdir(join(dir, ".vscode"));
    await writeFile(join(dir, ".vscode", "settings.json"), JSON.stringify({ "editor.tabSize": 2, "json.schemas": [{ fileMatch: ["x.json"], url: "https://example.com/x.json" }] }));
    await writeFile(join(dir, ".gitignore"), "dist");
    const deps = await remote(join(dir, "src"));
    await mkdir(join(dir, "src"));
    expect(await initCommand(deps, ["../agents/hello"])).toBe(0);
    expect(await readFile(join(dir, "agents", "hello", "AGENT.md"), "utf8")).toMatch(/^---\nname: hello\n/);
    expect(await readFile(join(dir, ".gitattributes"), "utf8")).toBe("* text=auto eol=lf\n");
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe("dist\n.nylorun/credentials.json\n");
    const base = "https://docs.nylorun.com/schemas/agent-folder/v1";
    const settings = JSON.parse(await readFile(join(dir, ".vscode", "settings.json"), "utf8"));
    expect(settings).toEqual({
      "editor.tabSize": 2,
      "json.schemas": [
        { fileMatch: ["x.json"], url: "https://example.com/x.json" },
        { fileMatch: ["agents/**/runtime.json"], url: `${base}/runtime.json` },
        { fileMatch: ["agents/**/tools/*.json"], url: `${base}/tool.json` },
        { fileMatch: ["agents/**/flow.json"], url: `${base}/flow.json` },
        { fileMatch: ["agents/**/mcp.json", "!agents/**/plugins/**"], url: `${base}/mcp.json` },
      ],
    });
    expect(deps.lines.at(-1)).toBe(
      "Next: nylorun check ../agents/hello, then nylorun apply ../agents/hello --agent to save it and make the Agent hello, then nylorun chat hello.",
    );

    // A second folder beside it changes nothing of the project's.
    const again = await remote(dir);
    expect(await initCommand(again, ["agents/other"])).toBe(0);
    expect(again.lines).toEqual([
      "Wrote agents/other/AGENT.md.",
      "Next: nylorun check agents/other, then nylorun apply agents/other --agent to save it and make the Agent other, then nylorun chat other.",
    ]);
    expect(JSON.parse(await readFile(join(dir, ".vscode", "settings.json"), "utf8"))).toEqual(settings);

    // Settings that are not plain JSON are left alone, and an ignore that covers .nylorun/ is kept.
    const other = await temporaryDir();
    await write(other, { ".vscode/settings.json": "{\n  // comments\n}\n", ".gitignore": ".nylorun/\n" });
    const third = await remote(other);
    expect(await initCommand(third, ["bot"])).toBe(0);
    expect(await readFile(join(other, ".vscode", "settings.json"), "utf8")).toBe("{\n  // comments\n}\n");
    expect(await readFile(join(other, ".gitignore"), "utf8")).toBe(".nylorun/\n");
    expect(third.lines).toContainEqual(expect.stringContaining(".vscode/settings.json is not plain JSON, so it was left alone"));
  });

  it("maps the folder files to the JSON Schemas @nylorun/core publishes, at their $id", () => {
    const ids = Object.values(agentFolderJsonSchemas()).map((schema) => schema.$id);
    const urls = schemaMappings("/project", "/project/agents/hello").map((mapping) => mapping.url);
    expect(urls).toHaveLength(4);
    for (const url of urls) expect(ids).toContain(url);
  });

  it("--example scaffolds a tool, an MCP server and a trigger that check without an error", async () => {
    const dir = await temporaryDir();
    const deps = await remote(dir);
    expect(await initCommand(deps, ["hello", "--example"])).toBe(0);
    expect(deps.lines[0]).toBe("Wrote hello/: AGENT.md, tools/get_order.json, mcp.json, triggers/new-order.md, README.md.");
    expect(await readFile(join(dir, "hello", "mcp.json"), "utf8")).toContain('"Authorization": "Bearer ${ORDERS_MCP_TOKEN}"');
    expect(await checkCommand(deps, ["hello", "--json"])).toBe(0);
    const [report] = JSON.parse(deps.lines.at(-1)!).folders;
    expect(report).toMatchObject({ path: "hello", ok: true, manifest: { name: "hello" } });
    expect(report.diagnostics.filter((item: { severity: string }) => item.severity === "error" || item.severity === "warning")).toEqual([]);
    expect(report.manifest.harness.tools).toEqual([expect.objectContaining({ name: "get_order" })]);
    expect(Object.keys(report.manifest.runtime.secrets).sort()).toEqual(["ORDERS_MCP_TOKEN", "ORDERS_TOKEN"]);
    expect(Object.keys(report.manifest.runtime.triggers)).toEqual(["new-order"]);
    await expect(initCommand(deps, ["hello", "--example"])).rejects.toMatchObject({ exitCode: 1 });
  });

  it("check --json reports each folder with its diagnostics, and exits 1 when one does not compile", async () => {
    const dir = await temporaryDir();
    await write(dir, { "agents/support/AGENT.md": AGENT, "agents/broken/AGENT.md": "---\nname: broken\n---\nWork.\n" });
    const deps = await remote(dir);
    expect(await checkCommand(deps, ["agents", "--json"])).toBe(1);
    expect(deps.errors).toEqual([]);
    const { folders } = JSON.parse(deps.lines.join("\n"));
    expect(folders).toEqual([
      { path: "agents/broken", ok: false, diagnostics: [expect.objectContaining({ severity: "error", file: "AGENT.md" })] },
      { path: "agents/support", ok: true, manifest: expect.objectContaining({ name: "support" }), diagnostics: [] },
    ]);
  });

  it("prints every problem by file, line and column, and exits 1", async () => {
    const dir = await temporaryDir();
    await write(dir, { "agents/support/AGENT.md": AGENT, "agents/support/runtime.json": '{\n  "kind": "virtual",\n  "netwrk": {}\n}\n' });
    const deps = await remote(dir);
    expect(await checkCommand(deps, ["agents"])).toBe(1);
    expect(deps.errors[0]).toMatch(/^agents\/support\/runtime\.json:3:3 error: /);
    expect(deps.errors.at(-1)).toBe("agents/support: 1 error");
    await expect(checkCommand(deps, ["nowhere"])).rejects.toMatchObject({ exitCode: 2 });
  });
});

describe("nylorun apply on an agent folder", () => {
  it("plans, then sends the folder by hash under If-Match, its files uploaded first", async () => {
    const dir = await temporaryDir();
    await write(dir, { "support/AGENT.md": AGENT, "support/README.md": "# Support\n" });
    const held = new Set<string>();
    const deps = await remote(dir, (method, path, init) => {
      if (method === "HEAD") return new Response(null, { status: held.has(path) ? 200 : 404 });
      if (method === "PUT" && path.startsWith("/v1/files/")) {
        held.add(path);
        return json({ sha256: path.slice(10), size: 1 }, 201);
      }
      if (path.startsWith("/v1/agent-manifests/support")) {
        expect(new Headers(init!.headers).get("content-type")).toBe(AGENT_FOLDER_MEDIA_TYPE);
        if (path.endsWith("?dryRun=true"))
          return json({
            name: "support",
            from: null,
            to: 1,
            unchanged: false,
            changes: [],
            warnings: [],
            errors: [],
            behind: 0,
            manifest: { manifestSchemaVersion: 8, name: "support" },
            diagnostics: [{ severity: "info", code: "file_not_compiled", message: "Kept with the source", file: "README.md" }],
            compiler: "agent-folder/1",
          });
        expect(new Headers(init!.headers).get("if-match")).toBe("0");
        return json({ manifest: { name: "support", version: 1 }, unchanged: false, warnings: [] });
      }
      return undefined;
    });
    expect(await applyCommand(deps, ["support"])).toBe(0);
    expect(deps.lines).toEqual(["support: new, version 1", "  support/README.md info: Kept with the source"]);
    expect(deps.errors).toEqual(["Saved agent manifest support version 1 on http://runtime.test."]);
    const calls = deps.fetch.requests
      .filter((request) => !request.url.endsWith("/health"))
      .map((request) => `${request.init?.method ?? "GET"} ${request.url.slice(URL_.length)}`);
    expect(calls.filter((call) => !call.startsWith("HEAD"))).toEqual([
      `PUT /v1/files/sha256:${hex(AGENT)}`,
      `PUT /v1/files/sha256:${hex("# Support\n")}`,
      "PUT /v1/agent-manifests/support?dryRun=true",
      "PUT /v1/agent-manifests/support",
    ]);
  });

  it("--dry-run prints the compiled manifest, and a folder that does not compile sends nothing", async () => {
    const dir = await temporaryDir();
    await write(dir, { "support/AGENT.md": AGENT });
    const deps = await remote(dir, (method, path) => {
      if (method === "HEAD") return new Response(null, { status: 200 });
      if (path === "/v1/agent-manifests/support?dryRun=true")
        return json({
          name: "support",
          from: 1,
          to: 1,
          unchanged: true,
          changes: [],
          warnings: [],
          errors: [],
          behind: 0,
          manifest: { manifestSchemaVersion: 8, name: "support" },
          diagnostics: [],
          compiler: "agent-folder/1",
        });
      return undefined;
    });
    expect(await applyCommand(deps, ["support", "--dry-run"])).toBe(0);
    expect(deps.lines[0]).toBe("support: unchanged at version 1");
    expect(JSON.parse(deps.lines.slice(1).join("\n"))).toEqual({ manifestSchemaVersion: 8, name: "support" });

    await write(dir, { "broken/AGENT.md": "---\nname: broken\n---\n" });
    const before = deps.fetch.requests.length;
    expect(await applyCommand(deps, ["broken"])).toBe(1);
    expect(deps.errors).toContainEqual(expect.stringMatching(/^broken\/AGENT\.md.* error: description is required/));
    expect(deps.fetch.requests.length).toBe(before);
  });
});
