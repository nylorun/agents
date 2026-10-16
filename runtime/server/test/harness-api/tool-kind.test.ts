/**
 * The record routes a tool call by what it names as its target (protocol 15), never by the
 * tool's name: `mcp` (a discovered MCP tool), `http` (a declared HTTP tool), `sandbox` (one of the
 * sandbox operations, in a session with a sandbox), `harness` (the harness's own) and `platform`
 * (`tool_search`). A call with no target, or one the session lacks, fails to the model as
 * `tool.unavailable`. `turn.start` states the Agent's facts (`turn.start.agent`, Harness API 5):
 * its id and kind, and its sandbox's workspace with the spec in the routing.
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
import { deploy } from "../support/agents.js";

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

/**
 * A Runtime whose harness the test drives (it says our id, `nylorun`, in `hello`), and session
 * s1 on an Agent of `kind`.
 */
async function start(kind: "none" | "virtual") {
  const runtime = await boot({ harness: "remote", sandbox: { backend: "virtual" } });
  cleanups.push(() => runtime.close());
  const acme = attach(runtime);
  await acme.request("hello", { api: HARNESS_API_VERSION, name: "nylorun", version: "0", features: {} });
  const env = `env-${kind}`;
  await deploy(runtime.url, server, plain, { id: env, ...(kind === "none" ? {} : { runtime: { kind } }) });
  const opened = await call(runtime, "PUT", "/v1/sessions/s1", { requestId: "s1", agent: env, ownerUserId: "u" });
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);
  const leased = acme.request("lease", {});
  const sent = await call(runtime, "POST", "/v1/sessions/s1/commands", {
    type: "message",
    requestId: "m1",
    idempotencyKey: "m1",
    content: "go",
  });
  expect(sent.status).toBeLessThan(300);
  const { run, input } = (await leased) as {
    run: { runId: string; sessionId: string; turnId: string };
    input: TurnStart;
  };
  const checkpoint = input.checkpoint as { turnId: string; segment: number; manifestHash: string };
  let n = 0;
  /** Journals a tool call named `toolName` with `target`, and answers what core said. */
  const intent = async (toolName: string, target?: EffectIntent["target"]) => {
    n += 1;
    const effect: EffectIntent = {
      effectId: `${checkpoint.turnId}:${checkpoint.segment}:tool:${n}:c${n}`,
      sessionId: run.sessionId,
      turnId: run.turnId,
      agentId: "bot",
      manifestHash: checkpoint.manifestHash,
      kind: "tool",
      toolName,
      ...(target ? { target } : {}),
      input: {},
      context: { callId: `c${n}`, invocationId: `i${n}` },
    };
    return (await acme.request("effect.intent", {
      runId: run.runId,
      effect,
      requestHash: effectRequestHash(effect),
    })) as { status: string; outcome?: { value: { code?: string; message?: string } } };
  };
  const finish = async () => {
    await acme.request("turn.completed", { runId: run.runId, status: "completed", state: {}, output: "done" });
    await until(
      async () => (await call(runtime, "GET", "/v1/sessions/s1")).body,
      (v) => v.status === "completed",
      "turn",
    );
    const items = (await call(runtime, "GET", "/v1/sessions/s1/items")).body.items as {
      type: string;
      payload: Record<string, unknown>;
    }[];
    return items.filter((item) => item.type === "tool.completed").map((item) => item.payload);
  };
  return { runtime, input, intent, finish };
}

const unavailable = { status: "completed", outcome: { value: { code: "tool.unavailable" } } };

it("routes by kind in a session without a sandbox: only the harness's own runs", async () => {
  const { input, intent, finish } = await start("none");
  // The Agent's facts, and no sandbox.
  expect(input.agent).toEqual({ id: "env-none", kind: "none" });
  expect(input).not.toHaveProperty("environment");
  expect(input.routing.sandbox?.spec).toBeUndefined();
  expect(input.manifest).not.toHaveProperty("runtime");

  // A harness tool may take any name, a sandbox operation's among them.
  expect(await intent("bash", { kind: "harness" })).toMatchObject({ status: "execute" });
  // A sandbox call needs a sandbox.
  expect(await intent("bash", { kind: "sandbox" })).toMatchObject({
    ...unavailable,
    outcome: { value: { message: expect.stringContaining("this session has none") } },
  });
  // No target: an author's code tool, which the Runtime does not run.
  expect(await intent("lookup")).toMatchObject(unavailable);
  // A target the session lacks: an MCP tool it never discovered, an HTTP tool it does not declare.
  expect(await intent("github__get_issue", { kind: "mcp", server: "github", tool: "get_issue" })).toMatchObject({
    status: "completed",
    outcome: { value: { code: "tool.unknown", message: expect.stringContaining("not discovered") } },
  });
  expect(await intent("refund", { kind: "http", tool: "refund" })).toMatchObject(unavailable);
  const completed = await finish();
  expect(completed.map((item) => [item.toolName, item.kind ?? null, item.tool ?? null])).toEqual([
    ["bash", "sandbox", null],
    ["lookup", null, null],
    ["github__get_issue", "mcp", "get_issue"],
    ["refund", "http", "refund"],
  ]);
});

it("runs a sandbox operation in a session with a sandbox, and states its workspace and spec", async () => {
  const { input, intent, finish } = await start("virtual");
  expect(input.agent).toEqual({ id: "env-virtual", kind: "virtual", sandbox: { workspace: "/workspace" } });
  expect(input.routing.sandbox?.spec).toMatchObject({ idle: "15m", network: { preset: "none" } });
  expect(await intent("bash", { kind: "sandbox" })).toMatchObject({ status: "execute" });
  // A sandbox call names one of the operations; any other name runs nothing.
  expect(await intent("rm", { kind: "sandbox" })).toMatchObject(unavailable);
  const completed = await finish();
  expect(completed.map((item) => item.toolName)).toEqual(["rm"]);
});
