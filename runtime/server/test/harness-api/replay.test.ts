/**
 * Replay over the Harness API (F6.1), in JSON mode: a turn calls the model, delegates to a
 * subagent, and resumes by replay once the subagent's linked session has answered. The harness
 * asks core only about effects it has no outcome for, never sends a prompt, and reads the
 * transcript once.
 */
import { afterEach, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import type { Frame } from "@nylorun/core/harness-api";
import type { ModelProvider } from "../../src/core/provider.js";
import { withTestSessionStore } from "../support/store.js";
import { startTestTenant } from "../support/tenant.js";

const INSTRUCTIONS = "Keep notes. (instructions-marker-7f3a)";
const keeper = Agent({ id: "keeper", description: "Keeps one note." }).pipe(
  Agent({ id: "keep" }).instructions("Keep the note."),
);
const agent = Agent({ id: "notes", name: "Notes" }).instructions(INSTRUCTIONS).subagents(keeper).build();

let release: (() => void) | undefined;
const model: ModelProvider = async (effect) => {
  if (effect.agentId === "keep") {
    // The subagent answers once the test lets it: until then the parent's run has ended.
    await new Promise<void>((resolve) => (release = resolve));
    return { output: [{ type: "text", text: "kept" }] };
  }
  const call = effect.input as { prompt?: { kind?: string }[] };
  if (call.prompt?.at(-1)?.kind === "tool-result") return { output: [{ type: "text", text: "saved" }] };
  return { output: [{ type: "tool-call", id: "call-1", name: "keeper", args: { task: "hi" } }] };
};

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  release?.();
  release = undefined;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

it("replays a turn without its prompts: intents only for new effects, the transcript read once", async () => {
  const frames: { frame: Frame; from: string; bytes: number }[] = [];
  const runtime = await startTestTenant({
    modelProvider: model,
    harness: "json",
    harnessTap: (frame, from, bytes) => frames.push({ frame, from, bytes: bytes ?? 0 }),
  });
  cleanups.push(() => runtime.close());
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
  await api("PUT", "/v1/sessions/s1", { requestId: "s", agentId: "notes", ownerUserId: "u" });
  const send = (n: number) =>
    api("POST", "/v1/sessions/s1/commands", {
      type: "message",
      requestId: `m${n}`,
      idempotencyKey: `m${n}`,
      content: `note ${n}`,
    });
  const until = async (done: () => boolean | Promise<boolean>, what: string) => {
    for (let i = 0; i < 500; i += 1) {
      if (await done()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  const completed = async () => (await api("GET", "/v1/sessions/s1")).body.status === "completed";
  /** Lets the subagent answer, then waits for the parent's turn to complete. */
  const answer = async () => {
    await until(() => release !== undefined, "the subagent's model call");
    const go = release!;
    release = undefined;
    go();
    await until(completed, "the turn to complete");
  };

  await send(1);
  await until(() => release !== undefined, "the subagent's model call");
  // While the turn waits on its subagent, the model call's journal row holds its hash, no prompt.
  const rows = await withTestSessionStore(runtime, (store) =>
    store.tx((t) => t.effectsForSession<any>("s1", { statuses: ["completed"] })),
  );
  const modelRows = rows.filter((row) => row.request.kind === "model");
  expect(modelRows).toHaveLength(1);
  expect(modelRows[0].requestHash).toMatch(/^[0-9a-f]{64}$/);
  expect(modelRows[0].request).not.toHaveProperty("input");

  await answer();
  await send(2);
  await answer();

  const requests = frames.filter(({ frame }) => frame.t === "req").map(({ frame, bytes }) => ({ ...(frame as any), bytes }));
  const intents = requests.filter((request) => request.m === "effect.intent");
  // Each effect is asked about once: the replay resolves the model call and the delegation from
  // the outcomes `turn.start` carried.
  const ids = intents.map((request) => request.p.effect.effectId);
  expect(new Set(ids).size).toBe(ids.length);
  const parent = intents.filter((request) => request.p.effect.sessionId === "s1");
  const turn = ["model", "delegation", "agent", "delegation", "model"];
  expect(parent.map((request) => request.p.effect.kind)).toEqual([...turn, ...turn]);
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
  // The parent runs twice a turn: once until it waits on the subagent, once replayed after it.
  const parentStarts = starts.filter((start) => start.manifest?.id === "notes");
  expect(parentStarts).toHaveLength(4);
  const replayed = parentStarts[1];
  expect(replayed.outcomes.map((outcome: any) => outcome.effectId).sort()).toEqual(
    parent.slice(0, 3).map((request) => request.p.effect.effectId).sort(),
  );
  for (const start of starts) expect(start.checkpoint.state?.transcript ?? []).toEqual([]);
  // Cold once; every later run resumes from the harness's cache.
  expect(requests.filter((request) => request.m === "transcript.read").length).toBeLessThanOrEqual(1);
});
