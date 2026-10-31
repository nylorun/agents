import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { RuntimeSectionSchema, TriggerSchema } from "../src/contracts.js";
import {
  AGENT_FOLDER_SCHEMA_KINDS,
  agentFolderJsonSchemas,
  compileAgentFolder,
  folderTextPaths,
  type AgentFolderEntry,
  type AgentFolderSchemaKind,
} from "../src/folder/index.js";
import {
  AGENT_KEYS,
  FOLDER_SCHEMAS,
  MCP_KEYS,
  PLUGIN_SERVER_SETTING_KEYS,
  SCHEMA_URLS,
  SERVER_KEYS,
  SERVER_SETTING_KEYS,
  TOOL_KEYS,
  TRIGGER_KEYS,
} from "../src/folder/compile.js";
import { LOOP_KEYS, MAP_KEYS, NODE_KINDS, SWITCH_KEYS, VERIFY_KEYS } from "../src/folder/flow.js";
import { parseMarkdown } from "../src/folder/frontmatter.js";
import { jsonSchemaIssues } from "../src/folder/json-schema.js";
import { schemaErrors } from "./support/json-schema-instances.js";

/** The JSON Schema of each kind of file in an agent folder (track T7, design §3.10). */

type Json = Record<string, unknown>;

const SCHEMAS = agentFolderJsonSchemas();
const encoder = new TextEncoder();
const repo = fileURLToPath(new URL("../../", import.meta.url));

/** The kind of a path in an agent folder, inside `agents/<id>/` too; undefined for one with no schema. */
function kindOf(path: string): AgentFolderSchemaKind | undefined {
  const segments = path.split("/");
  if (segments[0] === "plugins") return undefined;
  if (segments[0] === "agents" && segments.length > 2) return kindOf(segments.slice(2).join("/"));
  if (path === "AGENT.md") return "agent-md";
  if (path === "runtime.json") return "runtime";
  if (path === "mcp.json") return "mcp";
  if (path === "flow.json") return "flow";
  if (segments.length === 2 && segments[0] === "tools" && path.endsWith(".json")) return "tool";
  if (segments.length === 2 && segments[0] === "triggers" && path.endsWith(".md")) return "trigger-md";
  return undefined;
}

/** What a file of `kind` holds for its schema: its frontmatter, or its JSON. */
function instanceOf(kind: AgentFolderSchemaKind, text: string): unknown {
  if (!kind.endsWith("-md")) return JSON.parse(text);
  const parsed = parseMarkdown(text);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.data;
}

/** Each file of a folder that has a schema, with what its schema finds in it. */
function validateFolder(files: Readonly<Record<string, string>>) {
  return Object.entries(files).flatMap(([path, text]) => {
    const kind = kindOf(path);
    return kind ? [{ path, kind, errors: schemaErrors(SCHEMAS[kind], instanceOf(kind, text)) }] : [];
  });
}

function compile(files: Readonly<Record<string, string>>) {
  const entries: AgentFolderEntry[] = [];
  const bytes = new Map<string, Uint8Array>();
  for (const [path, content] of Object.entries(files)) {
    const data = encoder.encode(content);
    entries.push({ path, size: data.byteLength, sha256: bytesToHex(sha256(data)) });
    bytes.set(path, data);
  }
  return compileAgentFolder({ entries, files: new Map(folderTextPaths(entries).map((path) => [path, bytes.get(path)!])) });
}

/** Every file under `dir`, by its path from there. */
function readTree(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const full = join(at, name);
      if (statSync(full).isDirectory()) walk(full);
      else files[relative(dir, full).split("\\").join("/")] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return files;
}

const keysOf = (schema: unknown) => Object.keys(((schema as Json).properties ?? {}) as Json).sort();
const sorted = (keys: readonly string[]) => [...keys].sort();
const defsOf = (kind: AgentFolderSchemaKind) => SCHEMAS[kind].$defs as Record<string, Json>;

