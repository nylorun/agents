import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Agent,
  VerdictSchema,
  tool,
  createClient,
  type BuiltWorkflow,
  type JsonValue,
} from "@nylorun/agents";
import type { HostEffect } from "@nylorun/harness/run";
import type { ModelProvider } from "../src/core/provider.js";
import { startTestTenant } from "./support/tenant.js";

/**
 * Flow agents, end to end: a flow agent is saved as one workflow manifest v3 document, its
 * leaves run from the embedded `agents`, and their sessions are named by leaf paths, so
 * wrapping a step in a Loop keeps the step's session. The flow calls no developer code:
 * every stage is an agent turn, and a definition with a tool stage is refused.
 */

const APP = "workflow-v3-app-token-aaaaaaaaaaa";

/** A tool stage: it runs the developer's code, so the Runtime refuses a flow that has one. */
const split = tool({
  name: "split",
  description: "Split text into words.",
  input: z.object({ text: z.string() }),
  output: z.object({ items: z.array(z.object({ word: z.string() })) }),
  async run({ text }) {
    return { items: text.split(" ").filter(Boolean).map((word) => ({ word })) };
  },
});

type Prompt = { kind?: string; role?: string; content?: { text?: string }[] }[];
const messagesOf = (effect: HostEffect) =>
  ((effect.input as { prompt?: Prompt }).prompt ?? [])
    .filter((item) => item.kind === "message" && item.role === "user")
    .map((item) => (item.content ?? []).map((part) => part.text ?? "").join(""));

