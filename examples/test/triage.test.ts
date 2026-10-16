/**
 * The three-file agent in `agents/triage/` (track T2's exit test): its harness file names a
 * credential slot that only the shared runtime file declares, and composing the two gives one
 * agent manifest whose sections fit. Without the slot, the composer names the gap the Runtime
 * would refuse it for, and the SDK sends nothing.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ManifestGapsError, composeManifest, createClient } from "@nylorun/agents";
import { sectionGaps } from "@nylorun/core/define";
import { EXAMPLES_ROOT } from "../agents/shared/root.js";
import { TRIAGE_FOLDER } from "../agents/triage/apply.js";

const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";
let copy: string;

beforeAll(async () => {
  // The same folders, with a runtime file that declares no secret slot.
  copy = await mkdtemp(join(tmpdir(), "examples-triage-"));
  await cp(TRIAGE_FOLDER, join(copy, "agents/triage"), { recursive: true });
  const runtime = JSON.parse(await readFile(join(EXAMPLES_ROOT, "platform/virtual.runtime.json"), "utf8"));
  delete runtime.secrets;
  await cp(join(EXAMPLES_ROOT, "platform"), join(copy, "platform"), { recursive: true });
  await writeFile(join(copy, "platform/virtual.runtime.json"), JSON.stringify(runtime));
});

afterAll(async () => {
  await rm(copy, { recursive: true, force: true });
});

it("composes the agent, harness and shared runtime files into one manifest that fits", async () => {
  const composed = await composeManifest(TRIAGE_FOLDER);
  expect(composed.gaps).toEqual([]);
  expect(sectionGaps(composed.manifest)).toEqual([]);
  expect(composed.manifest).toMatchObject({
    manifestSchemaVersion: 8,
    name: "triage",
    harness: { mcpServers: { github: { url: GITHUB_MCP_URL, credential: "GITHUB_TOKEN" } } },
    runtime: { kind: "virtual", secrets: { GITHUB_TOKEN: { type: "bearer", url: GITHUB_MCP_URL } } },
  });
  // What only the authoring files hold stays out of the document.
  expect(JSON.stringify(composed.manifest)).not.toMatch(/\$schema|"credentials"/);
});

it("names the missing slot when the runtime declares none, and sends nothing", async () => {
  const composed = await composeManifest(join(copy, "agents/triage"));
  expect(composed.gaps).toEqual([
    'harness.mcpServers.github.credential "GITHUB_TOKEN" is not a secret slot in runtime.secrets',
  ]);
  // Refused before any request: nothing listens at this address.
  const client = createClient({ url: "http://127.0.0.1:9", key: "unused" });
  await expect(client.agentManifests.save(composed)).rejects.toBeInstanceOf(ManifestGapsError);
});
