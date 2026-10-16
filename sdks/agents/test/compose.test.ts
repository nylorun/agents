import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentManifestV8Schema } from "@nylorun/core/contracts";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import { AgentsClient } from "../src/client.js";
import { ComposeError, composeManifest, manifestFolders } from "../src/compose.js";

const sha256 = (contents: string | Uint8Array) => `sha256:${createHash("sha256").update(contents).digest("hex")}`;
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

function folder(files: Record<string, string | Uint8Array | object>): string {
  const root = mkdtempSync(join(tmpdir(), "nylorun-compose-"));
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(
      join(root, path),
      typeof contents === "string" || contents instanceof Uint8Array ? contents : JSON.stringify(contents, null, 2),
    );
  }
  return root;
}

const TRIAGE_SKILL = "---\nname: triage\ndescription: Triage an issue.\n---\nLabel it.\n";
const PR_SKILL = "---\nname: open-pr\ndescription: Open a pull request.\n---\nSteps.\n";
const SETUP = "#!/bin/sh\necho ready\n";

/** Two agents sharing one runtime file, as `nylorun apply agents/` reads them. */
function project(harness: Record<string, unknown> = {}, runtime: Record<string, unknown> = {}) {
  return folder({
    "agents/triage/agent.manifest.json": {
      $schema: "https://docs.nylorun.com/schemas/agent-manifest/v8.json",
      manifestSchemaVersion: 8,
      name: "triage",
      description: "Triages issues.",
      harness: "./harness.manifest.json",
      runtime: "../../shared/runtime.manifest.json",
    },
    "agents/triage/harness.manifest.json": {
      $schema: "https://docs.nylorun.com/schemas/harness-manifest/v1.json",
      instructions: ["Triage each issue."],
      tools: [
        {
          name: "lookup",
          inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
          http: { url: "https://items.example.com/lookup" },
        },
      ],
      skills: "./skills",
      mcpServers: "./mcp.json",
      plugins: ["../../plugins/github"],
      credentials: { linear: "linear", lookup: "items" },
      requires: { sandbox: "any", secrets: ["GH_TOKEN"] },
      ...harness,
    },
    "agents/triage/skills/triage/SKILL.md": TRIAGE_SKILL,
    "agents/triage/skills/triage/references/labels.md": "# Labels\n",
    "agents/triage/mcp.json": {
      $schema: MCP_SCHEMA,
      mcpServers: { linear: { type: "streamable-http", url: "https://mcp.linear.app/mcp" } },
    },
    "agents/other/agent.manifest.json": {
      manifestSchemaVersion: 8,
      name: "other",
      harness: { instructions: ["Help."] },
    },
    "plugins/github/plugin.json": { $schema: PLUGIN_SCHEMA, name: "github", version: "1.2.0" },
    "plugins/github/skills/open-pr/SKILL.md": PR_SKILL,
    "plugins/github/mcp.json": {
      $schema: MCP_SCHEMA,
      mcpServers: { github: { type: "streamable-http", url: "https://api.githubcopilot.com/mcp/" } },
    },
    "shared/runtime.manifest.json": {
      $schema: "https://docs.nylorun.com/schemas/runtime-manifest/v1.json",
      kind: "pod",
      image: "node:24-bookworm",
      files: [{ path: "/workspace/kit", from: "./kit" }],
      secrets: {
        GH_TOKEN: { type: "environment_secret", allowedHosts: ["api.github.com"] },
        linear: { type: "bearer", url: "https://mcp.linear.app/mcp" },
        items: { type: "bearer", url: "https://items.example.com/lookup" },
      },
      ...runtime,
    },
    "shared/kit/setup.sh": SETUP,
    "shared/kit/.env": "SECRET=1",
  });
}

