import assert from "node:assert/strict";
import test from "node:test";
import {
  manifestSections,
  manifestSpec,
  scheduleText,
  slotUses,
  triggerSession,
  triggerWhen,
  vaultRows,
} from "../web/src/agent-spec.ts";

const agent = {
  id: "research/analyst",
  kind: "pod",
  state: "sleeping",
  tracking: "tracking",
  resolvedVersion: 3,
  compute: { state: "stopped" },
  slots: [
    { name: "warehouse", type: "bearer", required: true, set: true },
    { name: "REPORTS_KEY", type: "environment_secret", required: false, set: false },
  ],
  runtime: {
    image: "ghcr.io/acme/analyst:1",
    resources: { cpus: 2, memory: "4Gi" },
    storage: "10Gi",
    network: { allowedHosts: ["reports.acme.dev"] },
    lifecycle: { idle: "15m" },
    setup: [{ command: "npm ci" }],
    secrets: {
      warehouse: { type: "bearer", url: "https://mcp.acme.dev/warehouse", description: "Read-only warehouse token" },
      REPORTS_KEY: {
        type: "environment_secret",
        allowedHosts: ["reports.acme.dev"],
        inject: { header: "x-api-key", format: "{value}" },
      },
    },
  },
  limits: {
    artifacts: { fileBytes: 10 * 1024 ** 2, totalBytes: 1024 ** 3 },
    skills: { totalBytes: 5 * 1024 ** 2 },
    disk: { versionBytes: 2 * 1024 ** 3, versionEntries: 100000 },
  },
};

const harness = {
  instructions: "Answer with charts.",
  tools: [{ name: "run_report", description: "Runs a report", credential: "REPORTS_KEY" }],
  mcpServers: { warehouse: { url: "https://mcp.acme.dev/warehouse" } },
  skills: { charts: { description: "Draw charts", files: { "SKILL.md": "x" }, secrets: ["REPORTS_KEY"] } },
  memory: { access: "read_write" },
};

test("a cron that is a plain daily or weekly time reads as words", () => {
  assert.equal(scheduleText("0 8 * * 1", "Europe/Berlin"), "Mondays at 08:00, Europe/Berlin");
  assert.equal(scheduleText("30 9 * * *"), "Every day at 09:30, UTC");
  assert.equal(scheduleText("0 7 * * 1-5", "UTC"), "Weekdays at 07:00, UTC");
  assert.equal(scheduleText("*/5 * * * *", "UTC"), "*/5 * * * * (UTC)");
  assert.equal(triggerWhen({ kind: "webhook" }), "On a webhook delivery");
  assert.equal(triggerWhen({ kind: "at", at: "2026-11-01T09:00:00Z" }), "Once, at 2026-11-01T09:00:00Z");
  assert.equal(triggerSession("new"), "A new session per run");
  assert.equal(triggerSession("kpi-weekly"), "Session kpi-weekly");
});

test("a slot's uses are the tools, MCP servers and skills that name it", () => {
  assert.deepEqual(slotUses(harness, "REPORTS_KEY"), ["Tool run_report", "Skill charts"]);
  // A server that names no slot matches by its URL.
  assert.deepEqual(slotUses(harness, "warehouse", "https://mcp.acme.dev/warehouse"), ["MCP server warehouse"]);
  assert.deepEqual(slotUses(undefined, "warehouse"), []);
});

test("the vault lists each declared slot with its binding, then secrets no slot declares", () => {
  const rows = vaultRows(
    agent,
    [
      { name: "warehouse", type: "bearer", binding: { url: "https://mcp.acme.dev/warehouse" }, createdAt: "2026-10-01T00:00:00Z" },
      { name: "legacy", type: "bearer", binding: { url: "https://old.example" }, createdAt: "2026-09-01T00:00:00Z" },
    ],
    harness,
  );
  assert.deepEqual(
    rows.map((row) => [row.name, row.declared, row.set, row.reach]),
    [
      ["warehouse", true, true, "https://mcp.acme.dev/warehouse"],
      ["REPORTS_KEY", true, false, "Only reports.acme.dev"],
      ["legacy", false, true, "https://old.example"],
    ],
  );
  assert.equal(rows[0].description, "Read-only warehouse token");
  assert.equal(rows[0].rotatedAt, "2026-10-01T00:00:00Z");
  assert.equal(rows[1].sentAs, "x-api-key: {value}");
  assert.deepEqual(rows[1].uses, ["Tool run_report", "Skill charts"]);
});

