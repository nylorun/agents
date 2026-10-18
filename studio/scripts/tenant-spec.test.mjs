import assert from "node:assert/strict";
import test from "node:test";
import {
  budgetLimit,
  budgetScope,
  budgetUsed,
  bytesText,
  computeSections,
  durationText,
  limitGroups,
  limitOverrides,
  limitText,
  parseLimit,
  ruleNote,
  ruleTool,
  rulesFor,
  sortedRules,
  statusGroups,
  whenText,
  withPolicyNotes,
} from "../web/src/tenant-spec.ts";

test("sizes and durations read in the largest unit that divides them", () => {
  assert.equal(bytesText(10 * 1024 ** 3), "10 GiB");
  assert.equal(bytesText(512 * 1024), "512 KiB");
  assert.equal(bytesText(1.5 * 1024 ** 2), "1,536 KiB");
  assert.equal(bytesText(1024 ** 2 + 1), "1.0 MiB");
  assert.equal(bytesText(300), "300 B");
  assert.equal(durationText(30 * 86_400_000), "30 days");
  assert.equal(durationText(600_000), "10 min");
  assert.equal(durationText(90_000), "90 s");
  assert.equal(durationText(250), "250 ms");
  assert.equal(limitText("memoriesPerAgent", 1000), "1,000");
  assert.equal(limitText("labelKeyChars", 63), "63 characters");
  assert.equal(limitText("triggerJitterPercent", 10), "10%");
});

test("a typed limit is read in its own unit, and refused when it is no whole number", () => {
  assert.equal(parseLimit("memoryBytes", "100 KiB"), 102_400);
  assert.equal(parseLimit("memoryBytes", "2048"), 2048);
  assert.equal(parseLimit("modelRequestMs", "10 min"), 600_000);
  assert.equal(parseLimit("modelRequestMs", "15m"), 900_000);
  assert.equal(parseLimit("pageItems", "1,000"), 1000);
  assert.equal(parseLimit("pageItems", "10 MiB"), undefined);
  assert.equal(parseLimit("memoryBytes", "0.5 B"), undefined);
  assert.equal(parseLimit("memoryBytes", "lots"), undefined);
});

test("limits group by area beside their defaults, and only a changed one is saved", () => {
  const defaults = { modelAttempts: 3, memoryBytes: 102_400, pageItems: 200 };
  const limits = { ...defaults, modelAttempts: 5, futureLimit: 7 };
  const groups = limitGroups(limits, defaults);
  assert.deepEqual(groups.map((group) => group.title), ["Requests", "Model calls", "Memory", "Other"]);
  const attempts = groups[1].rows[0];
  assert.deepEqual([attempts.name, attempts.value, attempts.default, attempts.changed], ["modelAttempts", 5, 3, true]);
  assert.equal(groups[3].rows[0].default, undefined);
  assert.deepEqual(limitOverrides(limits, defaults, "pageItems", 500), { modelAttempts: 5, pageItems: 500, futureLimit: 7 });
  assert.deepEqual(limitOverrides(limits, defaults, "modelAttempts", undefined), { futureLimit: 7 });
});

const status = {
  tenant: { id: "tn_1", name: "default", createdAt: "x", updatedAt: "x", schemaVersion: 12 },
  path: "/var/lib/nylorun",
  checks: { store: true, scheduler: true, model: false, schema: true },
  model: { configured: false },
  agents: [{ agentId: "a" }, { agentId: "b" }],
  counts: { sessions: 8, runningSessions: 1, uncertainEffects: 2 },
  sandbox: { backend: "local", retained: 1 },
  harness: { mode: "in-process", connected: 3, workspace: true },
  streams: {
    reachable: true,
    basin: { ready: true, failures: 0, lastError: null },
    generation: 3,
    relay: { active: true, pendingTxs: 0, pendingRows: 0, confirmed: null, reconciliations: 0, lastError: null, lagBytes: 0 },
  },
};

test("the status reads as its checks, what runs it, and what it holds", () => {
  const groups = statusGroups(status);
  assert.deepEqual(groups.map((group) => group.title), ["Checks", "Runtime", "Holds"]);
  const model = groups[0].rows[2];
  assert.deepEqual([model.state, model.tone, model.detail, model.tab], ["Failing", "error", "No model set", "models"]);
  assert.deepEqual(groups[1].rows.map((row) => row.label), ["Harness", "Sandbox", "Event streams"]);
  assert.equal(groups[1].rows[0].detail, "3 connected · workspace on");
  assert.equal(groups[1].rows[2].detail, "Relay active · 0 pending · lag 0 B · generation 3");
  assert.deepEqual(groups[2].rows.map((row) => [row.state, row.tone]), [["2", "idle"], ["8", "idle"], ["2", "warn"]]);
});