/** An agent with every key a folder's files take. */
const ORDERS = {
  "AGENT.md": `---
name: orders
description: Answers questions about orders.
format: 1
harness: nylorun
outputSchema: ./output.schema.json
mcpServers:
  github:
    deferred: true
    tools:
      "*":
        enabled: false
      list_issues:
        enabled: true
        deferred: false
skills:
  order-notes:
    secrets: [NOTES_TOKEN]
memory:
  access: read_only
  instructions: Remember each customer's preferred tone.
loop: {}
metadata:
  team: support
---
Answer questions about orders.
`,
  "output.schema.json": JSON.stringify({ type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }),
  "schemas/order.json": JSON.stringify({ type: "object", properties: { id: { type: "string" } }, required: ["id"] }),
  "runtime.json": JSON.stringify({
    $schema: `${FOLDER_SCHEMAS}runtime.json`,
    kind: "virtual",
    network: { allowedHosts: ["api.github.com"] },
    secrets: { NOTES_TOKEN: { type: "environment_variable", description: "Read by the order-notes skill" } },
    selfWake: true,
  }),
  "mcp.json": JSON.stringify({
    $schema: `${FOLDER_SCHEMAS}mcp.json`,
    mcpServers: {
      github: {
        type: "streamable-http",
        url: "https://api.githubcopilot.com/mcp/",
        headers: { Authorization: "Bearer ${GITHUB_TOKEN}", "X-MCP-Readonly": "true" },
      },
    },
  }),
  "tools/get_order.json": JSON.stringify({
    $schema: `${FOLDER_SCHEMAS}tool.json`,
    description: "Look up an order by its id.",
    inputSchema: "./schemas/order.json",
    outputSchema: { type: "object", properties: { status: { type: "string" } } },
    http: { url: "https://orders.example.com/orders/{id}", method: "GET", credential: "ORDERS_TOKEN", timeoutMs: 5000 },
  }),
  "triggers/daily.md": "---\nschedule: 0 9 * * 1-5\ntimezone: Asia/Kolkata\nsession: daily\n---\nSummarize yesterday's orders.\n",
  "triggers/hook.md": "---\nwebhook: standard-webhooks\nsession: new\n---\nTriage the order in the event.\n",
  "triggers/once.md": "---\nat: 2026-11-01T09:00:00+05:30\nsession: launch\n---\nCheck the launch orders.\n",
  "skills/order-notes/SKILL.md": "---\nname: order-notes\ndescription: Notes on orders.\n---\nRead the notes.\n",
};

/** A flow with every kind of node, both kinds of verifier and an inline inputSchema. */
const PIPELINE = {
  "AGENT.md": `---\nname: pipeline\ndescription: Writes and publishes a brief.\ninputSchema:\n  type: object\n  properties:\n    topic:\n      type: string\n---\n`,
  "flow.json": JSON.stringify({
    $schema: `${FOLDER_SCHEMAS}flow.json`,
    chain: [
      { agent: "triage" },
      { id: "route", switch: { cases: { many: { map: { each: { agent: "writer" } } } }, default: { agent: "writer" } } },
      { id: "review", parallel: { edit: { agent: "editor" }, publish: { tool: "publish" } } },
      { loop: { run: { agent: "writer" }, verify: { tool: "check" }, max: 2 } },
      { loop: { run: { agent: "writer" }, verify: { agent: "editor", id: "judge" }, max: 1 } },
    ],
  }),
  "tools/publish.json": JSON.stringify({ inputSchema: { type: "object" }, http: { url: "https://cms.example.com/publish" } }),
  "tools/check.json": JSON.stringify({ inputSchema: { type: "object" }, http: { url: "https://cms.example.com/check", method: "POST" } }),
  "agents/triage/AGENT.md": "---\nname: triage\ndescription: Routes the request.\noutputSchema:\n  type: object\n  properties:\n    route:\n      type: string\n  required: [route]\n---\nRoute it.\n",
  "agents/writer/AGENT.md": "---\nname: writer\ndescription: Writes the brief.\n---\nWrite it.\n",
  "agents/editor/AGENT.md": "---\nname: editor\ndescription: Checks the brief.\n---\nCheck it.\n",
};

