import assert from "node:assert/strict";
import test from "node:test";
import {
  isOutdated,
  manifestStats,
  manifestView,
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
  id: "concierge",
  description: "Customer service concierge.",
  capabilities: [
    {
      id: "agent",
      type: "agent",
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
    },
    { id: "billing", type: "agent", description: "Invoices.", tools: [] },
    {
      id: "store-skills",
      type: "agent",
      skills: {
        refund: {
          name: "refund",
          description: "How to refund.",
          files: { "scripts/refund.py": `sha256:${"b".repeat(64)}`, "SKILL.md": `sha256:${"a".repeat(64)}` },
        },
      },
      tools: [{ name: "load_skill", inputSchema: objectSchema({ name: { type: "string" } }) }],
    },
    { id: "mcp", type: "agent", mcpServers: { inventory: { type: "streamable-http", url: "https://x" } } },
    { id: "shipping", type: "agent-plugin", instructions: "Plugin skills.", skills: {} },
  ],
};

test("capabilities keep their instructions, type, skills and MCP servers", () => {
  const view = manifestView(concierge);
  assert.equal(view.description, "Customer service concierge.");
  assert.deepEqual(
    view.capabilities.map((c) => [c.id, c.type]),
    [["agent", "agent"], ["billing", "agent"], ["store-skills", "agent"], ["mcp", "agent"], ["shipping", "agent-plugin"]],
  );
  assert.deepEqual(view.capabilities[0].instructions, ["Keep answers short.", "Use tools."]);
  assert.deepEqual(view.capabilities[4].instructions, ["Plugin skills."]);
  assert.deepEqual(view.capabilities[2].skills, [
    { name: "refund", description: "How to refund.", files: ["SKILL.md", "scripts/refund.py"] },
  ]);
  assert.deepEqual(view.capabilities[3].mcpServers, ["inventory"]);
});

test("tools are sorted by where they run", () => {
  const [agent, , skills] = manifestView(concierge).capabilities;
  assert.deepEqual(
    agent.tools.map((t) => [t.name, t.kind]),
    [["lookup_order", "code"], ["researcher", "subagent"], ["fact-check", "flow-subagent"]],
  );
  assert.deepEqual(skills.tools.map((t) => t.kind), ["built-in"]);
});

test("a load_skill tool outside a skills capability is the author's own", () => {
  const view = manifestView({
    capabilities: [{ id: "agent", tools: [{ name: "load_skill", inputSchema: objectSchema({}) }] }],
  });
  assert.equal(view.capabilities[0].tools[0].kind, "code");
});

test("schemas become compact fields", () => {
  const [agent] = manifestView(concierge).capabilities;
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

test("malformed manifests render as empty", () => {
  assert.deepEqual(manifestView(undefined), { capabilities: [] });
  assert.deepEqual(manifestView({ capabilities: "nope" }).capabilities, []);
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
    skills: 1,
    mcpServers: 1,
  });
});

test("HTTP tools show their request and static approval; MCP servers their approval", () => {
  const view = manifestView({
    capabilities: [
      {
        id: "billing",
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
      },
    ],
  });
  const [billing] = view.capabilities;
  assert.deepEqual(
    billing.tools.map((t) => [t.name, t.kind, t.http, t.approval]),
    [
      ["refund", "http", { method: "PUT", url: "https://billing.example.com/refunds" }, true],
      ["lookup", "http", { method: "POST", url: "https://billing.example.com/lookup" }, undefined],
    ],
  );
  assert.deepEqual(billing.mcpApproval, ["shop"]);
  assert.equal(manifestStats(view).tools, 2);
});
