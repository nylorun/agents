/**
 * The loop against a fake core (a memory channel that validates every frame, as a socket does)
 * and a fake Model Gate on 127.0.0.1: a text turn, a bash turn journaled intent first, a replay
 * that runs nothing twice, and a cancel.
 */
import { createServer, type IncomingHttpHeaders } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  HARNESS_API_VERSION,
  RUNTIME_LIMIT_DEFAULTS,
  applyUpdates,
  memoryChannels,
  type EffectIntent,
  type ModelCallBody,
  type RecordedOutcome,
  type TurnOutput,
  type TurnStart,
} from "@nylorun/core/harness-api";
import { promptOf, serve } from "../src/harness.js";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const manifest = {
  manifestSchemaVersion: 7,
  id: "bot",
  instructions: ["Be brief."],
  runtime: {
    sandbox: {},
    instructions: ["You have a sandbox."],
    tools: [
      {
        name: "bash",
        description: "Run a bash command.",
        inputSchema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    ],
  },
};

const turn = (input: string, outcomes: RecordedOutcome[] = []): TurnStart => ({
  type: "turn.start",
  engine: "agent",
  manifest,
  checkpoint: { manifestHash: "sha256:bot", sessionId: "s1", turnId: "t1", segment: 0, input },
  outcomes,
  transcript: { cursor: 4 },
  options: { fixtureModel: false },
  routing: { rootManifest: manifest, sandbox: { ownerId: "s1" } },
  limits: RUNTIME_LIMIT_DEFAULTS,
});

/** A Model Gate that answers by `answer`, or hangs until its client goes away. */
async function fakeGate(answer: (body: ModelCallBody) => unknown) {
  const calls: { path: string; headers: IncomingHttpHeaders; body?: ModelCallBody }[] = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = text ? (JSON.parse(text) as ModelCallBody) : undefined;
    calls.push({ path: request.url!, headers: request.headers, ...(body ? { body } : {}) });
    if (!body) return void response.writeHead(204).end();
    const outcome = answer(body);
    if (outcome === undefined) return;
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ outcome }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, calls };
}

/** Text, a bash call when asked to `run <command>`, then text quoting the tool's result. */
const scripted = (body: ModelCallBody) => {
  const last = body.call.prompt.at(-1)!;
  const said = (last.content[0] as { text?: string }).text ?? "";
  if (last.kind === "tool-result") return text(`done: ${said}`);
  if (said.startsWith("run "))
    return {
      output: [{ type: "tool-call", id: "call-1", name: "bash", args: { command: said.slice(4) } }],
    };
  return text("hello");
};
const text = (value: string) => ({ output: [{ type: "text", text: value }], finishReason: "stop" });

interface Row {
  requestHash: string;
  value?: unknown;
}

/**
 * Core's end: one run of `start`, a journal like core's (an intent is journaled once; a completed
 * one is answered from the journal), and the output the run settles with.
 */
function fakeCore(
  start: TurnStart,
  hooks: { journal?: Map<string, Row>; onIntent?(effect: EffectIntent): void } = {},
) {
  const { harness, core } = memoryChannels({ json: true });
  const journal = hooks.journal ?? new Map<string, Row>();
  const intents: EffectIntent[] = [];
  const order: string[] = [];
  let leased = false;
  let settle!: (end: { method: string; output: TurnOutput }) => void;
  const settled = new Promise<{ method: string; output: TurnOutput }>(
    (resolve) => (settle = resolve),
  );
  const before = [
    { kind: "input", turnId: "t0", event: { kind: "user-message", text: "earlier" } },
  ];
  core.handle(async (method, params) => {
    const p = params as Record<string, any>;
    switch (method) {
      case "hello":
        // Harness API 3: what the harness offers is `features` (it was `capabilities`).
        expect(p).toMatchObject({ api: HARNESS_API_VERSION, name: "minimal", features: {} });
        return { api: HARNESS_API_VERSION, tenantId: "tenant", sandbox: { backend: null }, renewEveryMs: 60_000 };
      case "lease":
        if (leased) return new Promise(() => undefined);
        leased = true;
        return {
          run: { runId: "r1", sessionId: "s1", turnId: "t1", epoch: 1, token: "run-token" },
          input: start,
        };
      case "transcript.read":
        return { cursor: 4, entries: before };
      case "effect.intent": {
        intents.push(p.effect);
        order.push(`intent ${p.effect.effectId}`);
        hooks.onIntent?.(p.effect);
        const row = journal.get(p.effect.effectId);
        if (row?.value !== undefined) return { status: "completed", outcome: { value: row.value } };
        journal.set(p.effect.effectId, { requestHash: p.requestHash });
        return { status: "execute" };
      }
      case "effect.outcome":
        order.push(`outcome ${p.effectId}`);
        if ("error" in p) return { status: "uncertain" };
        journal.get(p.effectId)!.value = p.value;
        return { status: "completed", outcome: { value: p.value } };
      case "turn.completed":
      case "turn.failed":
      case "turn.waiting":
        settle({ method, output: p as TurnOutput });
        return { cursor: 9 };
      default:
        throw new Error(`unexpected ${method}`);
    }
  });
  cleanups.push(() => harness.close());
  return { harness, core, journal, intents, order, settled, before };
}

