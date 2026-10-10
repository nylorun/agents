import { afterEach, describe, expect, it } from "vitest";
import { Agent, createClient } from "@nylorun/agents";
import type { HostEffect } from "@nylorun/harness/run";
import type { ModelProvider } from "../src/core/provider.js";
import { startTestTenant } from "./support/tenant.js";

/**
 * Flow Agents Phase 3, end to end: a ReAct agent delegates to a flow agent. The flow runs
 * in its own linked session (its agents in theirs), and its output returns to the parent
 * as the tool result.
 */

const APP = "flow-subagents-app-token-aaaaaaa";

type Prompt = { kind?: string; content?: { text?: string }[] }[];
const textOf = (prompt: Prompt, kind: string) =>
  prompt
    .filter((item) => item.kind === kind)
    .flatMap((item) => item.content ?? [])
    .map((part) => part.text ?? "")
    .join("");

/** `lead` delegates once, then answers with the tool result; the flow's agents echo. */
const provider = (async (effect: HostEffect) => {
  const prompt = (effect.input as { prompt?: Prompt }).prompt ?? [];
  const results = textOf(prompt, "tool-result");
  switch (effect.agentId) {
    case "lead":
      return results
        ? { output: [{ type: "text", text: `lead heard: ${results}` }] }
        : {
            output: [
              { type: "tool-call", id: "c1", name: "research", args: { task: "Why is the sky blue?" } },
            ],
          };
    case "searcher":
      return { output: [{ type: "text", text: `notes on ${textOf(prompt, "message")}` }] };
    case "summarizer":
      return { output: [{ type: "text", text: `summary of ${textOf(prompt, "message")}` }] };
    default:
      throw new Error(`unexpected agent ${effect.agentId}`);
  }
}) as ModelProvider;

const research = Agent({ id: "research", description: "Researches a question and reports back." }).pipe(
  Agent({ id: "searcher" }).instructions("Search."),
  Agent({ id: "summarizer" }).instructions("Summarize.")
);
const lead = Agent({ id: "lead" }).instructions("Delegate research.").subagents(research).build();

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("a flow agent as a subagent, end to end", { timeout: 30_000 }, () => {
  it("runs the flow in a linked session and returns its output to the parent", async () => {
    const tenant = await startTestTenant({ applicationKey: APP, modelProvider: provider });
    cleanups.push(() => tenant.close());
    const client = createClient({ url: tenant.url, key: tenant.applicationKey, tenant: tenant.tenantId });
    await client.saveAgent(lead, { implementationVersion: "phase-3" });

    // The flow is embedded in the parent's manifest, not registered on its own.
    const { agents } = await client.listAgents();
    expect(agents.map((a) => a.manifest.id)).toEqual(["lead"]);

    const session = await client.createSession({ id: "lead-1", agentId: "lead", ownerUserId: "user-1" });
    const events: { type: string; sessionId: string; payload: any }[] = [];
    const done = (async () => {
      for await (const event of session.observe({ follow: true })) {
        events.push({ type: event.type, sessionId: event.sessionId, payload: event.payload });
        if (event.sessionId === session.id && (event.type === "turn.completed" || event.type === "turn.failed"))
          return true;
      }
      return false;
    })();
    await session.input("Research the sky.", { idempotencyKey: "msg-1" });
    const settled = await Promise.race([done, new Promise<false>((r) => setTimeout(() => r(false), 8_000))]);
    if (!settled)
      throw new Error(`turn did not settle; events:\n${events.map((e) => `${e.sessionId} ${e.type}`).join("\n")}`);

    const last = events.at(-1)!;
    expect(last.type, JSON.stringify(last.payload)).toBe("turn.completed");
    // The summarizer sees the flow's input beside the searcher's notes (D12).
    const summary = "summary of Original request:\nWhy is the sky blue?\n\nnotes on Why is the sky blue?";
    expect(last.payload.output).toBe(`lead heard: ${JSON.stringify(summary)}`);

    const linked = events.find((e) => e.sessionId === session.id && e.type === "node.agent")!;
    expect(linked.payload.path).toBe("lead/research");
    const flowSession = linked.payload.sessionId as string;
    // The flow's own session: a workflow session whose agents are linked in turn.
    const flow = await client.session(flowSession).inspect();
    expect(flow).toMatchObject({ agentId: "research", status: "completed" });
    const flowEvents: { type: string; payload: any }[] = [];
    for await (const event of client.session(flowSession).observe()) {
      flowEvents.push({ type: event.type, payload: event.payload });
      if (event.type === "turn.completed" || event.type === "turn.failed") break;
    }
    expect(flowEvents.filter((e) => e.type === "node.agent").map((e) => e.payload.path)).toEqual([
      "searcher",
      "summarizer",
    ]);
    expect(flowEvents.at(-1)?.payload.output).toBe(summary);
    expect(events.filter((e) => e.sessionId === session.id).map((e) => e.type)).toEqual(
      expect.arrayContaining(["delegation.started", "delegation.completed"])
    );
  });

  it("cancels the running flow when the parent is cancelled", async () => {
    let started!: () => void;
    const searching = new Promise<void>((resolve) => (started = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    // The searcher's model call hangs until its turn is aborted (or the test ends).
    const stalled = (async (effect: HostEffect, signal: AbortSignal) => {
      if (effect.agentId === "searcher") {
        started();
        await Promise.race([
          released,
          new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
        ]);
        throw new Error("aborted");
      }
      return provider(effect, signal);
    }) as ModelProvider;
    const tenant = await startTestTenant({ applicationKey: APP, modelProvider: stalled });
    cleanups.push(() => tenant.close());
    cleanups.push(async () => release());
    const client = createClient({ url: tenant.url, key: tenant.applicationKey, tenant: tenant.tenantId });
    await client.saveAgent(lead, { implementationVersion: "phase-3" });
    const session = await client.createSession({ id: "lead-2", agentId: "lead", ownerUserId: "user-1" });
    await session.input("Research the sky.", { idempotencyKey: "msg-1" });
    await searching;

    let flowSession: string | undefined;
    for await (const event of session.observe()) {
      if (event.type === "node.agent") {
        flowSession = (event.payload as { sessionId: string }).sessionId;
        break;
      }
    }
    await session.cancel({ idempotencyKey: "cancel-1" });
    const deadline = Date.now() + 5_000;
    let status = "";
    while (Date.now() < deadline) {
      status = (await client.session(flowSession!).inspect()).status;
      if (status === "cancelled") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(status).toBe("cancelled");
  });
});
