import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, tool, createClient, type BuiltWorkflow } from "@nylorun/agents";
import { startTestTenant } from "./support/tenant.js";
import { serveAgents } from "./support/endpoint.js";

/**
 * A flow agent's tool step that asks (`ctx.approve`, `ctx.ask`) pauses the flow's own session
 * with a wait; `approve`/`respond` on that session runs the tool again with its resume token.
 */

const APP = "workflow-tool-waits-app-token-aaaa";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

type Event = { type: string; sessionId: string; payload: any };

/** Tool runs per tool name, counted in the Action endpoint. */
const runs = new Map<string, number>();
const ran = (name: string) => runs.set(name, (runs.get(name) ?? 0) + 1);

const prepare = tool({
  name: "prepare",
  input: z.object({ x: z.string() }),
  async run({ x }) {
    ran("prepare");
    return { x: x.toUpperCase() };
  },
});

const publish = tool({
  name: "publish",
  input: z.object({ x: z.string() }),
  async run({ x }, ctx) {
    ran("publish");
    const memo = await ctx.step("draft", () => `draft:${x}`);
    if (!(await ctx.approve(`Publish ${x}?`))) return { ok: false };
    return { ok: true, x, memo };
  },
});

const greet = tool({
  name: "greet",
  input: z.object({ x: z.string() }),
  async run({ x }, ctx) {
    ran("greet");
    const name = await ctx.ask("Who is it for?", { field: "name" });
    if (!(await ctx.approve(`Greet ${String(name)}?`))) return { sent: false };
    return { sent: true, text: `${x}, ${String(name)}` };
  },
});

async function start(workflow: BuiltWorkflow) {
  runs.clear();
  const tenant = await startTestTenant({
    applicationKey: APP,
    modelProvider: async () => ({ output: [{ type: "text", text: "unused" }] }),
  });
  cleanups.push(() => tenant.close());
  const client = createClient({ url: tenant.url, key: tenant.applicationKey, tenant: tenant.tenantId });
  const connection = serveAgents({ agents: [workflow], application: client, implementationVersion: "v1" });
  cleanups.push(() => connection.close());
  await connection.ready;
  const session = await client.createSession({ id: "flow-session", agentId: workflow.id, ownerUserId: "user-1" });
  const events: Event[] = [];
  // Ends when the tenant closes.
  void (async () => {
    for await (const event of session.observe())
      events.push({ type: event.type, sessionId: event.sessionId, payload: event.payload });
  })().catch(() => undefined);

  /** Waits for the next turn end (`turn.paused`, `turn.completed`, `turn.failed`) after `from`. */
  async function next(from: number): Promise<Event & { index: number }> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const index = events.findIndex(
        (e, i) =>
          i >= from &&
          e.sessionId === session.id &&
          ["turn.paused", "turn.completed", "turn.failed"].includes(e.type)
      );
      if (index >= 0) return { ...events[index]!, index };
      await new Promise((r) => setTimeout(r, 20));
    }
    const view = await session.inspect();
    throw new Error(
      `no turn end (status ${view.status}); events:\n` +
        events.map((e) => `${e.type} ${JSON.stringify(e.payload)}`).join("\n")
    );
  }

  return { session, events, next };
}

/** The one wait of a paused flow session, from its view. */
async function onlyWait(session: { pending(): Promise<unknown> }) {
  const waits = (await session.pending()) as any[];
  expect(waits).toHaveLength(1);
  return waits[0] as { interactionId: string; kind: string; path: string; interaction: any };
}

const flow = (step: Parameters<ReturnType<typeof Agent>["step"]>[0]) =>
  Agent({ id: "f" })
    .step(prepare)
    .step(step)
    .build();

