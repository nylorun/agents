import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Chain,
  Map,
  Switch,
  tool,
  createClient,
  connectAgents,
  type AgentConnection,
  type BuiltWorkflow,
  type JsonValue,
} from "@nylorun/agents";
import { startTestTenant } from "./support/tenant.js";

/**
 * End to end: the node keys core registers for workflow functions must be the keys
 * the harness sends, or the executor never finds the function. Covers Map `over`,
 * slot `input`, and a slot `input` wrapping a Map or a Switch (two fn effects on one path).
 */

const APP = "workflow-node-keys-app-token-aaaa";

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

const textOf = (value: JsonValue): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value
          .map((part) =>
            part && typeof part === "object" && "text" in part ? String(part.text) : ""
          )
          .join("")
      : JSON.stringify(value);

const wordsOf = (value: JsonValue) =>
  (value as { words: string[] }).words.map((word) => ({ word }));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function run(workflow: BuiltWorkflow, message: string) {
  const tenant = await startTestTenant({ applicationKey: APP });
  cleanups.push(() => tenant.close());
  const client = createClient({
    url: tenant.url,
    key: tenant.applicationKey,
    tenant: tenant.tenantId,
  });
  const connection: AgentConnection = connectAgents({
    agents: [workflow],
    application: client,
    implementationVersion: "node-keys",
  });
  cleanups.push(() => connection.close());
  await connection.ready;

  const session = await client.createSession({
    id: `${workflow.id}-session`,
    agentId: workflow.id,
    ownerUserId: "user-1",
  });
  const events: { type: string; sessionId: string; payload: unknown }[] = [];
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
  return { type: last.type, payload: last.payload, events };
}

function outputOf(result: Awaited<ReturnType<typeof run>>) {
  expect(result.type, JSON.stringify(result.payload)).toBe("turn.completed");
  return (result.payload as { output: JsonValue }).output;
}

describe("workflow function node keys, end to end", { timeout: 30_000 }, () => {
  it("routes a slot input and a Map over to the executor", async () => {
    const workflow = Chain({
      id: "shouter",
      steps: [
        { run: split, input: ({ value }) => ({ text: textOf(value) }) },
        Map({ id: "each", over: wordsOf, each: shout }),
      ],
    });
    const result = await run(workflow, "hello big world");
    expect(outputOf(result)).toEqual([
      { loud: "HELLO" },
      { loud: "BIG" },
      { loud: "WORLD" },
    ]);
  });

  it("runs a slot input that wraps a Map", async () => {
    const workflow = Chain({
      id: "wrapped-map",
      steps: [
        { run: split, input: ({ value }) => ({ text: textOf(value) }) },
        {
          id: "loud",
          run: Map({ id: "each", over: wordsOf, each: shout }),
          input: ({ value }) => ({
            words: (value as { words: string[] }).words.slice(0, 2),
          }),
        },
      ],
    });
    const result = await run(workflow, "one two three");
    expect(outputOf(result)).toEqual([{ loud: "ONE" }, { loud: "TWO" }]);
  });

  it("runs a slot input that wraps a Switch", async () => {
    const workflow = Chain({
      id: "wrapped-switch",
      steps: [
        {
          id: "route",
          run: Switch({
            id: "pick",
            on: (value) => ((value as { word: string }).word.length > 3 ? "long" : "short"),
            cases: { long: shout, short: split },
          }),
          input: ({ value }) => ({ word: textOf(value), text: textOf(value) }),
        },
      ],
    });
    const result = await run(workflow, "hello");
    expect(outputOf(result)).toEqual({ loud: "HELLO" });
  });
});