it("runs a text turn: one model intent without its prompt, the gate keyed by the effect id", async () => {
  const gate = await fakeGate(scripted);
  const core = fakeCore(turn("hi"));
  void serve(core.harness, { name: "minimal", gatesUrl: gate.url });
  const { method, output } = await core.settled;

  expect(method).toBe("turn.completed");
  expect(output).toMatchObject({
    runId: "r1",
    status: "completed",
    state: { steps: 1 },
    output: "hello",
  });
  expect(core.intents).toEqual([
    {
      effectId: "t1:0:model:0",
      sessionId: "s1",
      turnId: "t1",
      agentId: "bot",
      manifestHash: "sha256:bot",
      kind: "model",
      context: { invocationId: "t1:0:0" },
    },
  ]);
  expect(gate.calls).toHaveLength(1);
  expect(gate.calls[0]!.headers).toMatchObject({
    authorization: "Bearer run-token",
    "idempotency-key": "t1:0:model:0",
  });
  expect(gate.calls[0]!.body).toMatchObject({ effectId: "t1:0:model:0", invocationId: "t1:0:0" });
  // The prompt: the instructions, the earlier turn from the transcript, then this turn's message.
  expect(gate.calls[0]!.body!.call.prompt.map((item) => item.kind)).toEqual([
    "instructions",
    "message",
    "message",
  ]);
  expect(gate.calls[0]!.body!.call.tools.map((tool) => tool.name)).toEqual(["bash"]);
  expect(applyUpdates(core.before, output.transcript!)).toEqual([
    ...core.before,
    { kind: "input", turnId: "t1", event: { kind: "user-message", text: "hi" } },
    { kind: "candidate", turnId: "t1", stepId: "t1:0:0", candidate: text("hello") },
    { kind: "final", turnId: "t1", stepId: "t1:0:0", output: "hello" },
  ]);
});