/** Each agent answers by id; `judge` returns the verdicts given, one per attempt. */
function model(verdicts: readonly object[] = [{ pass: true }], seen: Record<string, string[]> = {}) {
  let judged = 0;
  return (async (effect: HostEffect) => {
    (seen[effect.agentId] ??= []).push(...messagesOf(effect).slice(-1));
    switch (effect.agentId) {
      case "writer":
        return { output: [{ type: "json", value: { text: "hello big world" } }] };
      case "splitter":
        return {
          output: [
            { type: "json", value: { items: ["hello", "big", "world"].map((word) => ({ word })) } },
          ],
        };
      case "shouter": {
        // Its input is one Map item, `{ word }`, after the original request (D12).
        const word = /"word":\s*"(\w+)"/.exec(messagesOf(effect).at(-1) ?? "")?.[1] ?? "?";
        return { output: [{ type: "json", value: { loud: word.toUpperCase() } }] };
      }
      case "judge":
        return { output: [{ type: "json", value: verdicts[Math.min(judged++, verdicts.length - 1)] }] };
      default:
        return { output: [{ type: "text", text: `${effect.agentId} done` }] };
    }
  }) as ModelProvider;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

type Event = { type: string; sessionId: string; payload: any };

async function run(workflow: BuiltWorkflow, message: string, provider: ModelProvider = model()) {
  const tenant = await startTestTenant({ applicationKey: APP, modelProvider: provider });
  cleanups.push(() => tenant.close());
  const client = createClient({ url: tenant.url, key: tenant.applicationKey, tenant: tenant.tenantId });
  await client.saveAgent(workflow, { implementationVersion: "v3" });

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

const writer = Agent({ id: "writer" }).instructions("Write a sentence.").output(z.object({ text: z.string() }));
const fixer = Agent({ id: "fixer" }).instructions("Fix it.");
const judge = Agent({ id: "judge" }).instructions("Judge the fix.").output(VerdictSchema);
const splitter = Agent({ id: "splitter" })
  .instructions("Split the text into words.")
  .output(z.object({ items: z.array(z.object({ word: z.string() })) }));
const shouter = Agent({ id: "shouter" })
  .instructions("Upper-case the word.")
  .output(z.object({ loud: z.string() }));

describe("workflow manifest v3, end to end", { timeout: 30_000 }, () => {
  it("runs a flow agent: embedded leaves, a Map over the items one of them returns", async () => {
    const desk = Agent({ id: "desk" }).pipe(writer, splitter).map(shouter).build();
    expect(desk.manifest.workflowSchemaVersion).toBe(3);

    const result = await run(desk, "go");
    expect(outputOf(result)).toEqual([{ loud: "HELLO" }, { loud: "BIG" }, { loud: "WORLD" }]);
    const paths = linked(result.events).map((l) => l.path);
    expect(paths.slice(0, 2)).toEqual(["writer", "splitter"]);
    // Map items run together: their sessions start in any order.
    expect(paths.slice(2)).toEqual([0, 1, 2].map(() => expect.stringContaining("shouter")));
    // A step outside a Loop is not a Loop iteration.
    expect(result.events.some((e) => e.type === "loop.iteration")).toBe(false);
    expect(result.events.some((e) => e.type.startsWith("action."))).toBe(false);

    // Leaves are embedded: only the flow agent is in the catalog.
    const { agents } = await result.client.listAgents();
    expect(agents.map((a) => a.manifest.id)).toEqual(["desk"]);
  });

  it("refuses a flow agent with a tool stage: it would run the developer's code", async () => {
    const desk = Agent({ id: "desk" }).pipe(writer, split).build();
    const tenant = await startTestTenant({ applicationKey: APP, modelProvider: model() });
    cleanups.push(() => tenant.close());
    const client = createClient({ url: tenant.url, key: tenant.applicationKey, tenant: tenant.tenantId });
    await expect(client.saveAgent(desk)).rejects.toThrow(/tool stage 'split'.*runs your code/);
    // The Runtime refuses it too, when a client sends it anyway.
    const response = await fetch(`${tenant.url}/v1/agents/desk`, {
      method: "PUT",
      headers: { authorization: `Bearer ${tenant.applicationKey}`, "content-type": "application/json" },
      body: JSON.stringify({ requestId: "put-desk", manifest: desk.manifest, implementationVersion: "v3" }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/runs agents from their manifests alone/);
    expect((await client.listAgents()).agents).toEqual([]);
  });

  it("shows a later agent the original request beside its own input (D12)", async () => {
    const seen: Record<string, string[]> = {};
    const desk = Agent({ id: "desk" })
      .pipe(Agent({ id: "drafter" }).instructions("Draft."), Agent({ id: "editor" }).instructions("Edit."))
      .build();
    const result = await run(desk, "Write about tides.", model([], seen));
    expect(outputOf(result)).toBe("editor done");
    expect(seen.drafter).toEqual(["Write about tides."]);
    expect(seen.editor).toEqual(["Original request:\nWrite about tides.\n\ndrafter done"]);
  });

  it("keeps a step's session when the step is wrapped in a Loop, and records the verdict", async () => {
    const plain = await run(Agent({ id: "desk" }).pipe(fixer).build(), "fix");
    const looped = await run(Agent({ id: "desk" }).loop(fixer, { verify: judge, max: 2 }).build(), "fix");
    expect(outputOf(plain)).toBe(outputOf(looped));
    const [before] = linked(plain.events);
    const [after, verifier] = linked(looped.events);
    expect(before).toEqual({ path: "fixer", sessionId: expect.any(String) });
    expect(after).toEqual(before);
    expect(verifier).toEqual({ path: "judge", sessionId: expect.any(String) });
    expect(looped.events.filter((e) => e.type === "loop.iteration").map((e) => e.payload.path)).toEqual([
      "@0",
    ]);
    expect(looped.events.filter((e) => e.type === "loop.verified").map((e) => e.payload)).toEqual([
      { path: "@0", n: 1, pass: true },
    ]);
    // The verifier is an agent: no tool ran.
    expect(looped.events.some((e) => e.type.startsWith("tool."))).toBe(false);
  });

  it("retries with the verifier's feedback and stops after max attempts with loop.exhausted", async () => {
    const seen: Record<string, string[]> = {};
    const desk = Agent({ id: "desk" }).loop(fixer, { verify: judge, max: 2, id: "fix" }).build();
    const result = await run(desk, "fix", model([{ pass: false, feedback: "still broken" }], seen));
    expect(result.type).toBe("turn.failed");
    expect(JSON.stringify(result.payload)).toContain("loop.exhausted");
    const fixes = linked(result.events).filter((l) => l.path === "fixer");
    expect(fixes).toHaveLength(2);
    expect(new Set(fixes.map((l) => l.sessionId)).size).toBe(1);
    // The verifier judges each attempt in a fresh session.
    const judged = linked(result.events).filter((l) => l.path === "judge");
    expect(new Set(judged.map((l) => l.sessionId)).size).toBe(2);
    expect(seen.fixer).toEqual(["fix", "Original request:\nfix\n\nstill broken"]);
    expect(result.events.filter((e) => e.type === "loop.verified").map((e) => e.payload)).toEqual([
      { path: "fix", n: 1, pass: false, feedback: "still broken" },
      { path: "fix", n: 2, pass: false, feedback: "still broken" },
    ]);
  });
});