describe("composeManifest", () => {
  it("resolves the harness, its skills, MCP servers and plugins, and a shared runtime file, into one v8 document", async () => {
    const root = project();
    const composed = await composeManifest(join(root, "agents/triage"));
    expect(AgentManifestV8Schema.parse(composed.manifest)).toEqual(composed.manifest);
    expect(composed.gaps).toEqual([]);
    const { harness, runtime, ...top } = composed.manifest as any;
    expect(top).toEqual({ manifestSchemaVersion: 8, name: "triage", description: "Triages issues." });
    expect(harness.instructions).toEqual(["Triage each issue."]);
    expect(harness.tools[0].http).toEqual({ url: "https://items.example.com/lookup", credential: "items" });
    expect(harness.skills).toEqual({
      triage: {
        name: "triage",
        description: "Triage an issue.",
        files: { "SKILL.md": sha256(TRIAGE_SKILL), "references/labels.md": sha256("# Labels\n") },
      },
      "open-pr": {
        name: "open-pr",
        description: "Open a pull request.",
        files: { "SKILL.md": sha256(PR_SKILL) },
        plugin: { name: "github", version: "1.2.0" },
      },
    });
    expect(harness.mcpServers).toEqual({
      linear: { name: "linear", type: "streamable-http", url: "https://mcp.linear.app/mcp", credential: "linear" },
      github: {
        name: "github",
        type: "streamable-http",
        url: "https://api.githubcopilot.com/mcp/",
        plugin: { name: "github", version: "1.2.0" },
      },
    });
    expect(harness.plugins).toEqual([{ name: "github", version: "1.2.0" }]);
    // Only the composer reads these; the API never sees them.
    for (const field of ["requires", "credentials", "$schema"]) expect(harness).not.toHaveProperty(field);
    expect(runtime).not.toHaveProperty("$schema");
    expect(runtime.files).toEqual([{ path: "/workspace/kit", files: { "setup.sh": sha256(SETUP) } }]);
    // Every file it names by hash, ready to upload; never the .env file.
    expect([...composed.files.keys()].sort()).toEqual(
      [sha256(TRIAGE_SKILL), sha256("# Labels\n"), sha256(PR_SKILL), sha256(SETUP)].sort(),
    );
    expect(new TextDecoder().decode(await composed.files.get(sha256(SETUP))!.read())).toBe(SETUP);
  });

  it("names the gaps: what requires asks of the runtime, and what the Runtime would refuse", async () => {
    const root = project({}, { kind: "none", image: undefined, files: undefined, secrets: undefined });
    const composed = await composeManifest(join(root, "agents/triage"));
    expect(composed.gaps).toEqual([
      'harness.requires.sandbox "any" needs runtime.kind "virtual" or "pod"; the runtime is "none"',
      'harness.requires.secrets "GH_TOKEN" is not a secret slot in runtime.secrets',
      'harness.mcpServers.linear.credential "linear" is not a secret slot in runtime.secrets',
      'harness.tools.lookup.http.credential "items" is not a secret slot in runtime.secrets',
      'harness.skills needs a sandbox; runtime.kind "none" has none',
    ]);
  });

  it("refuses a credentials entry that names no server or HTTP tool, and an invalid file", async () => {
    const unknown = project({ credentials: { jira: "jira" } });
    await expect(composeManifest(join(unknown, "agents/triage"))).rejects.toThrow(
      "credentials names jira, which is no MCP server or HTTP tool of the harness",
    );
    const invalid = project({ approval: "always" });
    const error = await composeManifest(join(invalid, "agents/triage")).catch((e) => e);
    expect(error).toBeInstanceOf(ComposeError);
    expect(error.path).toMatch(/harness\.manifest\.json$/);
  });

  it("saves what it composed, uploading the files the Runtime lacks first", async () => {
    const root = project();
    const composed = await composeManifest(join(root, "agents/triage"));
    const sent: string[] = [];
    const client = new AgentsClient({
      url: "http://127.0.0.1:8787",
      key: "a".repeat(64),
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === "/health") return Response.json({ status: "ok", protocol: HOST_PROTOCOL });
        sent.push(`${init?.method} ${path}`);
        if (init?.method === "HEAD") return new Response(null, { status: 404 });
        if (path.startsWith("/v1/files/")) return Response.json({}, { status: 201 });
        return Response.json({ manifest: { name: "triage", version: 1 }, unchanged: false, warnings: [] });
      },
    });
    await client.agentManifests.save(composed, { ifMatch: 0 });
    expect(sent.filter((call) => call.startsWith("PUT /v1/files/"))).toHaveLength(4);
    expect(sent.at(-1)).toBe("PUT /v1/agent-manifests/triage");
  });

  it("finds the folders to apply: the folder itself, else each subfolder with an agent.manifest.json", async () => {
    const root = project();
    expect(await manifestFolders(join(root, "agents/triage"))).toEqual([join(root, "agents/triage")]);
    expect(await manifestFolders(join(root, "agents"))).toEqual([join(root, "agents/other"), join(root, "agents/triage")]);
    expect(await manifestFolders(join(root, "shared"))).toEqual([]);
  });
});
