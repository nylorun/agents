/**
 * The checks that make `check` the whole verdict that needs no Runtime: JSON Schemas, cron and
 * time zones, the sections against each other and the runtime's kind, approval, secrets as
 * warnings, the compiler's own wording, CRLF, natural order and `$schema`.
 */
import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { cronScheduleIssue, isTimeZone, sectionGapsAt } from "../src/define.js";
import { compileAgentFolder, folderTextPaths, type AgentFolderDiagnostic, type AgentFolderEntry } from "../src/folder/index.js";

const encoder = new TextEncoder();

function compile(files: Record<string, string>) {
  const entries: AgentFolderEntry[] = [];
  const bytes = new Map<string, Uint8Array>();
  for (const [path, content] of Object.entries(files)) {
    const data = encoder.encode(content);
    entries.push({ path, size: data.byteLength, sha256: bytesToHex(sha256(data)) });
    bytes.set(path, data);
  }
  return compileAgentFolder({ entries, files: new Map(folderTextPaths(entries).map((path) => [path, bytes.get(path)!])) });
}

const errors = (diagnostics: readonly AgentFolderDiagnostic[]) => diagnostics.filter((item) => item.severity === "error");
const warnings = (diagnostics: readonly AgentFolderDiagnostic[]) => diagnostics.filter((item) => item.severity === "warning");

const AGENT = "---\nname: shop\ndescription: Looks up orders.\n---\nLook up the order the user names.\n";
const tool = (inputSchema: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ description: "One order.", inputSchema, http: { url: "https://shop.example.com/orders" }, ...extra }, null, 2);
/** A token-shaped string, built so the source holds none. */
const fakeToken = (prefix: string) => `${prefix}${"a1B2c3D4e5".repeat(4)}`;