describe("flow tool step waits", { timeout: 30_000 }, () => {
  it("pauses on ctx.approve and completes the tool once approved", async () => {
    const { session, events, next } = await start(flow(publish));
    await session.input({ x: "post" }, { idempotencyKey: "msg-1" });

    const paused = await next(0);
    expect(paused.type, JSON.stringify(paused.payload)).toBe("turn.paused");
    expect(paused.payload.interactions).toEqual([
      expect.objectContaining({
        interaction: expect.objectContaining({ kind: "approval", prompt: "Publish POST?" }),
        status: "interaction",
        path: "publish",
        toolName: "publish",
      }),
    ]);
    expect(JSON.stringify(paused.payload)).not.toContain("_nylorun");
    const view = await session.inspect();
    expect(view.status).toBe("paused");
    const wait = await onlyWait(session);
    expect(wait).toMatchObject({ kind: "approval", path: "publish" });
    expect(wait.interaction).toMatchObject({ prompt: "Publish POST?" });
    expect(JSON.stringify(wait)).not.toContain("_nylorun");
    expect(events.some((e) => e.type === "turn.completed")).toBe(false);

    await session.approve(wait.interactionId, true, { idempotencyKey: "approve-1" });
    const done = await next(paused.index + 1);
    expect(done.type, JSON.stringify(done.payload)).toBe("turn.completed");
    // The step memo came back with the resume token; the token itself stays out of the output.
    expect(done.payload.output).toEqual({ ok: true, x: "POST", memo: "draft:POST" });
    // The earlier step replayed from the journal; the tool that asked ran again.
    expect(runs.get("prepare")).toBe(1);
    expect(runs.get("publish")).toBe(2);
    expect((await session.inspect()).waits ?? []).toEqual([]);
  });

  it("settles a rejected approval as a denied tool step without running the tool again", async () => {
    const { session, next } = await start(flow(publish));
    await session.input({ x: "post" }, { idempotencyKey: "msg-1" });
    const paused = await next(0);
    expect(paused.type).toBe("turn.paused");
    const wait = await onlyWait(session);

    await session.approve(wait.interactionId, false, { idempotencyKey: "deny-1" });
    const done = await next(paused.index + 1);
    expect(done.type, JSON.stringify(done.payload)).toBe("turn.failed");
    expect(done.payload.error).toMatchObject({ code: "tool.denied", path: "publish" });
    expect(runs.get("publish")).toBe(1);
  });

  it("pauses on ctx.ask, then on a second wait in the same tool, and resumes each", async () => {
    const { session, next } = await start(flow(greet));
    await session.input({ x: "hi" }, { idempotencyKey: "msg-1" });

    const asked = await next(0);
    expect(asked.type, JSON.stringify(asked.payload)).toBe("turn.paused");
    const question = await onlyWait(session);
    expect(question).toMatchObject({ kind: "response", path: "greet" });
    expect(question.interaction).toMatchObject({ prompt: "Who is it for?", metadata: { field: "name" } });
    // An approve does not answer a question.
    await expect(
      session.approve(question.interactionId, true, { idempotencyKey: "wrong-kind" })
    ).rejects.toThrow();

    await session.respond(question.interactionId, "Ada", { idempotencyKey: "respond-1" });
    const approval = await next(asked.index + 1);
    expect(approval.type, JSON.stringify(approval.payload)).toBe("turn.paused");
    const gate = await onlyWait(session);
    expect(gate.interactionId).not.toBe(question.interactionId);
    expect(gate.interaction).toMatchObject({ kind: "approval", prompt: "Greet Ada?" });
    // The answered interaction is gone.
    await expect(
      session.respond(question.interactionId, "Bob", { idempotencyKey: "respond-stale" })
    ).rejects.toThrow();

    await session.approve(gate.interactionId, true, { idempotencyKey: "approve-1" });
    const done = await next(approval.index + 1);
    expect(done.type, JSON.stringify(done.payload)).toBe("turn.completed");
    expect(done.payload.output).toEqual({ sent: true, text: "HI, Ada" });
    expect(JSON.stringify(done.payload)).not.toContain("_nylorun");
    expect(runs.get("prepare")).toBe(1);
    expect(runs.get("greet")).toBe(3);
  });
});
