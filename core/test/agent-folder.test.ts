import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  AGENT_FOLDER_COMPILER,
  compileAgentFolder,
  folderTextPaths,
  type AgentFolderDiagnostic,
  type AgentFolderEntry,
} from "../src/folder/index.js";

const encoder = new TextEncoder();

/** A folder from its files' text (or bytes), as the Runtime and the CLI hand it to the compiler. */
function folder(files: Record<string, string | Uint8Array>) {
  const entries: AgentFolderEntry[] = [];
  const bytes = new Map<string, Uint8Array>();
  for (const [path, content] of Object.entries(files)) {
    const data = typeof content === "string" ? encoder.encode(content) : content;
    entries.push({ path, size: data.byteLength, sha256: bytesToHex(sha256(data)) });
    bytes.set(path, data);
  }
  const text = new Map(folderTextPaths(entries).map((path) => [path, bytes.get(path)!]));
  return { entries, files: text, hash: (path: string) => `sha256:${entries.find((entry) => entry.path === path)!.sha256}` };
}

function compile(files: Record<string, string | Uint8Array>, name?: string) {
  const { entries, files: text } = folder(files);
  return compileAgentFolder({ entries, files: text, ...(name === undefined ? {} : { name }) });
}

const errors = (diagnostics: readonly AgentFolderDiagnostic[]) => diagnostics.filter((item) => item.severity === "error");

const TRIAGE_AGENT = `---
name: triage
description: Reads a GitHub issue and proposes a label and a priority.
---
Triage the GitHub issue the user names as owner/repo#number. Read it, and its comments,
with the github tools.

Answer with one label (bug, feature, question or docs), a priority from p0 (urgent) to
p3, and one sentence on why. Change nothing on GitHub.
`;

const TRIAGE_MCP = `{
  "mcpServers": {
    "github": {
      "type": "streamable-http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": {
        "Authorization": "Bearer \${GITHUB_TOKEN}",
        "X-MCP-Toolsets": "issues",
        "X-MCP-Readonly": "true"
      }
    }
  }
}
`;

const TRIAGE_RUNTIME = `{
  "kind": "virtual",
  "network": { "allowedHosts": [] },
  "secrets": {
    "GITHUB_TOKEN": {
      "type": "bearer",
      "url": "https://api.githubcopilot.com/mcp/",
      "description": "A GitHub token that may read issues, for GitHub's MCP server"
    }
  }
}
`;