describe("agent folder JSON Schemas", () => {
  it("are JSON Schema 2020-12 documents the engine reads, one per kind of file", () => {
    expect(Object.keys(SCHEMAS)).toEqual([...AGENT_FOLDER_SCHEMA_KINDS]);
    for (const [kind, schema] of Object.entries(SCHEMAS)) {
      expect(schema.$schema, kind).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(jsonSchemaIssues(schema), kind).toEqual([]);
    }
  });

  it("are published at the $id the compiler takes in $schema and nylorun init maps", () => {
    // AGENT.md gained `model` within format 1: its document is revision 1.
    for (const kind of AGENT_FOLDER_SCHEMA_KINDS)
      expect(SCHEMAS[kind].$id).toBe(`https://docs.nylorun.com/schemas/agent-folder/v1/${kind}${kind === "agent-md" ? ".1" : ""}.json`);
    for (const [kind, urls] of Object.entries(SCHEMA_URLS)) expect(urls[0], kind).toBe(SCHEMAS[kind as keyof typeof SCHEMA_URLS].$id);
    // A JSON file naming its own schema compiles with no schema_url warning.
    const compiled = compile(ORDERS);
    expect(compiled.diagnostics.filter((item) => item.code === "schema_url")).toEqual([]);
  });

  it("are exported as @nylorun/core/schemas/agent-folder-<kind>.json, which the docs site publishes", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { exports: Record<string, unknown> };
    for (const kind of AGENT_FOLDER_SCHEMA_KINDS) {
      const name = `./schemas/agent-folder-${kind}.json`;
      expect(pkg.exports[name]).toBe(`./dist/schemas/agent-folder/${kind}.schema.json`);
      // nylorun/web's docs-site/scripts/sync-schemas.mjs publishes the exports this matches.
      expect(name).toMatch(/^\.\/schemas\/[^/]+\.json$/);
    }
  });

  it("validate the example folders", () => {
    const checked = new Set<string>();
    for (const name of readdirSync(join(repo, "examples/agents"))) {
      const dir = join(repo, "examples/agents", name);
      if (!statSync(join(dir, "AGENT.md"), { throwIfNoEntry: false })?.isFile()) continue;
      for (const { path, kind, errors } of validateFolder(readTree(dir))) {
        expect(errors, `examples/agents/${name}/${path}`).toEqual([]);
        checked.add(kind);
      }
    }
    expect([...checked].sort()).toEqual(["agent-md", "flow", "mcp", "runtime", "tool"]);
  });

  it("validate a folder with every key, and a flow with every kind of node, that compile", () => {
    for (const files of [ORDERS, PIPELINE]) {
      expect(compile(files).diagnostics.filter((item) => item.severity === "error")).toEqual([]);
      const results = validateFolder(files);
      for (const { path, errors } of results) expect(errors, path).toEqual([]);
    }
    expect(new Set(validateFolder({ ...ORDERS, ...PIPELINE }).map((item) => item.kind))).toEqual(new Set(AGENT_FOLDER_SCHEMA_KINDS));
  });

  it("refuse what the compiler refuses", () => {
    const refused: [AgentFolderSchemaKind, unknown][] = [
      ["agent-md", { name: "a", description: "A." , approval: "always" }],
      ["agent-md", { name: "a", description: "A.", format: 2 }],
      ["agent-md", { description: "A." }],
      ["agent-md", { name: "a", description: "A.", mcpServers: { github: { approval: "never" } } }],
      ["agent-md", { name: "a", description: "A.", mcpServers: { github: { tools: { list: { approval: "never" } } } } }],
      ["agent-md", { name: "a", description: "A.", skills: { notes: { secrets: ["not a name"] } } }],
      ["agent-md", { name: "a", description: "A.", memory: { acess: "read_only" } }],
      ["trigger-md", { schedule: "0 9 * * *", at: "2026-11-01T09:00:00Z", session: "s" }],
      ["trigger-md", { at: "2026-11-01T09:00:00Z", timezone: "UTC", session: "s" }],
      ["trigger-md", { schedule: "0 9 * * *" }],
      ["trigger-md", { schedule: "0 9 * * *", session: "s", prompt: "Go." }],
      ["runtime", {}],
      ["runtime", { kind: "virtal" }],
      ["runtime", { kind: "virtual", bogus: true }],
      ["runtime", { kind: "none", triggers: { t: { schedule: "0 9 * * *", webhook: "standard-webhooks", session: "s", prompt: "Go." } } }],
      ["tool", { name: "t", inputSchema: {}, http: { url: "https://x.example.com" } }],
      ["tool", { inputSchema: {}, http: { url: "https://x.example.com" }, approval: "always" }],
      ["tool", { http: { url: "https://x.example.com" } }],
      ["mcp", { mcpServers: { s: { type: "http", url: "https://x.example.com" } } }],
      ["mcp", { mcpServers: { s: { type: "sse", url: "https://x.example.com/${TOKEN}" } } }],
      ["mcp", { mcpServers: { "bad name": { type: "sse", url: "https://x.example.com" } } }],
      ["mcp", { servers: {} }],
      ["flow", { agent: "a", tool: "b" }],
      ["flow", { chain: [] }],
      ["flow", { chain: [{ $schema: `${FOLDER_SCHEMAS}flow.json`, agent: "a" }] }],
      ["flow", { loop: { run: { agent: "a" }, verify: { http: { url: "https://x.example.com" } }, max: 1 } }],
      ["flow", { loop: { run: { agent: "a" }, verify: { tool: "t", id: "v" }, max: 1 } }],
      ["flow", { loop: { run: { agent: "a" }, verify: { agent: "b" }, max: 0 } }],
      ["flow", { switch: { cases: { a: { agent: "a" } }, fallback: { agent: "b" } } }],
      ["flow", { parallel: {} }],
      ["flow", { map: { each: { agent: "a" }, limit: 2 } }],
    ];
    for (const [kind, instance] of refused) expect(schemaErrors(SCHEMAS[kind], instance), `${kind} ${JSON.stringify(instance)}`).not.toEqual([]);
    // What extends leaves to the file it names.
    expect(schemaErrors(SCHEMAS.runtime, { extends: "../../platform/pod.runtime.json", image: "ghcr.io/acme/agent:1" })).toEqual([]);
  });

  it("name exactly the keys the compiler takes", () => {
    expect(keysOf(SCHEMAS["agent-md"])).toEqual(sorted(AGENT_KEYS));
    expect(keysOf(defsOf("agent-md").McpServerSettings)).toEqual(sorted(PLUGIN_SERVER_SETTING_KEYS));
    expect(SERVER_SETTING_KEYS.every((key) => PLUGIN_SERVER_SETTING_KEYS.includes(key))).toBe(true);
    expect(keysOf(SCHEMAS["trigger-md"])).toEqual(sorted(TRIGGER_KEYS));
    expect(sorted([...TRIGGER_KEYS, "prompt"])).toEqual(sorted(Object.keys(TriggerSchema.shape)));
    expect(keysOf(SCHEMAS.runtime)).toEqual(sorted([...Object.keys(RuntimeSectionSchema.shape), "$schema", "extends"]));
    expect(keysOf(SCHEMAS.tool)).toEqual(sorted([...TOOL_KEYS, "$schema"]));
    expect(keysOf(SCHEMAS.mcp)).toEqual(sorted(MCP_KEYS));
    expect(keysOf(defsOf("mcp").McpServer)).toEqual(sorted(SERVER_KEYS));

    const flow = defsOf("flow");
    const nodes = (flow.Node!.oneOf as Json[]).map((branch) => flow[String(branch.$ref).slice("#/$defs/".length)]!);
    expect(nodes.map((node) => keysOf(node).filter((key) => key !== "id"))).toEqual(NODE_KINDS.map((kind) => [kind]));
    for (const node of nodes) expect(keysOf(node)).toContain("id");
    const body = (kind: string) => ((flow[`${kind[0]!.toUpperCase()}${kind.slice(1)}Node`]!.properties as Json)[kind]) as Json;
    expect(keysOf(body("switch"))).toEqual(sorted(SWITCH_KEYS));
    expect(keysOf(body("map"))).toEqual(sorted(MAP_KEYS));
    expect(keysOf(body("loop"))).toEqual(sorted(LOOP_KEYS));
    expect(sorted([...new Set((flow.Verifier!.oneOf as Json[]).flatMap(keysOf))])).toEqual(sorted(VERIFY_KEYS));
  });
});
