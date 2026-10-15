import assert from "node:assert/strict";
import test from "node:test";
import {
  byPlugin,
  isOutdated,
  manifestStats,
  manifestView,
  pluginText,
  sandboxSummary,
  schemaFields,
  schemaType,
  fieldText,
} from "../web/src/manifest/model.ts";

const objectSchema = (properties, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const concierge = {
  manifestSchemaVersion: 7,
  id: "concierge",
  description: "Customer service concierge.",
  instructions: ["Keep answers short.", "Use tools."],
  tools: [
    {
      name: "lookup_order",
      description: "Look up an order.",
      inputSchema: objectSchema({ orderId: { type: "string" } }),
      outputSchema: objectSchema({ status: { enum: ["shipped", "delivered"] } }),
    },
    { name: "researcher", inputSchema: objectSchema({ task: { type: "string" } }), agent: { id: "researcher" } },
    {
      name: "fact-check",
      inputSchema: objectSchema({ task: { type: "string" } }),
      agent: { kind: "workflow", id: "fact-check" },
    },
  ],
  skills: {
    refund: {
      name: "refund",
      description: "How to refund.",
      files: { "scripts/refund.py": `sha256:${"b".repeat(64)}`, "SKILL.md": `sha256:${"a".repeat(64)}` },
    },
    ship: {
      name: "ship",
      description: "How to ship.",
      files: { "SKILL.md": `sha256:${"c".repeat(64)}` },
      plugin: { name: "shipping", version: "1.2.0" },
    },
  },
  mcpServers: {
    inventory: { name: "inventory", type: "streamable-http", url: "https://x" },
    carriers: {
      name: "carriers",
      type: "streamable-http",
      url: "https://carriers.example.com/mcp",
      plugin: { name: "shipping", version: "1.2.0" },
    },
    docs: { name: "docs", type: "sse", url: "https://y", plugin: { name: "docs" } },
  },
};

const pinned = {
  ...concierge,
  runtime: {
    sandbox: { image: "node:22", network: { preset: "dev", allow: ["api.github.com"] }, resources: { cpus: 2, memory: "2GiB" }, idle: "15m" },
    tools: [
      { name: "bash", description: "Run a command.", inputSchema: objectSchema({ command: { type: "string" } }) },
      { name: "read", inputSchema: objectSchema({}) },
      { name: "load_skill", inputSchema: objectSchema({ name: { type: "string" } }) },
    ],
    instructions: ["Use load_skill.", "Use bash in /workspace."],
  },
};

test("a flat manifest keeps its instructions, tools, skills and MCP servers", () => {
  const view = manifestView(concierge);
  assert.equal(view.description, "Customer service concierge.");
  assert.deepEqual(view.instructions, ["Keep answers short.", "Use tools."]);
  assert.deepEqual(view.skills, [
    { name: "refund", description: "How to refund.", files: ["SKILL.md", "scripts/refund.py"] },
    { name: "ship", description: "How to ship.", files: ["SKILL.md"], plugin: { name: "shipping", version: "1.2.0" } },
  ]);
  assert.deepEqual(
    view.mcpServers.map((server) => [server.name, server.url, server.plugin]),
    [
      ["inventory", "https://x", undefined],
      ["carriers", "https://carriers.example.com/mcp", { name: "shipping", version: "1.2.0" }],
      ["docs", "https://y", { name: "docs" }],
    ],
  );
  assert.equal(view.runtime, undefined);
});

test("tools say where they run", () => {
  assert.deepEqual(
    manifestView(concierge).tools.map((t) => [t.name, t.kind]),
    [["lookup_order", "code"], ["researcher", "subagent"], ["fact-check", "flow-subagent"]],
  );
});

test("plugins are listed once each, and skills and servers filter by plugin", () => {
  const view = manifestView(concierge);
  assert.deepEqual(view.plugins.map(pluginText), ["shipping 1.2.0", "docs"]);
  assert.deepEqual(byPlugin(view.skills, "all").map((s) => s.name), ["refund", "ship"]);
  assert.deepEqual(byPlugin(view.skills, "own").map((s) => s.name), ["refund"]);
  assert.deepEqual(byPlugin(view.mcpServers, "shipping 1.2.0").map((s) => s.name), ["carriers"]);
  assert.deepEqual(byPlugin(view.mcpServers, "own").map((s) => s.name), ["inventory"]);
});

test("a pinned manifest shows the Runtime's block: sandbox, tools and instructions", () => {
  const view = manifestView(pinned);
  assert.deepEqual(view.runtime?.sandbox, ["image node:22", "network dev + api.github.com", "2 cpus, 2GiB", "stops after 15m idle"]);
  assert.deepEqual(
    view.runtime?.tools.map((t) => [t.name, t.kind]),
    [["bash", "runtime"], ["read", "runtime"], ["load_skill", "runtime"]],
  );
  assert.deepEqual(view.runtime?.instructions, ["Use load_skill.", "Use bash in /workspace."]);
  // The Runtime's tools are not the author's.
  assert.deepEqual(manifestStats(view), manifestStats(manifestView(concierge)));
});

test("a runtime block without a sandbox has none; an empty sandbox is the Runtime's defaults", () => {
  assert.equal(manifestView({ runtime: { tools: [] } }).runtime?.sandbox, undefined);
  assert.deepEqual(sandboxSummary({}), ["Runtime defaults"]);
  assert.deepEqual(sandboxSummary({ resources: { cpus: 1 } }), ["1 cpu"]);
});

test("a load_skill tool at the top level is the author's own", () => {
  const view = manifestView({ tools: [{ name: "load_skill", inputSchema: objectSchema({}) }] });
  assert.equal(view.tools[0].kind, "code");
});

test("schemas become compact fields", () => {
  const agent = manifestView(concierge);
  assert.deepEqual(agent.tools[0].input, [{ name: "orderId", type: "string", required: true }]);
  assert.deepEqual(agent.tools[0].output, [{ name: "status", type: '"shipped" | "delivered"', required: true }]);
  assert.equal(agent.tools[1].output, undefined);
  assert.deepEqual(
    schemaFields(objectSchema({ ids: { type: "array", items: { type: "integer" } }, note: { type: "string" } }, ["ids"])),
    [
      { name: "ids", type: "integer[]", required: true },
      { name: "note", type: "string", required: false },
    ],
  );
  assert.deepEqual(schemaFields({ type: "string" }), [{ name: "", type: "string", required: true }]);
  assert.equal(schemaType({ anyOf: [{ type: "string" }, { type: "null" }] }), "string | null");
});

test("a session is outdated only when a different manifest is registered", () => {
  const pinned = { kind: "pinned", manifest: {}, manifestHash: "aaa" };
  assert.equal(isOutdated({ ...pinned, registeredHash: "bbb" }), true);
  assert.equal(isOutdated({ ...pinned, registeredHash: "aaa" }), false);
  assert.equal(isOutdated(pinned), false);
  assert.equal(isOutdated({ kind: "registered-only", registeredHash: "bbb" }), false);
});

test("the Runtime's block in a session's pin does not make it outdated (R2b C11)", () => {
  // A sandbox or skill tools change the pinned hash, not the definition the session opened from.
  const pinned = { kind: "pinned", manifest: {}, manifestHash: "pinned", definitionHash: "aaa" };
  assert.equal(isOutdated({ ...pinned, registeredHash: "aaa" }), false);
  assert.equal(isOutdated({ ...pinned, registeredHash: "bbb" }), true);
});

test("malformed manifests render as empty", () => {
  const empty = { instructions: [], tools: [], skills: [], mcpServers: [], plugins: [] };
  assert.deepEqual(manifestView(undefined), empty);
  assert.deepEqual(manifestView({ tools: "nope", skills: [], mcpServers: "x" }), empty);
});

test("fields read as TypeScript members", () => {
  assert.equal(fieldText({ name: "orderId", type: "string", required: true }), "orderId: string");
  assert.equal(fieldText({ name: "note", type: "string", required: false }), "note?: string");
  assert.equal(fieldText({ name: "", type: "boolean", required: true }), "boolean");
});

test("the overview counts what the agent can do", () => {
  assert.deepEqual(manifestStats(manifestView(concierge)), {
    tools: 1,
    subagents: 2,
    skills: 2,
    mcpServers: 3,
  });
});

test("HTTP tools show their request and static approval; MCP servers their approval", () => {
  const view = manifestView({
    tools: [
      {
        name: "refund",
        inputSchema: objectSchema({ orderId: { type: "string" } }),
        http: { url: "https://billing.example.com/refunds", method: "PUT" },
        approval: "always",
      },
      { name: "lookup", inputSchema: objectSchema({}), http: { url: "https://billing.example.com/lookup" } },
    ],
    mcpServers: {
      shop: { type: "streamable-http", url: "https://x", approval: "always" },
      docs: { type: "sse", url: "https://y" },
    },
  });
  assert.deepEqual(
    view.tools.map((t) => [t.name, t.kind, t.http, t.approval]),
    [
      ["refund", "http", { method: "PUT", url: "https://billing.example.com/refunds" }, true],
      ["lookup", "http", { method: "POST", url: "https://billing.example.com/lookup" }, undefined],
    ],
  );
  assert.deepEqual(
    view.mcpServers.filter((server) => server.approval).map((server) => server.name),
    ["shop"],
  );
  assert.equal(manifestStats(view).tools, 2);
});