describe("agent folders: JSON Schemas are checked as JSON Schema and as the engine reads them", () => {
  it("refuses a type that is not a JSON Schema type, at its line and column, with a did-you-mean", () => {
    const result = compile({
      "AGENT.md": AGENT,
      "tools/get_order.json": `{\n  "inputSchema": {\n    "type": "objekt",\n    "properties": { "id": { "type": "string" } }\n  },\n  "http": { "url": "https://shop.example.com/orders" }\n}\n`,
    });
    expect(result.manifest).toBeUndefined();
    expect(errors(result.diagnostics)).toEqual([
      expect.objectContaining({
        code: "json_schema_invalid",
        file: "tools/get_order.json",
        line: 3,
        column: 13,
        pointer: "/harness/tools/0/inputSchema/type",
        message: "type \"objekt\" is not a JSON Schema type. Did you mean 'object'? The types are null, boolean, object, array, number, string and integer",
      }),
    ]);
  });

  it("checks an outputSchema in AGENT.md's frontmatter, and nested schemas everywhere", () => {
    const result = compile({
      "AGENT.md": "---\nname: shop\ndescription: Orders.\noutputSchema:\n  type: object\n  properties:\n    total: { type: numbr }\n---\nAnswer.\n",
    });
    expect(errors(result.diagnostics)).toEqual([
      expect.objectContaining({ code: "json_schema_invalid", file: "AGENT.md", line: 7, column: 20, message: expect.stringContaining("Did you mean 'number'?") }),
    ]);
  });

  it("names every shape problem in a schema file in one pass", () => {
    const schema = `{
  "type": "object",
  "properties": {
    "lines": { "type": "array", "items": { "type": "strin" } },
    "note": { "anyOf": [{ "type": "string" }, { "type": "nul" }] },
    "meta": { "type": "object", "additionalProperties": { "type": "texte" } },
    "tags": { "type": "object", "properties": [] },
    "ref": { "$ref": "#/$defs/missing" }
  },
  "required": "lines",
  "$defs": { "money": { "type": "number", "minimum": "0" } }
}`;
    const result = compile({ "AGENT.md": AGENT, "tools/get_order.json": tool("/schemas/order.json"), "schemas/order.json": schema });
    const found = errors(result.diagnostics).map((item) => [item.file, item.line, item.code]);
    expect(found).toEqual([
      ["schemas/order.json", 4, "json_schema_invalid"],
      ["schemas/order.json", 5, "json_schema_invalid"],
      ["schemas/order.json", 6, "json_schema_invalid"],
      ["schemas/order.json", 7, "json_schema_invalid"],
      ["schemas/order.json", 8, "json_schema_invalid"],
      ["schemas/order.json", 10, "json_schema_invalid"],
      ["schemas/order.json", 11, "json_schema_invalid"],
    ]);
    expect(errors(result.diagnostics).find((item) => item.line === 10)!.message).toContain("required is a list of property names");
    expect(errors(result.diagnostics).find((item) => item.line === 7)!.message).toContain("properties is a map of property names to schemas");
  });

  it("refuses required entries that are not names, and what the engine cannot use", () => {
    const run = (schema: unknown) => errors(compile({ "AGENT.md": AGENT, "tools/t.json": tool(schema) }).diagnostics).map((item) => item.message);
    expect(run({ type: "object", required: [1] })[0]).toContain("required lists property names, which are strings");
    expect(run({ type: "object", if: { type: "object" }, then: { required: ["a"] } })[0]).toContain("if is JSON Schema, but the engine cannot use it");
    expect(run({ type: "object", properties: { a: { $ref: "#/definitions/a" } }, definitions: { a: { type: "string" } } })[0]).toContain(
      "resolves a $ref to the schema itself (#) or to one of its $defs",
    );
    expect(run({ type: "object", properties: { a: { $ref: "https://example.com/a.json" } } })[0]).toContain("names another document");
    expect(run({ type: "object", properties: { a: { type: "string", pattern: "([" } } })[0]).toContain("is not a regular expression");
  });

  it("only warns on an unknown keyword close to a known one, and compiles", () => {
    const result = compile({ "AGENT.md": AGENT, "tools/t.json": tool({ type: "object", proprties: { id: { type: "string" } }, "x-note": 1 }) });
    expect(errors(result.diagnostics)).toEqual([]);
    expect(result.manifest).toBeDefined();
    expect(warnings(result.diagnostics)).toEqual([
      expect.objectContaining({ code: "json_schema_keyword", file: "tools/t.json", message: expect.stringContaining("Did you mean 'properties'?") }),
    ]);
  });
});

describe("agent folders: approval is tool policy", () => {
  it("refuses approval in AGENT.md, a tool file, mcp.json and an MCP tool's settings, naming tool policy", () => {
    const result = compile({
      "AGENT.md": "---\nname: shop\ndescription: Orders.\napproval: always\nmcpServers:\n  github:\n    tools:\n      issue_write: { approval: always }\n---\nGo.\n",
      "tools/refund.json": tool({ type: "object" }, { approval: "always" }),
      "mcp.json": JSON.stringify({ mcpServers: { github: { type: "streamable-http", url: "https://api.githubcopilot.com/mcp/", approval: "always" } } }, null, 2),
    });
    const refused = errors(result.diagnostics);
    expect(refused.map((item) => [item.code, item.file, item.line])).toEqual([
      ["approval_removed", "AGENT.md", 4],
      ["approval_removed", "AGENT.md", 8],
      ["approval_removed", "mcp.json", 6],
      ["approval_removed", "tools/refund.json", 9],
    ]);
    for (const item of refused) expect(item.message).toContain("nylorun tenant tool-policy");
  });
});

