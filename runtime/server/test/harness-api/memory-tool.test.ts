/**
 * The `memory` tool over the Harness API (track T5, D72): `turn.start.memory` carries the Agent's
 * memory access, instructions and the index a harness pins; a call is a `runtime` effect,
 * operation `memory`, which core serves in the intent's own transaction. Writes are versioned to
 * the turn and recorded as `memory.updated` and `agent.memory_updated`; a replayed call applies
 * once; a `read_only` agent and a sub-agent may only view; a malformed call changes nothing.
 */
import { afterEach, expect, it } from "vitest";
import {
  HARNESS_API_VERSION,
  effectRequestHash,
  memoryChannels,
  type EffectIntent,
  type HarnessChannel,
  type TurnStart,
} from "@nylorun/core/harness-api";
import { boot, plain, server, until, type Started } from "../host/execution-support.js";
import type { RuntimeSection } from "@nylorun/core/contracts";
import { deploy } from "../support/agents.js";
import { withTestSessionStore } from "../support/store.js";
import { serveMemoryTool } from "../../src/memory/tool.js";
import type { Session } from "../../src/tenant/context.js";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function attach(runtime: Started): HarnessChannel {
  const channels = memoryChannels({ json: true });
  const detach = runtime.handle.attachHarness!(channels.core, { name: "test" });
  cleanups.push(() => {
    channels.harness.close("test over");
    detach();
  });
  return channels.harness;
}

async function call(runtime: Started, method: string, path: string, body?: unknown) {
  const response = await fetch(`${runtime.url}${path}`, {
    method,
    headers: server,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json().catch(() => undefined)) as any };
}

type Answer = { status: string; outcome?: { kind?: string; value: any } };

/** A Runtime whose harness the test drives, an Agent with `memory`, and a turn on session `sid`. */
async function start(memory: { access?: "read_write" | "read_only"; instructions?: string } | undefined) {
  const runtime = await boot({ harness: "remote" });
  cleanups.push(() => runtime.close());
  const acme = attach(runtime);
  await acme.request("hello", { api: HARNESS_API_VERSION, name: "nylorun", version: "0", features: {} });
  await deploy(runtime.url, server, plain, {
    id: "mem",
    ...(memory ? { memory } : {}),
    runtime: { kind: "none", triggers: { nightly: { schedule: "0 3 * * *", session: "nightly", prompt: "tidy" } } } as RuntimeSection,
  });
  let turns = 0;
  const turn = async (sid: string) => {
    turns += 1;
    if (turns === 1 || !sid.endsWith(String(turns - 1))) {
      const opened = await call(runtime, "PUT", `/v1/sessions/${sid}`, { requestId: sid, agent: "mem", ownerUserId: "u" });
      expect([200, 201]).toContain(opened.status);
    }
    const leased = acme.request("lease", {});
    const sent = await call(runtime, "POST", `/v1/sessions/${sid}/commands`, {
      type: "message",
      requestId: `m${turns}`,
      idempotencyKey: `m${turns}`,
      content: "go",
    });
    expect(sent.status).toBeLessThan(300);
    const { run, input } = (await leased) as { run: { runId: string; sessionId: string; turnId: string }; input: TurnStart };
    const checkpoint = input.checkpoint as { turnId: string; segment: number; manifestHash: string };
    let n = 0;
    const effectOf = (args: unknown, agent?: EffectIntent["agent"]): EffectIntent => {
      n += 1;
      return {
        effectId: `${checkpoint.turnId}:${checkpoint.segment}:tool:${n}:c${n}`,
        sessionId: run.sessionId,
        turnId: run.turnId,
        agentId: "bot",
        manifestHash: checkpoint.manifestHash,
        kind: "tool",
        toolName: "memory",
        target: { kind: "runtime", operation: "memory" },
        input: args,
        ...(agent ? { agent } : {}),
        context: { callId: `c${n}`, invocationId: `i${n}` },
      };
    };
    const send = async (effect: EffectIntent) =>
      (await acme.request("effect.intent", { runId: run.runId, effect, requestHash: effectRequestHash(effect) })) as Answer;
    const memoryCall = (args: unknown, agent?: EffectIntent["agent"]) => send(effectOf(args, agent));
    const finish = async () => {
      await acme.request("turn.completed", { runId: run.runId, status: "completed", state: {}, output: "done" });
      await until(
        async () => (await call(runtime, "GET", `/v1/sessions/${sid}`)).body,
        (v) => v.activeTurnId === null,
        "turn",
      );
    };
    return { run, input, memoryCall, send, effectOf, finish };
  };
  return { runtime, turn };
}

