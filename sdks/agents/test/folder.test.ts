import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_FOLDER_MEDIA_TYPE } from "@nylorun/core/contracts";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import { FolderError, FolderInvalidError, checkFolder, diagnosticLine, ignoreMatcher, isAgentFolder, packFolder } from "../src/index.js";
import { AgentsClient } from "../src/client.js";

const KEY = "a".repeat(64);
const AGENT = "---\nname: support\ndescription: Answers billing questions.\n---\nAnswer questions about invoices.\n";

/** A folder in a temporary directory, from its files' text. */
function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "nylorun-folder-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const hex = (text: string) => createHash("sha256").update(text).digest("hex");

function fake(respond: (method: string, path: string) => Response) {
  const sent: { method: string; path: string; search: string; contentType: string | null; body?: any }[] = [];
  const client = new AgentsClient({
    url: "http://127.0.0.1:8787",
    key: KEY,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/health") return Response.json({ status: "ok", protocol: HOST_PROTOCOL });
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      sent.push({ method, path: url.pathname, search: url.search, contentType: new Headers(init?.headers).get("content-type"), body });
      return respond(method, url.pathname);
    },
  });
  return { client, sent };
}

describe("packFolder", () => {
  it("lists every file by path, size and hash, skipping .git, node_modules and symbolic links", async () => {
    const dir = folder({
      "AGENT.md": AGENT,
      "instructions/tone.md": "Be brief.\n",
      ".git/HEAD": "ref: refs/heads/main\n",
      "node_modules/x/index.js": "x\n",
    });
    symlinkSync(join(dir, "AGENT.md"), join(dir, "link.md"));
    const packed = await packFolder(dir);
    expect(packed.entries).toEqual([
      { path: "AGENT.md", size: Buffer.byteLength(AGENT), sha256: hex(AGENT) },
      { path: "instructions/tone.md", size: 10, sha256: hex("Be brief.\n") },
    ]);
    expect(packed.skipped).toEqual(["link.md: a symbolic link, not followed"]);
    expect(new TextDecoder().decode(await packed.files.get("instructions/tone.md")!.read())).toBe("Be brief.\n");
    expect(await isAgentFolder(dir)).toBe(true);
    expect(await isAgentFolder(join(dir, "instructions"))).toBe(false);
  });
});

describe(".nyloignore", () => {
  it("follows gitignore rules: globs, a name at any depth, anchors, directories, negation and comments", () => {
    const ignored = ignoreMatcher(
      ["# notes stay out", "*.log", "!keep.log", "/drafts", "build/", "docs/**/*.tmp", "\\#hash", "data/*", "!data/seed.csv", ""].join("\n"),
    );
    expect(ignored("a.log")).toBe(true);
    expect(ignored("deep/x/b.log")).toBe(true);
    expect(ignored("keep.log")).toBe(false);
    expect(ignored("drafts", true)).toBe(true);
    expect(ignored("drafts/one.md")).toBe(true);
    expect(ignored("notes/drafts")).toBe(false);
    expect(ignored("build", true)).toBe(true);
    expect(ignored("build")).toBe(false);
    expect(ignored("x/build/out.js")).toBe(true);
    expect(ignored("docs/a.tmp")).toBe(true);
    expect(ignored("docs/a/b/c.tmp")).toBe(true);
    expect(ignored("other/a.tmp")).toBe(false);
    expect(ignored("#hash")).toBe(true);
    expect(ignored("# notes stay out")).toBe(false);
    expect(ignored("data/raw.csv")).toBe(true);
    expect(ignored("data/seed.csv")).toBe(false);
    expect(ignoreMatcher("")("anything")).toBe(false);
  });

  it("leaves what it names out of the pack, and nothing below a directory it leaves out comes back", async () => {
    const dir = folder({
      "AGENT.md": AGENT,
      ".nyloignore": "*.log\nscratch/\n!scratch/keep.md\n",
      "notes.log": "x\n",
      "files/run.log": "x\n",
      "files/data.csv": "a\n",
      "scratch/keep.md": "x\n",
    });
    const packed = await packFolder(dir);
    expect(packed.entries.map((entry) => entry.path)).toEqual([".nyloignore", "AGENT.md", "files/data.csv"]);
    expect(packed.skipped).toEqual([]);
  });
});