describe("agent folders: triggers' cron and time zones", () => {
  const trigger = (front: string) => compile({ "AGENT.md": AGENT, "triggers/nightly.md": `---\n${front}session: new\n---\nWrite the nightly report.\n` });

  it("refuses a cron the Runtime would refuse, at the schedule's line", () => {
    const result = trigger('schedule: "0 25 * * *"\n');
    expect(errors(result.diagnostics)).toEqual([
      expect.objectContaining({ code: "schedule_invalid", file: "triggers/nightly.md", line: 2, column: 11, message: 'schedule "0 25 * * *": the hour is 0-23, and 25 is not' }),
    ]);
    expect(errors(trigger('schedule: "0 9 * * MONDAY"\n').diagnostics)[0]!.message).toContain("Did you mean MON?");
    expect(errors(trigger('schedule: "0 0 31 2 *"\n').diagnostics)[0]!.message).toContain("never runs");
  });

  it("refuses a time zone that is not an IANA name, with a did-you-mean", () => {
    const result = trigger('schedule: "0 2 * * *"\ntimezone: Asia/Kolkatta\n');
    expect(errors(result.diagnostics)).toEqual([
      expect.objectContaining({ code: "timezone_invalid", file: "triggers/nightly.md", line: 3, column: 11, message: expect.stringContaining("Did you mean 'Asia/Kolkata'?") }),
    ]);
  });

  it("checks triggers declared in runtime.json too", () => {
    const result = compile({
      "AGENT.md": AGENT,
      "runtime.json": `{\n  "kind": "none",\n  "triggers": {\n    "hourly": { "schedule": "60 * * * *", "timezone": "Mars/Base", "session": "new", "prompt": "Go." }\n  }\n}\n`,
    });
    expect(errors(result.diagnostics).map((item) => [item.code, item.file, item.line])).toEqual([
      ["schedule_invalid", "runtime.json", 4],
      ["timezone_invalid", "runtime.json", 4],
    ]);
  });

  it("reads five-field crons as the Runtime does", () => {
    for (const valid of ["0 2 * * *", "*/15 9-17 * * MON-FRI", "0 9 * * mon,wed", "0 0 L * *", "0 9 * * 1#2", "0 9 * * 5L", "0 0 1 JAN-MAR/2 *", "0 0 ? * 7", "5/10 * * * *"])
      expect(cronScheduleIssue(valid), valid).toBeUndefined();
    for (const invalid of ["* * * *", "60 * * * *", "0 0 0 * *", "0 0 * 13 *", "0 0 * * 8", "5-1 * * * *", "*/0 * * * *", "1,,2 * * * *", "0 0 15W * *", "0 0 * * L", "0 0 * * 0#6", "@daily"])
      expect(cronScheduleIssue(invalid), invalid).toBeDefined();
    expect(isTimeZone("Asia/Kolkata")).toBe(true);
    expect(isTimeZone("Mars/Base")).toBe(false);
  });
});

