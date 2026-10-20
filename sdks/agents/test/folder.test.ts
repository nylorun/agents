import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_FOLDER_MEDIA_TYPE } from "@nylorun/core/contracts";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import { FolderInvalidError, checkFolder, diagnosticLine, isAgentFolder, packFolder } from "../src/index.js";
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