describe("agent folders: what compiles", () => {
  it("compiles the smallest agent, one AGENT.md, into a manifest with no runtime section", () => {
    const result = compile({
      "AGENT.md": "---\nname: support\ndescription: Answers billing questions in two sentences or fewer.\n---\nYou answer questions about invoices and refunds. If a question is not about billing,\nsay so and stop.\n",
    });
    expect(errors(result.diagnostics)).toEqual([]);
    expect(result.compiler).toBe(AGENT_FOLDER_COMPILER);
    expect(result.manifest).toEqual({
      manifestSchemaVersion: 8,
      name: "support",
      description: "Answers billing questions in two sentences or fewer.",
      harness: {
        instructions: ["You answer questions about invoices and refunds. If a question is not about billing,\nsay so and stop."],
      },
    });
  });

  it("compiles triage as the three-file format saves it, apart from one instruction string per file", () => {
    const result = compile({ "AGENT.md": TRIAGE_AGENT, "mcp.json": TRIAGE_MCP, "runtime.json": TRIAGE_RUNTIME }, "triage");
    expect(errors(result.diagnostics)).toEqual([]);
    const threeFile = [
      "Triage the GitHub issue the user names as owner/repo#number. Read it, and its comments, with the github tools.",
      "Answer with one label (bug, feature, question or docs), a priority from p0 (urgent) to p3, and one sentence on why. Change nothing on GitHub.",
    ];
    const { instructions, ...harness } = result.manifest!.harness as { instructions: string[] };
    // The engine joins instructions with a blank line: the prompt is the same text, wrapped.
    expect(instructions.join("\n\n").replace(/(?<!\n)\n(?!\n)/g, " ")).toBe(threeFile.join("\n\n"));
    expect(harness).toEqual({
      mcpServers: {
        github: {
          name: "github",
          type: "streamable-http",
          url: "https://api.githubcopilot.com/mcp/",
          headers: { "X-MCP-Toolsets": "issues", "X-MCP-Readonly": "true" },
          credential: "GITHUB_TOKEN",
        },
      },
    });
    expect(result.manifest!.runtime).toEqual(JSON.parse(TRIAGE_RUNTIME));
  });

  it("derives a bearer slot for the server's URL when runtime.json declares none, and says where", () => {
    const result = compile({ "AGENT.md": TRIAGE_AGENT, "mcp.json": TRIAGE_MCP });
    expect(errors(result.diagnostics)).toEqual([]);
    expect(result.manifest!.runtime).toEqual({
      kind: "none",
      secrets: { GITHUB_TOKEN: { type: "bearer", url: "https://api.githubcopilot.com/mcp/", required: true } },
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ severity: "info", code: "slot_derived", file: "mcp.json", line: 7, column: 26, pointer: "/runtime/secrets/GITHUB_TOKEN" }),
    );
  });

  it("derives a headers slot from ${NAME} alone, naming the header it sets", () => {
    const result = compile({
      "AGENT.md": "---\nname: acme\ndescription: Uses Acme.\n---\n",
      "mcp.json": JSON.stringify({ mcpServers: { acme: { type: "sse", url: "https://mcp.acme.test/sse", headers: { "X-Api-Key": "${ACME_KEY}" } } } }),
    });
    expect(errors(result.diagnostics)).toEqual([]);
    expect(result.manifest!.harness).toMatchObject({ mcpServers: { acme: { credential: "ACME_KEY" } } });
    expect((result.manifest!.harness as { mcpServers: Record<string, object> }).mcpServers.acme).not.toHaveProperty("headers");
    expect(result.manifest!.runtime!.secrets!.ACME_KEY).toEqual({
      type: "headers",
      url: "https://mcp.acme.test/sse",
      required: true,
      description: "Sets the X-Api-Key header",
    });
  });

  it("takes this agent's server settings from AGENT.md", () => {
    const result = compile({
      "AGENT.md": `---\nname: triage\ndescription: Triage.\nmcpServers:\n  github:\n    deferred: true\n    tools: { "*": { enabled: false }, issue_read: { enabled: true } }\n---\nGo.\n`,
      "mcp.json": TRIAGE_MCP,
      "runtime.json": TRIAGE_RUNTIME,
    });
    expect(errors(result.diagnostics)).toEqual([]);
    expect(result.manifest!.harness).toMatchObject({
      mcpServers: { github: { deferred: true, tools: { "*": { enabled: false }, issue_read: { enabled: true } } } },
    });
  });

  it("compiles skills, tools with schema paths, triggers, files and instructions/", () => {
    const files = {
      "AGENT.md": `---\nname: writer\ndescription: Writes and checks the brief.\noutputSchema: /schemas/brief.json\nskills:\n  repo-brief: { secrets: [PUBLISH_TOKEN] }\nmemory: { access: read_only }\n---\nWrite the brief.\n`,
      "instructions/02-style.md": "\nKeep it short.\n\n",
      "instructions/01-tone.md": "Be plain.\n",
      "schemas/brief.json": `{ "type": "object", "properties": { "title": { "type": "string" } } }`,
      "skills/repo-brief/SKILL.md": "---\nname: repo-brief\ndescription: Write a repo brief.\n---\nWrite it.\n",
      "skills/repo-brief/scripts/check.sh": "#!/bin/sh\necho ok\n",
      "tools/now.json": `{\n  "description": "The current time.",\n  "http": { "url": "https://tools.example.com/now", "method": "POST", "credential": "TOOLS_TOKEN" },\n  "inputSchema": { "type": "object" },\n  "outputSchema": "./now.schema.json"\n}\n`,
      "now.schema.json": `{ "type": "object", "properties": { "iso": { "type": "string" } } }`,
      "triggers/nightly.md": `---\nschedule: "0 2 * * *"\ntimezone: Asia/Kolkata\nsession: new\n---\nWrite the nightly brief.\n`,
      "files/data/a.csv": "a,b\n1,2\n",
      "runtime.json": `{ "kind": "pod", "secrets": { "PUBLISH_TOKEN": { "type": "environment_secret", "allowedHosts": ["publish.example.com"] } } }`,
      "README.md": "Notes for people.\n",
    };
    const { hash } = folder(files);
    const result = compile(files);
    expect(errors(result.diagnostics)).toEqual([]);
    expect(result.manifest).toEqual({
      manifestSchemaVersion: 8,
      name: "writer",
      description: "Writes and checks the brief.",
      harness: {
        outputSchema: { type: "object", properties: { title: { type: "string" } } },
        memory: { access: "read_only" },
        instructions: ["Write the brief.", "Be plain.", "Keep it short."],
        skills: {
          "repo-brief": {
            name: "repo-brief",
            description: "Write a repo brief.",
            files: { "SKILL.md": hash("skills/repo-brief/SKILL.md"), "scripts/check.sh": hash("skills/repo-brief/scripts/check.sh") },
            secrets: ["PUBLISH_TOKEN"],
          },
        },
        tools: [
          {
            name: "now",
            description: "The current time.",
            inputSchema: { type: "object" },
            outputSchema: { type: "object", properties: { iso: { type: "string" } } },
            http: { url: "https://tools.example.com/now", method: "POST", credential: "TOOLS_TOKEN" },
          },
        ],
      },
      runtime: {
        kind: "pod",
        secrets: {
          PUBLISH_TOKEN: { type: "environment_secret", allowedHosts: ["publish.example.com"] },
          TOOLS_TOKEN: { type: "bearer", url: "https://tools.example.com/now", required: true },
        },
        triggers: { nightly: { schedule: "0 2 * * *", timezone: "Asia/Kolkata", session: "new", prompt: "Write the nightly brief." } },
        files: [{ path: "/workspace", files: { "data/a.csv": hash("files/data/a.csv") } }],
      },
    });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ severity: "note", code: "file_not_compiled", file: "README.md" }));
  });

  it("gives the same answer whatever order the entries come in", () => {
    const files = { "AGENT.md": TRIAGE_AGENT, "mcp.json": TRIAGE_MCP, "README.md": "x", "files/b.txt": "b", "files/a.txt": "a" };
    const { entries, files: text } = folder(files);
    const forward = compileAgentFolder({ entries, files: text });
    const backward = compileAgentFolder({ entries: [...entries].reverse(), files: text });
    expect(JSON.stringify(backward)).toBe(JSON.stringify(forward));
  });

  it("names the files it reads, and not the files it only hashes", () => {
    const { entries } = folder({
      "AGENT.md": "x",
      "runtime.json": "{}",
      "skills/a/SKILL.md": "x",
      "skills/a/notes/SKILL.md": "x",
      "skills/a/run.sh": "x",
      "files/big.bin": "x",
      "tools/t.json": "{}",
      "README.md": "x",
    });
    expect(folderTextPaths(entries)).toEqual(["AGENT.md", "runtime.json", "skills/a/SKILL.md", "tools/t.json"]);
  });
});