describe("agent folders: the runtime's kind and the save checks, with positions", () => {
  it("refuses files/ when the runtime has no disk, at the files/ entry", () => {
    const result = compile({ "AGENT.md": AGENT, "files/data.csv": "a,b\n" });
    expect(errors(result.diagnostics)).toEqual([
      expect.objectContaining({ code: "runtime_kind", file: "files/data.csv", pointer: "/runtime/files", message: expect.stringContaining('add runtime.json with "kind": "pod"') }),
    ]);
    const virtual = compile({ "AGENT.md": AGENT, "files/data.csv": "a,b\n", "runtime.json": '{ "kind": "virtual" }' });
    expect(errors(virtual.diagnostics)[0]).toMatchObject({ code: "runtime_kind", file: "files/data.csv", message: expect.stringContaining('set "kind": "pod" in runtime.json') });
  });

  it("refuses a sandbox field on kind none, at its key", () => {
    const result = compile({ "AGENT.md": AGENT, "runtime.json": '{\n  "kind": "none",\n  "network": { "allowedHosts": ["api.example.com"] }\n}\n' });
    expect(errors(result.diagnostics)).toEqual([expect.objectContaining({ code: "runtime_kind", file: "runtime.json", line: 3, column: 3, pointer: "/runtime/network" })]);
  });

  it("refuses skills with no sandbox, at the skill or at runtime.json's kind", () => {
    const skill = { "skills/brief/SKILL.md": "---\nname: brief\ndescription: Write a brief.\n---\nWrite it.\n" };
    const bare = compile({ "AGENT.md": AGENT, ...skill });
    expect(errors(bare.diagnostics)).toEqual([
      expect.objectContaining({
        code: "manifest_inconsistent",
        file: "skills/brief/SKILL.md",
        pointer: "/harness/skills",
        message: expect.stringContaining('harness.skills needs a sandbox; the manifest has no runtime section, so an Agent made from it has none. Fix: add runtime.json with "kind": "virtual"'),
      }),
    ]);
    const none = compile({ "AGENT.md": AGENT, ...skill, "runtime.json": '{\n  "kind": "none"\n}\n' });
    expect(errors(none.diagnostics)).toEqual([expect.objectContaining({ code: "manifest_inconsistent", file: "runtime.json", line: 2, column: 11 })]);
    expect(errors(compile({ "AGENT.md": AGENT, ...skill, "runtime.json": '{ "kind": "virtual" }' }).diagnostics)).toEqual([]);
  });

  it("refuses a custom harness off a pod, at AGENT.md's harness", () => {
    const result = compile({ "AGENT.md": "---\nname: shop\ndescription: Orders.\nharness: workflow\n---\nGo.\n" });
    expect(errors(result.diagnostics)).toEqual([
      expect.objectContaining({
        code: "manifest_inconsistent",
        file: "AGENT.md",
        line: 4,
        column: 10,
        pointer: "/harness/id",
        message: expect.stringContaining('harness.id "workflow" needs runtime.kind "pod"; the manifest has no runtime section. Fix: add runtime.json'),
      }),
    ]);
    const imageless = compile({ "AGENT.md": "---\nname: shop\ndescription: Orders.\nharness: acme-loop\n---\nGo.\n", "runtime.json": '{ "kind": "pod" }' });
    expect(errors(imageless.diagnostics)[0]!.message).toContain('needs runtime.image: a custom harness runs from its pod\'s image. Fix: add "image" to runtime.json');
  });

  it("points a credential bound to another URL at the header that names it", () => {
    const result = compile({
      "AGENT.md": AGENT,
      "mcp.json": `{\n  "mcpServers": {\n    "github": {\n      "type": "streamable-http",\n      "url": "https://api.githubcopilot.com/mcp/",\n      "headers": { "Authorization": "Bearer \${GITHUB_TOKEN}" }\n    }\n  }\n}\n`,
      "runtime.json": JSON.stringify({ kind: "none", secrets: { GITHUB_TOKEN: { type: "bearer", url: "https://api.github.com/" } } }),
    });
    expect(errors(result.diagnostics)).toEqual([
      expect.objectContaining({ code: "manifest_inconsistent", file: "mcp.json", line: 6, column: 37, pointer: "/harness/mcpServers/github/credential" }),
    ]);
  });

  it("gives each gap the manifest path it is about", () => {
    const gaps = sectionGapsAt({
      harness: { tools: [{ name: "a", inputSchema: { type: "object" }, http: { url: "https://x.example/a", credential: "NOPE" } }] },
      runtime: { kind: "none" },
    });
    expect(gaps).toEqual([{ path: ["harness", "tools", 0, "http", "credential"], message: 'harness.tools.a.http.credential "NOPE" is not a secret slot in runtime.secrets' }]);
  });
});

