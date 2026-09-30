import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Agent,
  tool,
  createClient,
  type BuiltWorkflow,
  type JsonValue,
} from "@nylorun/agents";
import { startTestTenant } from "./support/tenant.js";
import { serveAgents, type ServedAgents } from "./support/endpoint.js";

/**
 * Flow Agents Phase 2, end to end: a flow agent is saved as one workflow manifest v2
 * document, its leaves run from the embedded `agents`, and their sessions are named by
 * leaf paths, so wrapping a step in a Loop keeps the step's session.
 */

const APP = "workflow-v2-app-token-aaaaaaaaaaa";

const split = tool({
  name: "split",
  description: "Split text into words.",
  input: z.object({ text: z.string() }),
  output: z.object({ words: z.array(z.string()) }),
  async run({ text }) {
    return { words: text.split(" ").filter(Boolean) };
  },
});

const shout = tool({
  name: "shout",
  description: "Upper-case one word.",
  input: z.object({ word: z.string() }),
  output: z.object({ loud: z.string() }),
  async run({ word }) {
    return { loud: word.toUpperCase() };
  },
});

const textOf = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value
          .map((part) =>
            part && typeof part === "object" && "text" in part ? String(part.text) : ""
          )
          .join("")
      : JSON.stringify(value);

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

type Event = { type: string; sessionId: string; payload: any };

async function run(workflow: BuiltWorkflow, message: string, reply = "hello big world") {
  const tenant = await startTestTenant({
    applicationKey: APP,
    modelProvider: async () => ({ output: [{ type: "text", text: reply }] }),
  });
  cleanups.push(() => tenant.close());
  const client = createClient({ url: tenant.url, key: tenant.applicationKey, tenant: tenant.tenantId });
  const connection: ServedAgents = serveAgents({
    agents: [workflow],
    application: client,
    implementationVersion: "v2",
  });
  cleanups.push(() => connection.close());
  await connection.ready;

  const session = await client.createSession({
    id: "desk-session",
    agentId: workflow.id,
    ownerUserId: "user-1",
  });
  const events: Event[] = [];
  const done = (async () => {
    for await (const event of session.observe()) {
      events.push({ type: event.type, sessionId: event.sessionId, payload: event.payload });
      if (
        event.sessionId === session.id &&
        (event.type === "turn.completed" || event.type === "turn.failed")
      )
        return true;
    }
    return false;
  })();
  await session.input(message, { idempotencyKey: "msg-1" });
  const settled = await Promise.race([
    done,
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 8_000)),
  ]);
  if (!settled) {
    const view = await session.inspect();
    throw new Error(
      `turn did not settle (status ${view.status}); events:\n` +
        events.map((e) => `${e.type} ${JSON.stringify(e.payload)}`).join("\n")
    );
  }
  const last = events.at(-1)!;
  return { type: last.type, payload: last.payload, events, client };
}

function outputOf(result: Awaited<ReturnType<typeof run>>): JsonValue {
  expect(result.type, JSON.stringify(result.payload)).toBe("turn.completed");
  return (result.payload as { output: JsonValue }).output;
}

const linked = (events: readonly Event[]) =>
  events
    .filter((e) => e.type === "node.agent")
    .map((e) => ({ path: e.payload.path as string, sessionId: e.payload.sessionId as string }));

describe("workflow manifest v2, end to end", { timeout: 30_000 }, () => {
  it("runs a flow agent: embedded leaf, stage-keyed functions, a Map over its input", async () => {
    const writer = Agent({ id: "writer" }).instructions("Write a sentence.");
    const desk = Agent({ id: "desk" })
      .step(writer)
      .step(split, { input: ({ input }) => ({ text: textOf(input) }) })
      .map(shout, { input: ({ input }) => input.words.map((word: string) => ({ word })) })
      .build();
    expect(desk.manifest.workflowSchemaVersion).toBe(2);

    const result = await run(desk, "go");
    expect(outputOf(result)).toEqual([{ loud: "HELLO" }, { loud: "BIG" }, { loud: "WORLD" }]);
    expect(linked(result.events).map((l) => l.path)).toEqual(["writer"]);
    const pending = result.events
      .filter((e) => e.type === "action.pending")
      .map((e) => e.payload.key as string);
    expect(pending).toEqual(["split:input", "split", "@2:input", "shout", "shout", "shout"]);
    // A step outside a Loop is not a Loop iteration.
    expect(result.events.some((e) => e.type === "loop.iteration")).toBe(false);

    // Leaves are embedded: only the flow agent is in the catalog.
    const { agents } = await result.client.listAgents();
    expect(agents.map((a) => a.manifest.id)).toEqual(["desk"]);
  });

  it("keeps a step's session when the step is wrapped in a Loop", async () => {
    const fixer = Agent({ id: "fixer" }).instructions("Fix it.");
    const plain = await run(Agent({ id: "desk" }).step(fixer).build(), "fix");
    const looped = await run(
      Agent({ id: "desk" }).loop(fixer, { verify: () => ({ pass: true }), max: 2 }).build(),
      "fix"
    );
    expect(outputOf(plain)).toBe(outputOf(looped));
    const [before] = linked(plain.events);
    const [after] = linked(looped.events);
    expect(before).toEqual({ path: "fixer", sessionId: expect.any(String) });
    expect(after).toEqual(before);
    expect(looped.events.filter((e) => e.type === "loop.iteration").map((e) => e.payload.path)).toEqual([
      "@0",
    ]);
  });

  it("stops a Loop after max attempts with loop.exhausted", async () => {
    const fixer = Agent({ id: "fixer" }).instructions("Fix it.");
    const desk = Agent({ id: "desk" })
      .loop(fixer, { verify: () => ({ pass: false, feedback: "still broken" }), max: 2, id: "fix" })
      .build();
    const result = await run(desk, "fix");
    expect(result.type).toBe("turn.failed");
    expect(JSON.stringify(result.payload)).toContain("loop.exhausted");
    expect(linked(result.events).map((l) => l.path)).toEqual(["fixer", "fixer"]);
    expect(new Set(linked(result.events).map((l) => l.sessionId)).size).toBe(1);
  });
});
