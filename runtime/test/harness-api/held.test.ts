/**
 * Held runs (F6.2 W6): a run whose Action tool is pending waits in its lease for the outcome
 * (`effect.resolved`) and goes on in the same segment, instead of ending it and being replayed.
 * Past `actionHoldMs` the segment ends as waiting, as before, and the outcome resumes it by
 * replay.
 */
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { Agent, tool } from "@nylorun/core/define";
import type { Frame } from "@nylorun/core/harness-api";
import type { ModelProvider } from "../../src/core/provider.js";
import { accepted, registerEndpoint, startEndpoint } from "../support/endpoint.js";
import { startTestTenant } from "../support/tenant.js";

const agent = Agent({ id: "notes", name: "Notes", instructions: "Keep notes." })
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

async function scenario(options: { actionHoldMs?: number; answerAfterMs: number }) {
  const frames: Frame[] = [];
  const runtime = await startTestTenant({
    modelProvider: model,
    harness: "json",
    harnessTap: (frame) => frames.push(frame),
    ...(options.actionHoldMs === undefined ? {} : { actionHoldMs: options.actionHoldMs }),
  });
  cleanups.push(() => runtime.close());
  const endpoint = await startEndpoint({ runtime, answer: () => accepted });
  cleanups.push(() => endpoint.close());
  const api = (method: string, path: string, body?: unknown) =>
    fetch(`${runtime.url}${path}`, {
      method,
      headers: runtime.headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).then(async (response) => ({ status: response.status, body: (await response.json()) as any }));
  await api("PUT", "/v1/agents/notes", { requestId: "a", manifest: agent.manifest, implementationVersion: "dev" });
  await registerEndpoint(runtime, "notes", endpoint.url);
  await api("PUT", "/v1/sessions/s1", { requestId: "s", agentId: "notes", ownerUserId: "u" });
  await api("POST", "/v1/sessions/s1/commands", {
    type: "message",
    requestId: "m1",
    idempotencyKey: "m1",
    content: "note",
  });
  const delivery = await endpoint.next();
  await new Promise((resolve) => setTimeout(resolve, options.answerAfterMs));
  const statusWhilePending = (await api("GET", "/v1/sessions/s1")).body.status;
  expect((await delivery.result({ kind: "completed", output: { saved: true } })).status).toBe(200);
  let view: any;
  for (let i = 0; i < 400; i += 1) {
    view = (await api("GET", "/v1/sessions/s1")).body;
    if (view.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(view.status).toBe("completed");
  const runs = frames.filter((frame) => frame.t === "res" && frame.ok && (frame.r as any)?.input?.type).length;
  const resolved = frames.filter((frame) => frame.t === "msg" && frame.m === "effect.resolved").length;
  const outputs = frames
    .filter((frame) => frame.t === "req" && (frame.m.startsWith("turn.") || frame.m === "checkpoint"))
    .map((frame) => [(frame as { m: string }).m, ((frame as { p: any }).p.status as string) ?? ""]);
  return { runs, resolved, outputs, statusWhilePending };
}

it("holds a run while its Action is pending, and goes on with the outcome in the same lease", async () => {
  const held = await scenario({ answerAfterMs: 300 });
  expect(held.statusWhilePending).toBe("running");
  expect(held.runs).toBe(1);
  expect(held.resolved).toBe(1);
  expect(held.outputs).toEqual([["turn.completed", "completed"]]);
}, 30_000);

it("ends the segment as waiting once the hold runs out, and resumes it by replay", async () => {
  const replayed = await scenario({ actionHoldMs: 200, answerAfterMs: 600 });
  expect(replayed.statusWhilePending).toBe("waiting");
  expect(replayed.runs).toBe(2);
  expect(replayed.outputs).toEqual([
    ["turn.waiting", "waiting"],
    ["turn.completed", "completed"],
  ]);
}, 30_000);