describe("agent folders: secrets warn, and the folder still compiles", () => {
  const server = (headers: Record<string, string>) =>
    compile({ "AGENT.md": AGENT, "mcp.json": JSON.stringify({ mcpServers: { github: { type: "streamable-http", url: "https://api.githubcopilot.com/mcp/", headers } } }, null, 2) });

  it("warns on a literal token in an Authorization header, and compiles it as written", () => {
    const token = fakeToken("ghp_");
    const result = server({ Authorization: `Bearer ${token}` });
    expect(errors(result.diagnostics)).toEqual([]);
    expect(warnings(result.diagnostics)).toEqual([
      expect.objectContaining({ code: "secret_literal", file: "mcp.json", line: 7, column: 26, message: expect.stringContaining("looks like a GitHub token (ghp_…)") }),
    ]);
    const [warning] = warnings(result.diagnostics);
    expect(warning!.message).toContain("readable by anyone with agents:read");
    expect(warning!.message).toContain('"Bearer ${NAME}"');
    expect((result.manifest!.harness as { mcpServers: Record<string, { headers: object }> }).mcpServers.github.headers).toEqual({ Authorization: `Bearer ${token}` });
  });

  it("warns on any literal authentication header, and on token shapes in any header", () => {
    expect(warnings(server({ "X-Api-Key": "hunter2" }).diagnostics)[0]).toMatchObject({ code: "secret_literal", message: expect.stringContaining('a literal value, not a ${NAME} slot') });
    expect(warnings(server({ "Cookie": "session=abc" }).diagnostics)[0]).toMatchObject({ code: "secret_literal", message: expect.stringContaining('write "${NAME}"') });
    expect(warnings(server({ "X-Linear-Token": "abc" }).diagnostics)[0]).toMatchObject({ code: "secret_literal" });
    expect(warnings(server({ "X-Extra": `${fakeToken("sk-")}` }).diagnostics)[0]).toMatchObject({ message: expect.stringContaining("an API key (sk-…)") });
    expect(warnings(server({ "X-Extra": `${fakeToken("xoxb-")}` }).diagnostics)[0]).toMatchObject({ message: expect.stringContaining("a Slack token") });
    expect(warnings(server({ "X-Extra": `eyJhbGciOi.${"eyJzdWIiOi"}.c2lnbmF0dXJl` }).diagnostics)[0]).toMatchObject({ message: expect.stringContaining("JSON Web Token") });
    expect(warnings(server({ "X-MCP-Readonly": "true", Authorization: "Bearer ${GITHUB_TOKEN}" }).diagnostics)).toEqual([]);
  });

  it("warns on .env and key files, and compiles", () => {
    const result = compile({ "AGENT.md": AGENT, ".env": "TOKEN=x", ".env.example": "TOKEN=", "deploy.pem": "x", "files/tls/server.key": "x", "runtime.json": '{ "kind": "pod" }' });
    expect(errors(result.diagnostics)).toEqual([]);
    expect(result.manifest).toBeDefined();
    expect(warnings(result.diagnostics).map((item) => [item.code, item.file])).toEqual([
      ["secret_file", ".env"],
      ["secret_file", ".env.example"],
      ["secret_file", "deploy.pem"],
    ]);
    expect(warnings(result.diagnostics)[0]!.message).toContain("readable by anyone with agents:read");
  });

  it("warns on a file that looks like a tool policy", () => {
    const result = compile({ "AGENT.md": AGENT, "tool-policy.json": "{}", "github.policy.json": "{}", "docs/policy.json": "{}" });
    expect(warnings(result.diagnostics).map((item) => [item.code, item.file])).toEqual([
      ["tool_policy_file", "github.policy.json"],
      ["tool_policy_file", "tool-policy.json"],
    ]);
    expect(warnings(result.diagnostics)[0]!.message).toContain("nylorun tenant tool-policy");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ severity: "note", code: "file_not_compiled", file: "docs/policy.json" }));
  });
});