describe("agent folders: what is refused, with file, line and column", () => {
  it("names a typo in a tool file with its line, column and a fix", () => {
    const result = compile({
      "AGENT.md": "---\nname: shop\ndescription: Looks up orders.\n---\n",
      "tools/lookup_order.json": `{\n  "description": "One order.",\n  "inputSchema": { "type": "object" },\n  "http": {\n    "url": "https://shop.example.com/orders",\n    "methdo": "GET"\n  }\n}\n`,
    });
    expect(result.manifest).toBeUndefined();
    expect(errors(result.diagnostics)).toEqual([
      expect.objectContaining({
        code: "unknown_key",
        file: "tools/lookup_order.json",
        line: 6,
        column: 5,
        message: "Unknown key 'methdo'. Did you mean 'method'?",
        pointer: "/harness/tools/0/http/methdo",
      }),
    ]);
  });

  it('refuses Claude Code\'s "type": "http" with the fix', () => {
    const result = compile({
      "AGENT.md": TRIAGE_AGENT,
      "mcp.json": TRIAGE_MCP.replace('"streamable-http"', '"http"'),
    });
    expect(errors(result.diagnostics)).toEqual([
      expect.objectContaining({ code: "mcp_type", file: "mcp.json", line: 4, column: 15, message: expect.stringContaining('change it to "streamable-http"') }),
    ]);
  });

  it("refuses credentials it cannot bind", () => {
    const server = (headers: Record<string, string>, url = "https://mcp.example.com/") =>
      compile({ "AGENT.md": "---\nname: a\ndescription: b\n---\n", "mcp.json": JSON.stringify({ mcpServers: { s: { type: "sse", url, headers } } }) });
    expect(errors(server({ Authorization: "Bearer ${TOKEN:-dev}" }).diagnostics)[0]).toMatchObject({ code: "credential_default" });
    expect(errors(server({ Authorization: "Token ${TOKEN}" }).diagnostics)[0]).toMatchObject({ code: "credential_placement" });
    expect(errors(server({ "X-Key": "Bearer ${TOKEN}" }).diagnostics)[0]).toMatchObject({ code: "credential_placement" });
    expect(errors(server({ A: "${ONE}", B: "${TWO}" }).diagnostics)[0]).toMatchObject({ code: "credential_twice" });
    expect(errors(server({}, "https://mcp.example.com/${TENANT}").diagnostics)[0]).toMatchObject({ code: "credential_placement" });
  });

  it("refuses one credential name on two URLs, naming both", () => {
    const result = compile({
      "AGENT.md": "---\nname: shop\ndescription: Orders.\n---\n",
      "tools/get_order.json": `{ "inputSchema": { "type": "object" }, "http": { "url": "https://shop.example.com/orders/{id}", "credential": "SHOP" } }`,
      "tools/refund.json": `{ "inputSchema": { "type": "object" }, "http": { "url": "https://shop.example.com/refunds", "credential": "SHOP" } }`,
    });
    expect(errors(result.diagnostics)).toEqual([
      expect.objectContaining({ code: "credential_urls", file: "tools/refund.json", message: expect.stringContaining("tools/get_order.json") }),
    ]);
  });

  it("refuses secrets in SKILL.md, with the fix", () => {
    const result = compile({
      "AGENT.md": "---\nname: a\ndescription: b\n---\n",
      "skills/pub/SKILL.md": "---\nname: pub\ndescription: Publish.\nsecrets: [TOKEN]\n---\n",
    });
    expect(errors(result.diagnostics)).toEqual([
      expect.objectContaining({ code: "skill_secrets", file: "skills/pub/SKILL.md", line: 4, column: 1, message: expect.stringContaining("move it to AGENT.md") }),
    ]);
  });

  it("asks for quotes around a cron that starts with *", () => {
    const result = compile({
      "AGENT.md": "---\nname: a\ndescription: b\n---\n",
      "triggers/often.md": "---\nschedule: * * * * *\nsession: new\n---\nGo.\n",
    });
    expect(errors(result.diagnostics)[0]).toMatchObject({ code: "frontmatter_invalid", file: "triggers/often.md", line: 2, message: expect.stringContaining("must be quoted") });
  });

  it("checks triggers against the trigger schema, in their own file", () => {
    const result = compile({
      "AGENT.md": "---\nname: a\ndescription: b\n---\n",
      "triggers/both.md": "---\nschedule: \"0 2 * * *\"\nat: 2026-11-01T09:00:00+05:30\nsession: new\n---\nGo.\n",
    });
    expect(errors(result.diagnostics)).toEqual([
      expect.objectContaining({ code: "schema_invalid", file: "triggers/both.md", message: "A trigger has exactly one of schedule, at or webhook" }),
    ]);
  });

  it("refuses what an agent folder never holds, and what comes later", () => {
    const result = compile({
      "AGENT.md": "---\nname: a\ndescription: b\n---\n",
      ".env": "TOKEN=x",
      "deploy.pem": "x",
      "flow.json": "{}",
      "agents/x/AGENT.md": "x",
      "plugins/p/plugin.json": "{}",
      "runtime.yaml": "kind: none",
      "tools/notes.txt": "x",
    });
    const byFile = Object.fromEntries(errors(result.diagnostics).map((item) => [item.file, item.code]));
    expect(byFile).toEqual({
      ".env": "secret_file",
      "deploy.pem": "secret_file",
      "flow.json": "not_supported",
      "agents/x/AGENT.md": "not_supported",
      "plugins/p/plugin.json": "not_supported",
      "runtime.yaml": "wrong_syntax",
      "tools/notes.txt": "reserved_directory",
    });
  });

  it("refuses paths that leave the folder or collide", () => {
    const result = compile({ "AGENT.md": "---\nname: a\ndescription: b\n---\n", "files/A.txt": "1", "files/a.txt": "2", "files/../x": "3" });
    expect(errors(result.diagnostics).map((item) => item.code).sort()).toEqual(["path_case", "path_invalid"]);
  });

  it("needs AGENT.md with a name that matches, and suggests a key for a typo", () => {
    expect(errors(compile({ "README.md": "x" }).diagnostics)[0]).toMatchObject({ code: "agent_missing" });
    expect(errors(compile({ "AGENT.md": "---\nname: a\ndescription: b\n---\n" }, "b").diagnostics)[0]).toMatchObject({
      code: "name_mismatch",
      file: "AGENT.md",
      line: 2,
    });
    expect(errors(compile({ "AGENT.md": "---\nname: a\ndescription: b\nharnes: nylorun\n---\n" }).diagnostics)[0]).toMatchObject({
      code: "unknown_key",
      line: 4,
      message: "Unknown key 'harnes'. Did you mean 'harness'?",
    });
  });

  it("reads strict JSON only", () => {
    const run = (json: string) => errors(compile({ "AGENT.md": "---\nname: a\ndescription: b\n---\n", "runtime.json": json }).diagnostics)[0];
    expect(run('{\n  // a comment\n  "kind": "none"\n}')).toMatchObject({ code: "json_invalid", line: 2, column: 3, message: expect.stringContaining("Comments are not JSON") });
    expect(run('{ "kind": "none", }')).toMatchObject({ code: "json_invalid", message: "A trailing comma is not JSON" });
    expect(run('{ "kind": "none", "kind": "pod" }')).toMatchObject({ code: "json_invalid", message: 'The key "kind" appears twice in one object' });
    expect(run('{ "$schema": "https://example.com/runtime.json", "kind": "none" }')).toMatchObject({ code: "schema_key" });
  });

  it("refuses frontmatter aliases and tags", () => {
    expect(errors(compile({ "AGENT.md": "---\nname: &n a\ndescription: b\n---\n" }).diagnostics)[0]).toMatchObject({ code: "frontmatter_invalid" });
    expect(errors(compile({ "AGENT.md": "---\nname: !!str a\ndescription: b\n---\n" }).diagnostics)[0]).toMatchObject({ code: "frontmatter_invalid" });
  });

  it("maps a schema error back to the file that wrote the field", () => {
    const result = compile({ "AGENT.md": "---\nname: a\ndescription: b\n---\n", "runtime.json": `{\n  "kind": "cluster"\n}` });
    expect(errors(result.diagnostics)).toEqual([expect.objectContaining({ code: "schema_invalid", file: "runtime.json", line: 2, column: 11, pointer: "/runtime/kind" })]);
  });
});