describe("runtime.json extends", () => {
  it("packs the merge, the folder's own keys winning, and names its origin; the file on disk is unchanged", async () => {
    const repo = folder({
      "platform/base.runtime.json": JSON.stringify({ kind: "virtual", network: { allowedHosts: ["a.example.com"], mode: "allowlist" }, limits: { turnSeconds: 60 } }),
      "platform/pod.runtime.json": JSON.stringify({ $schema: "https://example.com/x.json", extends: "./base.runtime.json", kind: "pod", limits: { turnSeconds: 120 } }),
      "agents/triage/AGENT.md": AGENT,
      "agents/triage/runtime.json": JSON.stringify({ extends: "../../platform/pod.runtime.json", network: { allowedHosts: ["b.example.com"] } }),
    });
    const dir = join(repo, "agents", "triage");
    const packed = await packFolder(dir);
    const text = (path: string) => packed.files.get(path)!.read().then((data) => new TextDecoder().decode(data));
    expect(JSON.parse(await text("runtime.json"))).toEqual({
      kind: "pod",
      network: { allowedHosts: ["b.example.com"], mode: "allowlist" },
      limits: { turnSeconds: 120 },
    });
    expect(JSON.parse(await text(".nylorun/origin.json"))).toEqual({
      "runtime.json": { extends: ["../../platform/pod.runtime.json", "../../platform/base.runtime.json"] },
    });
    const merged = await text("runtime.json");
    expect(packed.entries.find((entry) => entry.path === "runtime.json")).toEqual({
      path: "runtime.json",
      size: Buffer.byteLength(merged),
      sha256: hex(merged),
    });
    expect(packed.entries.map((entry) => entry.path)).toEqual([".nylorun/origin.json", "AGENT.md", "runtime.json"]);
    expect(packed.extended).toEqual([join(repo, "platform", "pod.runtime.json"), join(repo, "platform", "base.runtime.json")]);
    expect(JSON.parse(await readFile(join(dir, "runtime.json"), "utf8"))).toHaveProperty("extends");
  });

  it("refuses a missing file, a cycle and a file that is not a JSON object, by name", async () => {
    const missing = folder({ "AGENT.md": AGENT, "runtime.json": '{ "extends": "../shared/none.json" }' });
    await expect(packFolder(missing)).rejects.toThrow(FolderError);
    await expect(packFolder(missing)).rejects.toThrow(/runtime\.json: extends \.\.\/shared\/none\.json, which does not exist/);
    const cycle = folder({ "AGENT.md": AGENT, "runtime.json": '{ "extends": "./a.json" }', "a.json": '{ "extends": "./b.json" }', "b.json": '{ "extends": "./a.json" }' });
    await expect(packFolder(cycle)).rejects.toThrow("runtime.json: extends makes a cycle: runtime.json → a.json → b.json → a.json");
    const array = folder({ "AGENT.md": AGENT, "runtime.json": '{ "extends": "./a.json" }', "a.json": "[1]" });
    await expect(packFolder(array)).rejects.toThrow("a.json, which runtime.json extends, is not a JSON object");
    // A runtime.json that is not JSON is the compiler's to report, with its position.
    const broken = await packFolder(folder({ "AGENT.md": AGENT, "runtime.json": '{ "extends": ' }));
    expect(new TextDecoder().decode(await broken.files.get("runtime.json")!.read())).toBe('{ "extends": ');
  });

  it("compiles the merged runtime section offline", async () => {
    const repo = folder({
      "shared/runtime.json": JSON.stringify({ kind: "virtual", network: { allowedHosts: [] } }),
      "agent/AGENT.md": AGENT,
      "agent/runtime.json": JSON.stringify({ extends: "../shared/runtime.json" }),
    });
    const result = await checkFolder(await packFolder(join(repo, "agent")));
    expect(result.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(result.manifest?.runtime).toMatchObject({ kind: "virtual", network: { allowedHosts: [] } });
  });
});

describe("checkFolder", () => {
  it("compiles offline, as the Runtime does", async () => {
    const result = await checkFolder(await packFolder(folder({ "AGENT.md": AGENT, "instructions/tone.md": "Be brief.\n" })));
    expect(result.manifest).toMatchObject({ name: "support", harness: { instructions: ["Answer questions about invoices.", "Be brief."] } });
  });

  it("names each problem by file, line and column", async () => {
    const result = await checkFolder(await packFolder(folder({ "AGENT.md": AGENT, "runtime.json": '{\n  "kind": "virtual",\n  "netwrk": {}\n}\n' })));
    expect(result.manifest).toBeUndefined();
    const error = result.diagnostics.find((item) => item.severity === "error")!;
    expect(diagnosticLine(error)).toMatch(/^runtime\.json:3:3 error: /);
  });
});

describe("client.agentManifests folders", () => {
  it("uploads the files the Runtime lacks, then sends the folder by hash", async () => {
    const dir = folder({ "AGENT.md": AGENT, "README.md": "# Support\n" });
    const { client, sent } = fake((method) =>
      method === "HEAD" ? new Response(null, { status: 404 }) : Response.json({ manifest: { name: "support", version: 1 }, unchanged: false, warnings: [] }),
    );
    await client.agentManifests.saveFolder(await packFolder(dir), { requestId: "req-1" });
    expect(sent.map((item) => `${item.method} ${item.path}`)).toEqual([
      `HEAD /v1/files/sha256:${hex(AGENT)}`,
      `PUT /v1/files/sha256:${hex(AGENT)}`,
      `HEAD /v1/files/sha256:${hex("# Support\n")}`,
      `PUT /v1/files/sha256:${hex("# Support\n")}`,
      "PUT /v1/agent-manifests/support",
    ]);
    expect(sent.at(-1)).toMatchObject({
      contentType: AGENT_FOLDER_MEDIA_TYPE,
      body: {
        requestId: "req-1",
        format: "nylorun.folder.v2",
        entries: [
          { path: "AGENT.md", size: Buffer.byteLength(AGENT), sha256: hex(AGENT) },
          { path: "README.md", size: 10, sha256: hex("# Support\n") },
        ],
      },
    });
  });

  it("plans with dryRun, and refuses a folder that does not compile before sending anything", async () => {
    const { client, sent } = fake((method) => (method === "HEAD" ? new Response(null, { status: 200 }) : Response.json({ name: "support" })));
    await client.agentManifests.planFolder(await packFolder(folder({ "AGENT.md": AGENT })));
    expect(sent.at(-1)).toMatchObject({ method: "PUT", search: "?dryRun=true" });
    const before = sent.length;
    const broken = await packFolder(folder({ "AGENT.md": "---\nname: support\n---\n" }));
    await expect(client.agentManifests.saveFolder(broken)).rejects.toBeInstanceOf(FolderInvalidError);
    expect(sent.length).toBe(before);
  });
});