test("the manifest tab is the harness section, then the runtime section", () => {
  const sections = manifestSections(agent, {
    harness,
    runtime: { triggers: { "weekly-kpi": { schedule: "0 8 * * 1", timezone: "Europe/Berlin", session: "kpi", prompt: "Go" } } },
  });
  assert.deepEqual(
    sections.map((section) => `${section.group}:${section.id}`),
    [
      "harness:instructions",
      "harness:tools",
      "harness:skills",
      "harness:mcp",
      "harness:memory",
      "runtime:compute",
      "runtime:lifecycle",
      "runtime:network",
      "runtime:setup",
      "runtime:slots",
      "runtime:triggers",
      "runtime:limits",
    ],
  );
  const trigger = sections.find((section) => section.id === "triggers").rows[0];
  assert.equal(trigger.value, "Mondays at 08:00, Europe/Berlin → Session kpi");
  assert.equal(trigger.tab, "triggers");
  const slots = sections.find((section) => section.id === "slots").rows;
  assert.deepEqual(slots.map((row) => [row.label, row.note]), [["warehouse", "Set"], ["REPORTS_KEY", "Not set"]]);
});

test("without its manifest the tab still shows the runtime section from the Agent", () => {
  const sections = manifestSections({ ...agent, kind: "none", runtime: { lifecycle: {} }, slots: [] });
  assert.deepEqual(sections.map((section) => section.id), ["compute", "lifecycle", "limits"]);
  assert.equal(sections[0].rows[0].note, "fixed");
});

test("a manifest version reads as a spec from its document alone, with no Agent's state", () => {
  const sections = manifestSpec({
    harness,
    runtime: {
      kind: "pod",
      image: "ghcr.io/acme/analyst:1",
      lifecycle: { idle: "15m" },
      secrets: { REPORTS_KEY: { type: "environment_secret", required: true, description: "Reports API key" } },
      triggers: { nightly: { schedule: "0 2 * * *", session: "new", prompt: "Run" } },
      selfWake: true,
    },
  });
  assert.deepEqual(
    sections.map((section) => section.id),
    ["instructions", "tools", "skills", "mcp", "memory", "compute", "lifecycle", "network", "slots", "triggers"],
  );
  const compute = sections.find((section) => section.id === "compute").rows;
  assert.deepEqual(compute.map((row) => [row.label, row.note]), [
    ["Kind", "fixed"],
    ["Image", undefined],
    ["Resources", undefined],
    ["Storage", "fixed"],
  ]);
  const slot = sections.find((section) => section.id === "slots").rows[0];
  assert.equal(slot.value, "Sandbox secret · required");
  assert.equal(slot.note, "Reports API key");
  assert.deepEqual(
    sections.find((section) => section.id === "triggers").rows.map((row) => row.value),
    ["Every day at 02:00, UTC → A new session per run", "The agent may book its own next turn"],
  );
});

test("a manifest with no runtime section makes a vault with no compute; a flow lists its agents", () => {
  const sections = manifestSpec({
    harness: { kind: "workflow", agents: { fetch: { description: "Reads the source" }, file: {} } },
  });
  assert.deepEqual(sections.map((section) => section.id), ["flow", "compute", "lifecycle"]);
  assert.deepEqual(sections[0].rows.map((row) => [row.label, row.value]), [
    ["fetch", "Reads the source"],
    ["file", "Agent"],
  ]);
  assert.equal(sections[1].rows[0].value, "None: a vault with no compute");
});