describe("agent folders: messages in the compiler's own words", () => {
  const raw = /Invalid input|Invalid option|Too small|Too big|expected .* received/;

  it("names a typo in memory at its key, not as an invalid harness", () => {
    const result = compile({ "AGENT.md": "---\nname: shop\ndescription: Orders.\nmemory:\n  acess: read_only\n---\nGo.\n" });
    expect(errors(result.diagnostics)).toEqual([
      expect.objectContaining({ code: "unknown_key", file: "AGENT.md", line: 5, column: 3, message: "Unknown key 'acess'. Did you mean 'access'?" }),
    ]);
  });

  it("says what a field takes, with a did-you-mean, and never zod's wording", () => {
    const kind = compile({ "AGENT.md": AGENT, "runtime.json": '{\n  "kind": "virtal"\n}' });
    expect(errors(kind.diagnostics)).toEqual([
      expect.objectContaining({ file: "runtime.json", line: 2, column: 11, message: 'kind is "virtual", "pod" or "none", not "virtal". Did you mean \'virtual\'?' }),
    ]);
    const access = compile({ "AGENT.md": "---\nname: shop\ndescription: Orders.\nmemory: { access: read }\n---\nGo.\n" });
    expect(errors(access.diagnostics)[0]!.message).toBe('memory.access is "read_write" or "read_only", not "read"');
    const session = compile({ "AGENT.md": AGENT, "triggers/daily.md": '---\nschedule: "0 9 * * *"\n---\nGo.\n' });
    expect(errors(session.diagnostics)).toEqual([
      expect.objectContaining({ file: "triggers/daily.md", message: 'session is required: a session id, or "new" for a new session each run' }),
    ]);
    const prompt = compile({ "AGENT.md": AGENT, "triggers/daily.md": '---\nschedule: "0 9 * * *"\nsession: new\n---\n\n' });
    expect(errors(prompt.diagnostics)).toEqual([expect.objectContaining({ code: "prompt_empty", file: "triggers/daily.md", line: 5, column: 1 })]);
    const slot = compile({ "AGENT.md": AGENT, "runtime.json": '{ "kind": "none", "secrets": { "A": { "type": "beerer" } } }' });
    expect(errors(slot.diagnostics)[0]!.message).toBe(
      'secrets.A.type is "environment_secret", "environment_variable", "bearer" or "headers", not "beerer". Did you mean \'bearer\'?',
    );
    // A typo'd key is named once, not also as a missing field.
    const typo = compile({ "AGENT.md": AGENT, "runtime.json": '{ "knd": "pod" }' });
    expect(errors(typo.diagnostics)).toEqual([expect.objectContaining({ code: "unknown_key", message: "Unknown key 'knd'. Did you mean 'kind'?" })]);
    for (const result of [kind, access, session, prompt, slot, typo]) for (const item of result.diagnostics) expect(item.message).not.toMatch(raw);
  });

  it("warns on a loop setting our harness does not read, and not for a custom harness", () => {
    const ours = compile({ "AGENT.md": "---\nname: shop\ndescription: Orders.\nloop: { maxTurns: 5 }\n---\nGo.\n" });
    expect(errors(ours.diagnostics)).toEqual([]);
    expect(warnings(ours.diagnostics)).toEqual([expect.objectContaining({ code: "loop_key", file: "AGENT.md", line: 4, message: expect.stringContaining("Unknown loop setting 'maxTurns'") })]);
    const custom = compile({ "AGENT.md": "---\nname: shop\ndescription: Orders.\nharness: acme-loop\nloop: { maxTurns: 5 }\n---\nGo.\n", "runtime.json": '{ "kind": "pod", "image": "ghcr.io/acme/loop@sha256:' + "a".repeat(64) + '" }' });
    expect(warnings(custom.diagnostics)).toEqual([]);
  });

  it("takes loop.plan, which offers the agent update_plan, as true or false", () => {
    const plan = compile({ "AGENT.md": "---\nname: shop\ndescription: Orders.\nloop: { plan: true }\n---\nGo.\n" });
    expect(plan.diagnostics).toEqual([]);
    expect(plan.manifest!.harness).toMatchObject({ loop: { plan: true } });
    const off = compile({ "AGENT.md": "---\nname: shop\ndescription: Orders.\nloop: { plan: false }\n---\nGo.\n" });
    expect(off.diagnostics).toEqual([]);
    const bad = compile({ "AGENT.md": "---\nname: shop\ndescription: Orders.\nloop: { plan: yes please }\n---\nGo.\n" });
    expect(errors(bad.diagnostics)).toEqual([expect.objectContaining({ code: "value_invalid", file: "AGENT.md", message: "loop.plan is true or false: true offers the agent update_plan" })]);
    const typo = compile({ "AGENT.md": "---\nname: shop\ndescription: Orders.\nloop: { plans: true }\n---\nGo.\n" });
    expect(warnings(typo.diagnostics)).toEqual([expect.objectContaining({ code: "loop_key", message: expect.stringContaining("Did you mean 'plan'?") })]);
  });

  it("takes model as <provider>/<model> into harness.model, and refuses any other shape", () => {
    const named = compile({ "AGENT.md": "---\nname: shop\ndescription: Orders.\nmodel: anthropic/claude-sonnet-4-5\n---\nGo.\n" });
    expect(named.diagnostics).toEqual([]);
    expect(named.manifest!.harness).toMatchObject({ model: "anthropic/claude-sonnet-4-5" });
    // The model's id may hold a '/' of its own.
    const routed = compile({ "AGENT.md": "---\nname: shop\ndescription: Orders.\nmodel: openrouter/google/gemini-2.5-pro\n---\nGo.\n" });
    expect(routed.manifest!.harness).toMatchObject({ model: "openrouter/google/gemini-2.5-pro" });
    expect(compile({ "AGENT.md": AGENT }).manifest!.harness).not.toHaveProperty("model");
    for (const bad of ["claude-sonnet-4-5", "anthropic/", "/claude", "anthropic/claude sonnet", "an thropic/claude", "{ provider: anthropic }", "3"]) {
      const result = compile({ "AGENT.md": `---\nname: shop\ndescription: Orders.\nmodel: ${bad}\n---\nGo.\n` });
      expect(result.manifest, bad).toBeUndefined();
      expect(errors(result.diagnostics), bad).toEqual([
        expect.objectContaining({ code: "value_invalid", file: "AGENT.md", line: 4, message: expect.stringMatching(/^model is <provider>\/<model>, such as anthropic\/claude-sonnet-4-5/) }),
      ]);
    }
    const long = compile({ "AGENT.md": `---\nname: shop\ndescription: Orders.\nmodel: a/${"m".repeat(200)}\n---\nGo.\n` });
    expect(errors(long.diagnostics)).toHaveLength(1);
  });

  it("refuses model in an agent under agents/: it runs on the root agent's", () => {
    const result = compile({
      "AGENT.md": AGENT,
      "agents/helper/AGENT.md": "---\nname: helper\ndescription: Helps.\nmodel: anthropic/claude-haiku-4-5\n---\nHelp.\n",
    });
    expect(errors(result.diagnostics)).toEqual([
      expect.objectContaining({ code: "nested_refused", file: "agents/helper/AGENT.md", message: expect.stringContaining("model is the root agent's") }),
    ]);
  });

  it("warns on an agent with no instructions, and compiles it", () => {
    const result = compile({ "AGENT.md": "---\nname: shop\ndescription: Orders.\n---\n\n" });
    expect(result.manifest).toBeDefined();
    expect(warnings(result.diagnostics)).toEqual([expect.objectContaining({ code: "instructions_empty", file: "AGENT.md", line: 5 })]);
    expect(warnings(compile({ "AGENT.md": "---\nname: shop\ndescription: Orders.\n---\n", "instructions/a.md": "Go.\n" }).diagnostics)).toEqual([]);
  });
});