it("starts a turn with the memory block, serves views and writes, and versions them to the turn", async () => {
  const { runtime, turn } = await start({ instructions: "Keep release conventions." });
  const first = await turn("s1");
  expect(first.input.memory).toEqual({ access: "read_write", instructions: "Keep release conventions.", index: "", truncated: false });

  expect(await first.memoryCall({ command: "view", path: "/memories" })).toMatchObject({
    status: "completed",
    outcome: { value: { kind: "completed", output: expect.stringContaining("Here're the files and directories up to 2 levels deep in /memories") } },
  });
  const created = await first.memoryCall({
    command: "create",
    path: "/memories/conventions/release.md",
    file_text: "---\ndescription: Release branches\n---\nCut from release/x.y.",
  });
  expect(created).toMatchObject({
    status: "completed",
    outcome: { value: { kind: "completed", output: "File created successfully at: /memories/conventions/release.md" } },
  });
  // A replay of the same call answers the same and applies once.
  const effect = first.effectOf({ command: "str_replace", path: "/memories/conventions/release.md", old_str: "x.y", new_str: "<major>.<minor>" });
  expect((await first.send(effect)).status).toBe("completed");
  expect((await first.send(effect)).status).toBe("completed");
  await first.finish();

  const versions = (await call(runtime, "GET", `/v1/agents/mem/memory_versions?path=${encodeURIComponent("conventions/release.md")}`)).body.versions;
  expect(versions.map((v: any) => v.operation)).toEqual(["str_replace", "create"]);
  expect(versions[0]).toMatchObject({ actor: "agent:bot@1", sessionId: "s1", turnId: first.run.turnId, triggerRunId: null });
  const items = (await call(runtime, "GET", "/v1/sessions/s1/items")).body.items as { type: string; payload: any }[];
  expect(items.filter((item) => item.type === "memory.updated").map((item) => item.payload.changes[0].operation)).toEqual([
    "create",
    "str_replace",
  ]);
  const agentEvents = (await call(runtime, "GET", "/v1/agents/mem/events?types=agent.memory_updated")).body.events;
  expect(agentEvents).toHaveLength(2);
  expect(agentEvents[0].payload).toMatchObject({ sessionId: "s1", turnId: first.run.turnId });

  // The next session pins the index: newest first, with the description.
  const second = await turn("s2");
  expect(second.input.memory?.index).toBe("- /memories/conventions/release.md — Release branches");
  await second.finish();
});

it("answers a malformed call with text for the model and changes nothing", async () => {
  const { runtime, turn } = await start({});
  const one = await turn("s1");
  const failed = async (args: unknown) => (await one.memoryCall(args)).outcome?.value;
  expect(await failed({ command: "create", path: "/memories/a.md" })).toMatchObject({
    code: "tool.invalid-input",
    message: "Error: create requires file_text.",
  });
  expect(await failed({ command: "make" })).toMatchObject({ message: expect.stringContaining("command must be one of view") });
  expect(await failed({ command: "insert", path: "/memories/a.md", insert_line: "two", insert_text: "x" })).toMatchObject({
    message: "Error: insert_line must be an integer.",
  });
  expect(await failed({ command: "create", path: "/etc/passwd.md", file_text: "x" })).toMatchObject({ code: "memory.path_invalid" });
  expect(await failed({ command: "str_replace", path: "/memories/none.md", old_str: "x" })).toMatchObject({
    code: "memory.not_found",
    message: "The path /memories/none.md does not exist. Please provide a valid path.",
  });
  await one.finish();
  expect((await call(runtime, "GET", "/v1/agents/mem/memories")).body.memories).toEqual([]);
});

