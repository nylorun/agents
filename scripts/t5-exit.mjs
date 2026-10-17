#!/usr/bin/env node
// Track T5's exit test (Memory, D72) on a single-server install, as one scenario:
//
//   node scripts/t5-exit.mjs        # npm run test:t5-exit
//
// Starts a Tenant (Compose) with its fixture model and saves the agent manifest `keeper`: memory
// on (`harness.memory`) and a schedule every minute on session `notes`, standing in for T4's
// hourly Agent. Then, with no client driving the schedule:
//
// - one fire writes a memory with the `memory` tool, and its version names the session and the
//   trigger run (and the version of the manifest the turn ran);
// - a new version of the manifest is saved, and the tracking Agent moves to it;
// - the next fire, on the new version, reads the memory back with the `memory` tool;
// - a write without a command's parameter is answered for the model and changes nothing.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ensureImages, eventually, runtimeHeaders, withStack } from "./lib/stack.mjs";

const started = Date.now();
const step = (message) => console.log(`\n[t5-exit ${Math.round((Date.now() - started) / 1000)}s] ${message}`);
let failed = false;
const check = (ok, detail) => {
  console.log(`${ok ? "pass" : "fail"} ${detail}`);
  if (!ok) failed = true;
};

const PATH = "/memories/facts/release-day.md";
const FILE = "---\ntype: Fact\ndescription: Which day the team releases\n---\nWe release on Thursdays.";
const tool = (args) => `fixture:tool memory ${JSON.stringify(args)}`;

/** The manifest: memory on, and a schedule every minute on session notes whose prompt is `prompt`. */
const manifest = (prompt) => ({
  manifestSchemaVersion: 8,
  name: "keeper",
  harness: {
    instructions: ["Do what each message asks."],
    memory: { instructions: "Keep the team's release facts." },
  },
  runtime: { kind: "none", triggers: { tick: { schedule: "* * * * *", session: "notes", prompt } } },
});

const images = await ensureImages({ only: ["runtime"] });
await withStack({ name: "nylorun-t5-exit", images, startArgs: ["--no-studio"] }, async (stack) => {
  const tenant = await stack.tenant();
  const headers = runtimeHeaders(tenant.key, { "content-type": "application/json", "Nylorun-Protocol": "17" });
  const api = async (method, path, body, key) => {
    const response = await fetch(`${stack.runtimeUrl}${path}`, {
      method,
      headers: key ? runtimeHeaders(key, { "content-type": "application/json" }) : headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  const ok = async (method, path, body, key) => {
    const answer = await api(method, path, body, key);
    assert.ok(answer.status < 300, `${method} ${path}: ${answer.status} ${JSON.stringify(answer.body)}`);
    return answer.body;
  };
  const tickRuns = async () => (await ok("GET", "/v1/agents/keeper/runs?limit=200")).runs.filter((run) => run.triggerId === "tick");
  const items = async () => (await ok("GET", "/v1/sessions/notes/items?limit=500")).items;
  const idle = () =>
    eventually(
      async () => {
        const view = await ok("GET", "/v1/sessions/notes");
        return view.activeTurnId === null && view.queuedMessages === 0 && view;
      },
      { timeout: 180_000, interval: 1000, message: "session notes to go idle" },
    );
  /** The first started run of the schedule fired after `since`, once its turn has ended. */
  const runAfter = async (since, message) => {
    const run = await eventually(
      async () => (await tickRuns()).find((candidate) => candidate.firedAt >= since && candidate.status === "started"),
      { timeout: 180_000, interval: 2000, message },
    );
    await idle();
    return run;
  };
  /** What the turn a run started recorded, from its message on. */
  const turnOf = async (run) => {
    const all = await items();
    const at = all.findIndex((item) => item.type === "command.message" && item.payload?.cause?.runId === run.id);
    if (at < 0) return [];
    const next = all.findIndex((item, n) => n > at && item.type === "command.message");
    return all.slice(at, next < 0 ? undefined : next);
  };

  await ok("PUT", "/v1/tenant/config/seed", { requestId: randomUUID(), fixtureModel: true }, tenant.managementKey);

  step("the agent manifest keeper (memory on, a schedule on session notes) and the Agent keeper");
  const since = new Date().toISOString();
  await ok("PUT", "/v1/agent-manifests/keeper", { requestId: randomUUID(), ...manifest(tool({ command: "create", path: PATH, file_text: FILE })) });
  await ok("PUT", "/v1/agents/keeper", { requestId: randomUUID(), manifest: "keeper" });

  step("one fire writes a memory; its version names the session and the trigger run");
  const first = await runAfter(since, "the schedule's first run");
  const memory = await api("GET", `/v1/agents/keeper/memories/${encodeURIComponent(PATH.slice("/memories/".length))}`);
  check(memory.status === 200 && memory.body.content === FILE, `the memory ${PATH}: ${memory.status}`);
  // A later fire may write again before the upgrade; the first fire's version is the one it ran.
  const version = (await ok("GET", "/v1/agents/keeper/memory_versions")).versions.find((v) => v.triggerRunId === first.id);
  check(
    version?.operation === "create" && version.sessionId === "notes" && version.triggerRunId === first.id,
    `its version: ${version?.operation} in session ${version?.sessionId}, trigger run ${version?.triggerRunId} (the run was ${first.id})`,
  );
  check(version?.actor === "agent:keeper@1", `written by ${version?.actor}`);
  const updated = (await turnOf(first)).find((item) => item.type === "memory.updated");
  check(updated?.payload?.changes?.[0]?.path === PATH, "the turn recorded memory.updated");

  step("an upgrade: a new version of the manifest, which the tracking Agent moves to");
  await ok("PUT", "/v1/agent-manifests/keeper", { requestId: randomUUID(), ...manifest(tool({ command: "view", path: PATH })) });
  const moved = await eventually(
    async () => {
      const agent = await ok("GET", "/v1/agents/keeper");
      return agent.resolvedVersion === 2 && agent;
    },
    { timeout: 30_000, interval: 1000, message: "the Agent to move to version 2" },
  );
  check(moved.resolvedVersion === 2, `the Agent runs keeper@${moved.resolvedVersion}`);
  const upgraded = new Date().toISOString();
  const written = (await ok("GET", "/v1/agents/keeper/memory_versions")).versions.length;

  step("the next fire, on the new version, reads the memory back");
  const second = await runAfter(upgraded, "the schedule's run after the upgrade");
  const read = JSON.stringify(await turnOf(second));
  check(read.includes("We release on Thursdays."), "the memory tool's view returned what the first fire wrote");
  const pinned = (await ok("GET", "/v1/sessions/notes")).manifest;
  check(pinned?.version === 2, `the session's turn ran on keeper@${pinned?.version}`);
  const versions = (await ok("GET", "/v1/agents/keeper/memory_versions")).versions;
  check(versions.length === written, `a view writes no version (${versions.length} before and after)`);

  step("a write missing a parameter is answered for the model and changes nothing");
  const requestId = randomUUID();
  await ok("POST", "/v1/sessions/notes/commands", {
    type: "message",
    requestId,
    idempotencyKey: requestId,
    content: tool({ command: "create", path: "/memories/facts/other.md" }),
  });
  await idle();
  const after = JSON.stringify(await items());
  check(after.includes("Error: create requires file_text."), "the model read: Error: create requires file_text.");
  check((await ok("GET", "/v1/agents/keeper/memories")).memories.length === 1, "still one memory");
});
if (failed) {
  console.error("\nT5 exit test failed");
  process.exitCode = 1;
} else console.log("\nT5 exit test passed");