describe("agent folders: line ends, order and $schema", () => {
  it("compiles CRLF frontmatter to the same manifest as LF, with the same positions", () => {
    const lf = { "AGENT.md": "---\nname: shop\ndescription: Orders.\nmemory: { access: read_only }\n---\nLook up orders.\n\nBe brief.\n", "triggers/daily.md": '---\nschedule: "0 9 * * *"\nsession: new\n---\nGo.\n' };
    const crlf = Object.fromEntries(Object.entries(lf).map(([path, text]) => [path, text.replace(/\n/g, "\r\n")]));
    const result = compile(crlf);
    expect(errors(result.diagnostics)).toEqual([]);
    expect(result.manifest).toEqual(compile(lf).manifest);
    const typo = compile({ "AGENT.md": "---\r\nname: shop\r\ndescription: Orders.\r\nharnes: nylorun\r\n---\r\nGo.\r\n" });
    expect(errors(typo.diagnostics)[0]).toMatchObject({ code: "unknown_key", line: 4, column: 1 });
  });

  it("orders instructions/ naturally: 2 before 10, and zero padding changes nothing", () => {
    const result = compile({ "AGENT.md": AGENT, "instructions/10-c.md": "Ten.", "instructions/2-b.md": "Two.", "instructions/1-a.md": "One.", "instructions/02-z.md": "Two, padded." });
    expect(result.manifest!.harness).toMatchObject({ instructions: ["Look up the order the user names.", "One.", "Two.", "Two, padded.", "Ten."] });
    const padded = compile({ "AGENT.md": AGENT, "instructions/01-a.md": "One.", "instructions/02-b.md": "Two.", "instructions/10-c.md": "Ten." });
    expect(padded.manifest!.harness).toMatchObject({ instructions: ["Look up the order the user names.", "One.", "Two.", "Ten."] });
  });

  it("accepts $schema in every JSON file, leaves it out of the manifest, and only warns on another kind's", () => {
    const result = compile({
      "AGENT.md": AGENT,
      "runtime.json": '{ "$schema": "https://docs.nylorun.com/schemas/agent-folder/v1/runtime.json", "kind": "none" }',
      "tools/t.json": JSON.stringify({ $schema: "https://docs.nylorun.com/schemas/agent-folder/v1/tool.json", inputSchema: "./t.schema.json", http: { url: "https://shop.example.com/t" } }),
      "t.schema.json": '{ "$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object" }',
      "mcp.json": JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: {} }),
    });
    expect(errors(result.diagnostics)).toEqual([]);
    expect(warnings(result.diagnostics)).toEqual([]);
    expect(result.manifest!.runtime).toEqual({ kind: "none" });
    // A JSON Schema's own $schema is its dialect, and stays.
    expect(result.manifest!.harness.tools![0]).toEqual({
      name: "t",
      inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
      http: { url: "https://shop.example.com/t" },
    });
    const threeFile = compile({ "AGENT.md": AGENT, "runtime.json": '{ "$schema": "https://docs.nylorun.com/schemas/runtime-manifest/v1.json", "kind": "none" }' });
    expect(warnings(threeFile.diagnostics)).toEqual([]);
    const misplaced = compile({ "AGENT.md": AGENT, "runtime.json": '{\n  "$schema": "https://docs.nylorun.com/schemas/agent-folder/v1/tool.json",\n  "kind": "none"\n}' });
    expect(errors(misplaced.diagnostics)).toEqual([]);
    expect(warnings(misplaced.diagnostics)).toEqual([
      expect.objectContaining({ code: "schema_url", file: "runtime.json", line: 2, message: expect.stringContaining("names the schema of a tool file (tools/<name>.json), and this is runtime.json") }),
    ]);
    const other = compile({ "AGENT.md": AGENT, "mcp.json": '{ "$schema": "https://example.com/mcp.json", "mcpServers": {} }' });
    expect(errors(other.diagnostics)).toEqual([]);
    expect(warnings(other.diagnostics)[0]).toMatchObject({ code: "schema_url", file: "mcp.json" });
  });
});
