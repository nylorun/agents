/**
 * The agent folder in `agents/triage/` (track T6): `mcp.json` names `${GITHUB_TOKEN}` in its
 * `Authorization` header and no `runtime.json` declares the slot, so the compiler derives a bearer
 * slot bound to the server's URL and says where. A typo is named by file, line and column, and the
 * SDK sends nothing.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { FolderInvalidError, checkFolder, createClient, packFolder } from "@nylorun/agents";
import { sectionGaps } from "@nylorun/core/define";
import { TRIAGE_FOLDER } from "../agents/triage/apply.js";

const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";
let copy: string;

beforeAll(async () => {
  // The same folder, with a typo in mcp.json.
  copy = await mkdtemp(join(tmpdir(), "examples-triage-"));
  await cp(TRIAGE_FOLDER, copy, { recursive: true });
  const mcp = await readFile(join(copy, "mcp.json"), "utf8");
  await writeFile(join(copy, "mcp.json"), mcp.replace('"url"', '"ulr"'));
});

afterAll(async () => {
  await rm(copy, { recursive: true, force: true });
});

it("compiles the folder into one manifest that fits, with the slot derived from mcp.json", async () => {
  const folder = await packFolder(TRIAGE_FOLDER);
  expect(folder.entries.map((entry) => entry.path)).toEqual(["AGENT.md", "README.md", "apply.ts", "mcp.json"]);
  const compiled = await checkFolder(folder);
  expect(compiled.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  expect(sectionGaps(compiled.manifest!)).toEqual([]);
  expect(compiled.manifest).toMatchObject({
    manifestSchemaVersion: 8,
    name: "triage",
    harness: { mcpServers: { github: { url: GITHUB_MCP_URL, credential: "GITHUB_TOKEN" } } },
    runtime: { kind: "none", secrets: { GITHUB_TOKEN: { type: "bearer", url: GITHUB_MCP_URL } } },
  });
  expect(compiled.diagnostics).toContainEqual(expect.objectContaining({ code: "slot_derived", file: "mcp.json" }));
  // The header that named the slot leaves the manifest.
  expect(JSON.stringify(compiled.manifest)).not.toContain("${GITHUB_TOKEN}");
});

it("names a typo by file, line and column, and sends nothing", async () => {
  const folder = await packFolder(copy);
  const compiled = await checkFolder(folder);
  expect(compiled.manifest).toBeUndefined();
  expect(compiled.diagnostics).toContainEqual(expect.objectContaining({ severity: "error", file: "mcp.json", line: 5 }));
  // Refused before any request: nothing listens at this address.
  const client = createClient({ url: "http://127.0.0.1:9", key: "unused" });
  await expect(client.agentManifests.saveFolder(folder)).rejects.toBeInstanceOf(FolderInvalidError);
});