it("lets a read_only agent and a sub-agent view but not write", async () => {
  const { runtime, turn } = await start({ access: "read_only" });
  await call(runtime, "PUT", `/v1/agents/mem/memories/${encodeURIComponent("prefs/tone.md")}`, { content: "short" });
  const one = await turn("s1");
  expect(one.input.memory).toMatchObject({ access: "read_only", index: "- /memories/prefs/tone.md" });
  expect((await one.memoryCall({ command: "view", path: "/memories/prefs/tone.md" })).status).toBe("completed");
  expect((await one.memoryCall({ command: "delete", path: "/memories/prefs/tone.md" })).outcome?.value).toMatchObject({
    code: "memory.forbidden",
  });
  await one.finish();
  expect((await call(runtime, "GET", "/v1/agents/mem/memories")).body.memories).toHaveLength(1);
});

it("lets a sub-agent of a read_write agent only view", async () => {
  const { runtime, turn } = await start({});
  const one = await turn("s1");
  await one.finish();
  // A sub-agent's call names its agent; core serves it as a view-only call.
  const session = { id: "s1", agentId: "mem", definition: { name: "bot", version: 1 }, activeTurnId: one.run.turnId } as Session;
  const served = (args: unknown) =>
    withTestSessionStore(runtime, (store) =>
      store.tx((t) => serveMemoryTool(t, session, { effectId: "e1", input: args, agent: { id: "helper", path: "bot/helper" } })),
    );
  expect(await served({ command: "create", path: "/memories/x.md", file_text: "x" })).toMatchObject({
    kind: "failed",
    code: "memory.forbidden",
    message: expect.stringContaining("sub-agent"),
  });
  expect(await served({ command: "view", path: "/memories" })).toMatchObject({ kind: "completed" });
});

it("sends no memory block, and refuses the tool, when the agent has no harness.memory", async () => {
  const { turn } = await start(undefined);
  const one = await turn("s1");
  expect(one.input).not.toHaveProperty("memory");
  expect((await one.memoryCall({ command: "view", path: "/memories" })).outcome?.value).toMatchObject({ code: "tool.unavailable" });
  await one.finish();
});

it("names the trigger run on a version written in a turn a trigger started", async () => {
  const { runtime } = await start({});
  const acme = attach(runtime);
  await acme.request("hello", { api: HARNESS_API_VERSION, name: "nylorun", version: "0", features: {} });
  const leased = acme.request("lease", {});
  const ran = await fetch(`${runtime.url}/v1/agents/mem/triggers/nightly/run`, {
    method: "POST",
    headers: { ...server, "idempotency-key": "k1" },
  });
  expect(ran.status).toBe(200);
  const runId = ((await ran.json()) as { run: { id: string } }).run.id;
  const { run, input } = (await leased) as { run: { runId: string; sessionId: string; turnId: string }; input: TurnStart };
  const checkpoint = input.checkpoint as { turnId: string; segment: number; manifestHash: string };
  const effect: EffectIntent = {
    effectId: `${checkpoint.turnId}:${checkpoint.segment}:tool:1:c1`,
    sessionId: run.sessionId,
    turnId: run.turnId,
    agentId: "bot",
    manifestHash: checkpoint.manifestHash,
    kind: "tool",
    toolName: "memory",
    target: { kind: "runtime", operation: "memory" },
    input: { command: "create", path: "/memories/nightly.md", file_text: "tidied" },
    context: { callId: "c1", invocationId: "i1" },
  };
  expect(((await acme.request("effect.intent", { runId: run.runId, effect, requestHash: effectRequestHash(effect) })) as Answer).status).toBe(
    "completed",
  );
  const [version] = (await call(runtime, "GET", "/v1/agents/mem/memory_versions")).body.versions;
  expect(version).toMatchObject({ path: "/memories/nightly.md", sessionId: "nightly", triggerRunId: runId });
});
