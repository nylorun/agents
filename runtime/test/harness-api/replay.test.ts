/**
 * Replay over the Harness API (F6.1), in JSON mode: a turn calls the model, waits on an Action,
 * and resumes by replay once the Action's outcome is in. The harness asks core only about
 * effects it has no outcome for, never sends a prompt, and reads the transcript once.
 */
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { Agent, tool } from "@nylorun/core/define";
import type { Frame } from "@nylorun/core/harness-api";
import type { ModelProvider } from "../../src/core/provider.js";
import { completed, registerEndpoint, startEndpoint } from "../support/endpoint.js";
import { withTestSessionStore } from "../support/store.js";
import { startTestTenant } from "../support/tenant.js";

const INSTRUCTIONS = "Keep notes. (instructions-marker-7f3a)";
const agent = Agent({ id: "notes", name: "Notes", instructions: INSTRUCTIONS })
  .use({
    id: "notes",
    tools: [
      tool({
        name: "save",
        input: z.object({ note: z.string() }),
        output: z.object({ saved: z.literal(true) }),
        async run() {
          return { saved: true as const };
        },
      }),
    ],
  })
  .build();

const model: ModelProvider = async (effect) => {
  const call = effect.input as { prompt?: { kind?: string }[] };
  if (call.prompt?.at(-1)?.kind === "tool-result") return { output: [{ type: "text", text: "saved" }] };
  return { output: [{ type: "tool-call", id: "call-1", name: "save", args: { note: "hi" } }] };
};

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

it("replays a turn without its prompts: intents only for new effects, the transcript read once", async () => {
  const frames: { frame: Frame; from: string; bytes: number }[] = [];
  const runtime = await startTestTenant({
    modelProvider: model,
    harness: "json",
    // A run that held for the Action would go on without a replay (F6.2): this test replays.
    actionHoldMs: 0,
    harnessTap: (frame, from, bytes) => frames.push({ frame, from, bytes: bytes ?? 0 }),
  });
  cleanups.push(() => runtime.close());
  let answer = false;
  const endpoint = await startEndpoint({
    runtime,
    answer: () => (answer ? completed({ saved: true }) : { status: 202 }),
  });
  cleanups.push(() => endpoint.close());
  const api = (method: string, path: string, body?: unknown) =>
    fetch(`${runtime.url}${path}`, {
      method,
      headers: runtime.headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).then(async (response) => ({ status: response.status, body: (await response.json()) as any }));
  expect(
    (await api("PUT", "/v1/agents/notes", { requestId: "a", manifest: agent.manifest, implementationVersion: "dev" }))
      .status,
  ).toBe(200);
  await registerEndpoint(runtime, "notes", endpoint.url);
  await api("PUT", "/v1/sessions/s1", { requestId: "s", agentId: "notes", ownerUserId: "u" });
  const send = (n: number) =>
    api("POST", "/v1/sessions/s1/commands", {
      type: "message",
      requestId: `m${n}`,
      idempotencyKey: `m${n}`,
      content: `note ${n}`,
    });
  const settled = async () => {
    for (let i = 0; i < 500; i += 1) {
      const { body } = await api("GET", "/v1/sessions/s1");
      if (body.status === "completed") return body;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("the turn did not complete");
  };

  await send(1);
  const delivery = await endpoint.next();
  // While the turn waits on the Action, the model call's journal row holds its hash, no prompt.
  const rows = await withTestSessionStore(runtime, (store) =>
    store.tx((t) => t.effectsForSession<any>("s1", { statuses: ["completed"] })),
  );
  const modelRows = rows.filter((row) => row.request.kind === "model");
  expect(modelRows).toHaveLength(1);
  expect(modelRows[0].requestHash).toMatch(/^[0-9a-f]{64}$/);
  expect(modelRows[0].request).not.toHaveProperty("input");

  expect((await delivery.result({ kind: "completed", output: { saved: true } })).status).toBe(200);
  await settled();
  answer = true;
  await send(2);
  await endpoint.next((d) => d.action.turnId !== delivery.action.turnId);
  await settled();

  const requests = frames.filter(({ frame }) => frame.t === "req").map(({ frame, bytes }) => ({ ...(frame as any), bytes }));
  const intents = requests.filter((request) => request.m === "effect.intent");
  // Each effect is asked about once: the replay resolves the model call and the tool from the
  // outcomes `turn.start` carried.
  const ids = intents.map((request) => request.p.effect.effectId);
  expect(new Set(ids).size).toBe(ids.length);
  expect(intents.map((request) => request.p.effect.kind)).toEqual(["model", "tool", "model", "model", "tool", "model"]);
  for (const intent of intents.filter((request) => request.p.effect.kind === "model")) {
    expect(intent.p.effect).not.toHaveProperty("input");
    expect(intent.bytes).toBeLessThan(1024);
  }
  // No prompt crosses from the harness: the instructions only ever go to it, in `turn.start`.
  for (const { frame, from } of frames)
    if (from === "harness") expect(JSON.stringify(frame)).not.toContain("instructions-marker-7f3a");

  const starts = frames
    .filter(({ frame }) => frame.t === "res" && (frame as any).ok && (frame as any).r?.input?.type)
    .map(({ frame }) => (frame as any).r.input);
  expect(starts.length).toBeGreaterThanOrEqual(4);
  const replayed = starts[1];
  expect(replayed.outcomes.map((outcome: any) => outcome.effectId)).toEqual(ids.slice(0, 2));
  for (const start of starts) expect(start.checkpoint.state?.transcript ?? []).toEqual([]);
  // Cold once; every later run resumes from the harness's cache.
  expect(requests.filter((request) => request.m === "transcript.read").length).toBeLessThanOrEqual(1);
});