it("runs bash journaled intent first, and replays a completed outcome without running it again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-minimal-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const ran = join(dir, "ran.log");
  const message = `run echo ran >> ${ran} && echo hi`;
  const gate = await fakeGate(scripted);
  const first = fakeCore(turn(message), {
    onIntent: (effect) => effect.kind === "tool" && expect(existsSync(ran)).toBe(false),
  });
  void serve(first.harness, { name: "minimal", gatesUrl: gate.url });
  const done = await first.settled;

  const toolId = "t1:0:tool:0:call-1";
  expect(first.order).toEqual([
    "intent t1:0:model:0",
    "outcome t1:0:model:0",
    `intent ${toolId}`,
    `outcome ${toolId}`,
    "intent t1:0:model:1",
    "outcome t1:0:model:1",
  ]);
  expect(first.intents[1]).toMatchObject({
    effectId: toolId,
    kind: "tool",
    toolName: "bash",
    input: { command: message.slice(4) },
    context: { callId: "call-1", invocationId: "t1:0:0:call-1", stepId: "t1:0:0" },
  });
  expect(first.journal.get(toolId)!.value).toEqual({
    kind: "completed",
    output: { exitCode: 0, stdout: "hi\n", stderr: "" },
  });
  expect(done.output).toMatchObject({ status: "completed", state: { steps: 2 } });
  expect(done.output.output).toBe(
    `done: ${JSON.stringify({ exitCode: 0, stdout: "hi\n", stderr: "" })}`,
  );
  const kinds = applyUpdates(first.before, done.output.transcript!).map((entry: any) => entry.kind);
  expect(kinds).toEqual(["input", "input", "candidate", "tool-results", "candidate", "final"]);

  // The run starts over after the tool's outcome: the first model call comes with the run, the
  // tool is answered from the journal, and only the last model call reaches the gate.
  rmSync(ran);
  const journal = new Map([...first.journal].filter(([id]) => id !== "t1:0:model:1"));
  const model0 = journal.get("t1:0:model:0")!;
  const again = fakeCore(
    turn(message, [
      {
        effectId: "t1:0:model:0",
        requestHash: model0.requestHash,
        outcome: { value: model0.value },
      },
    ]),
    { journal },
  );
  const calls = gate.calls.length;
  void serve(again.harness, { name: "minimal", gatesUrl: gate.url });
  const replayed = await again.settled;

  expect(again.order).toEqual([`intent ${toolId}`, "intent t1:0:model:1", "outcome t1:0:model:1"]);
  expect(existsSync(ran)).toBe(false);
  expect(gate.calls.slice(calls).map((call) => call.headers["idempotency-key"])).toEqual([
    "t1:0:model:1",
  ]);
  expect(replayed.output.transcript).toEqual(done.output.transcript);
});

it("ends a cancelled turn as cancelled and stops its call at the gate", async () => {
  const gate = await fakeGate(() => undefined);
  const core = fakeCore(turn("hi"));
  void serve(core.harness, { name: "minimal", gatesUrl: gate.url });
  while (gate.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  core.core.notify("cancel", { runId: "r1", reason: "cancel" });
  const { method, output } = await core.settled;

  expect(method).toBe("turn.failed");
  expect(output).toEqual({ runId: "r1", status: "cancelled" });
  expect(core.order).toEqual(["intent t1:0:model:0", "outcome t1:0:model:0"]);
  expect(gate.calls.at(-1)!.path).toBe("/nylorun/v1/model-calls/t1%3A0%3Amodel%3A0/cancel");
});

it("sends a message's files the turn's model reads, and a line for the rest (protocol 15)", () => {
  const media = (mediaType: string, name: string) => ({
    type: "media" as const,
    mediaType,
    reference: { artifactId: `af_${name}`, version: 1, name, size: 3 },
  });
  const transcript = [
    {
      kind: "input" as const,
      turnId: "t1",
      event: {
        kind: "user-message" as const,
        content: [
          { type: "text" as const, text: "look" },
          media("image/png", "a.png"),
          media("application/pdf", "b.pdf"),
          media("text/csv", "c.csv"),
          media("image/bmp", "d.bmp"),
        ],
      },
    },
  ];
  const content = (model?: TurnStart["model"]) =>
    (promptOf([], transcript, model)[0] as { content: unknown[] }).content;
  const line = (name: string, type: string) => ({ type: "text", text: `[File "${name}" (${type}) not shown]` });
  // Without a descriptor: text and images.
  expect(content()).toEqual([
    { type: "text", text: "look" },
    media("image/png", "a.png"),
    line("b.pdf", "application/pdf"),
    line("c.csv", "text/csv"),
    line("d.bmp", "image/bmp"),
  ]);
  const model = { provider: "p", id: "m", inputs: ["text", "pdf"] as const, contextWindow: 1_000, maxOutputTokens: 100 };
  expect(content({ ...model, inputs: [...model.inputs] })).toEqual([
    { type: "text", text: "look" },
    line("a.png", "image/png"),
    media("application/pdf", "b.pdf"),
    line("c.csv", "text/csv"),
    line("d.bmp", "image/bmp"),
  ]);
});