test("compute lists the sandbox, the backends found, what an Agent may ask for, and storage", () => {
  const sections = computeSections(
    {
      preference: "auto",
      backend: "local",
      isolation: "process",
      reason: "Chosen: local",
      probes: [{ name: "local", available: true, isolation: "process" }, { name: "virtual", available: false, isolation: "process", reason: "No harness" }],
      defaultImage: "ghcr.io/nylorun/sandbox:0.29",
      config: {
        limits: {
          network: ["github.com"],
          resources: { cpus: 4, memoryMiB: 8192 },
          defaultResources: { cpus: 1, memoryMiB: 1024 },
          idle: "15m",
          environments: 100,
        },
        lifecycle: { stopGrace: "10s" },
      },
      cluster: null,
    },
    { limits: { fileBytes: 100 * 1024 ** 2, totalBytes: 10 * 1024 ** 3 }, usedBytes: 0 },
    { limits: { totalBytes: 2 * 1024 ** 3 } },
    22,
  );
  assert.deepEqual(sections.map((section) => section.id), ["sandbox", "probes", "environments", "placement", "storage"]);
  assert.deepEqual(sections[1].rows.map((row) => row.note), ["available", "No harness"]);
  const env = Object.fromEntries(sections[2].rows.map((row) => [row.label, [row.value, row.note]]));
  assert.deepEqual(env["Most resources"], ["4 CPUs · 8 GiB memory", undefined]);
  assert.deepEqual(env["Most Agents"], ["100", "22 in use"]);
  assert.equal(sections[3].rows[0].value, "The harness container and the sandbox");
});

const rules = [
  { effect: "allow", server: "deepwiki", reason: "Read-only documentation" },
  { effect: "ask", tool: "pay_invoice", kind: "http", when: { amount: { gt: 100 } }, reason: "Payments over $100 need a person" },
  { effect: "deny", server: "github", tool: "delete_*" },
  { effect: "ask", agent: "fin-*", when: { method: { in: ["POST", "DELETE"] } } },
];

test("the tool policy reads strictest first; a rule reads as its tool, manifest and when", () => {
  assert.deepEqual(sortedRules(rules).map(({ index }) => index), [2, 1, 3, 0]);
  assert.deepEqual(rules.map(ruleTool), ["deepwiki · any tool", "pay_invoice (HTTP)", "github · delete_*", "Any tool"]);
  assert.equal(whenText(rules[1].when), "amount > 100");
  assert.equal(whenText(rules[3].when), "method in POST, DELETE");
  assert.equal(whenText(undefined), "");
});

test("an Agent's tool shows the rules that may decide its calls", () => {
  assert.deepEqual(
    rulesFor(rules, "fin-ops", { server: "github", tool: "delete_repository", kind: "mcp" }).map(ruleNote),
    ["Deny", "Ask when method in POST, DELETE"],
  );
  assert.deepEqual(rulesFor(rules, "triage", { tool: "pay_invoice", kind: "http" }).map(ruleNote), [
    "Ask when amount > 100: Payments over $100 need a person",
  ]);
  assert.deepEqual(rulesFor(rules, "triage", { server: "deepwiki", tool: "ask", kind: "mcp" }).length, 1);
});

test("a budget reads as what it applies to, its cap and how much of it is used", () => {
  const tenant = { scope: "tenant", period: "month", limitUsd: 250 };
  assert.equal(budgetScope(tenant), "The Tenant");
  assert.equal(budgetScope({ scope: "manifest", id: "triage", period: "day", limitUsd: 20 }), "Manifest triage");
  assert.equal(budgetLimit({ scope: "turn", limitTokens: 200_000 }), "200 K tokens");
  assert.deepEqual(budgetUsed(tenant, { scope: "tenant", period: "month", calls: 3, tokens: 9, costUsd: 96.3 }), {
    share: 0.3852,
    text: "$96.30 · 39%",
  });
  assert.equal(budgetUsed({ scope: "turn", limitTokens: 1 }, undefined).text, "Checked per turn");
});

test("a manifest's HTTP tools and MCP servers note the rules that may decide their calls", () => {
  const sections = [
    { id: "tools", group: "harness", title: "Tools", hint: "", rows: [
      { id: "tool:pay_invoice", label: "pay_invoice", value: "HTTP · POST https://pay", json: {} },
      { id: "tool:sum", label: "sum", value: "Code", json: {} },
    ] },
    { id: "mcp", group: "harness", title: "MCP", hint: "", rows: [
      { id: "mcp:github", label: "github", value: "https://gh", note: "uses GH", json: {} },
      { id: "mcp:deepwiki", label: "deepwiki", value: "https://dw", json: {} },
    ] },
  ];
  const [tools, mcp] = withPolicyNotes(sections, rules, "triage");
  assert.deepEqual(tools.rows.map((row) => [row.note, row.tone]), [
    ["Ask when amount > 100: Payments over $100 need a person", "warn"],
    [undefined, undefined],
  ]);
  assert.deepEqual(mcp.rows.map((row) => [row.note, row.tone]), [
    ["Deny delete_* · uses GH", "error"],
    ["Allow: Read-only documentation", "ok"],
  ]);
});
