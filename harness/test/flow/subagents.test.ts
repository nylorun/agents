import { describe, expect, it } from "vitest";
import { Agent, type ModelAdapter, type ModelCall } from "@nylorun/core/define";
import {
  bindingFromAgent,
  createDurableCheckpoint,
  run,
  runDurable,
  type DurableHost,
  type EffectResolution,
  type HostEffect,
} from "../../src/run/index.js";

/**
 * Flow Agents Phase 3: a flow agent used as a tool runs in its own linked session. The
 * durable engine asks the host for it with one `agent` effect and settles the tool call
 * with the flow's output.
 */

type Text = { readonly type: string; readonly text?: string };
const toolResults = (call: ModelCall) =>
  call.prompt.flatMap((item) =>
    item.kind === "tool-result"
      ? [{ status: item.status, text: (item.content as Text[]).map((p) => p.text ?? "").join("") }]
      : [],
  );

const research = Agent({ id: "research", description: "Researches a question." })
  .pipe(Agent({ id: "searcher" }).instructions("Search."))
  .pipe(Agent({ id: "summarizer" }).instructions("Summarize."));
const lead = Agent({ id: "lead" }).instructions("Delegate research.").subagents(research).build();

/** The lead calls `research` once, then answers with whatever came back. */
const model: ModelAdapter = async (call) => {
  const done = toolResults(call);
  if (!done.length)
    return { output: [{ type: "tool-call", id: "c1", name: "research", args: { task: "Why?" } }] };
  return `${done[0]!.status}: ${done[0]!.text}`;
};

function host(flow: (effect: HostEffect) => EffectResolution) {
  const journal = new Map<string, EffectResolution>();
  const seen: HostEffect[] = [];
  const durable: DurableHost = {
    async resolveEffect(effect) {
      const recorded = journal.get(effect.effectId);
      if (recorded) return recorded;
      seen.push(effect);
      const resolution: EffectResolution =
        effect.kind === "model"
          ? {
              status: "completed",
              outcome: { value: await model(effect.input as ModelCall, {} as any) },
            }
          : effect.kind === "delegation"
            ? { status: "completed", outcome: { value: null } }
            : flow(effect);
      journal.set(effect.effectId, resolution);
      return resolution;
    },
  };
  return { durable, journal, seen };
}

const checkpoint = () =>
  createDurableCheckpoint({ manifest: lead.manifest, sessionId: "s", turnId: "t", input: "go" });

describe("a flow agent used as a tool", () => {
  it("waits on one agent effect, then settles the tool call with the flow's output", async () => {
    const { durable, journal, seen } = host(() => ({ status: "pending" }));
    const first = await runDurable({
      manifest: lead.manifest,
      checkpoint: checkpoint(),
      host: durable,
    });
    expect(first.status).toBe("waiting");
    const flow = seen.find((effect) => effect.kind === "agent")!;
    expect(flow).toMatchObject({
      agentId: "lead",
      input: { agentId: "research", input: "Why?", path: "lead/research" },
      context: { role: "delegate" },
      agent: { id: "research", path: "lead/research" },
    });
    expect(flow.effectId).toMatch(/:agent:.+:flow$/);

    journal.set(flow.effectId, { status: "completed", outcome: { value: "because" } });
    const done = await runDurable({
      manifest: lead.manifest,
      checkpoint: checkpoint(),
      host: durable,
    });
    expect(done.status).toBe("completed");
    if (done.status !== "completed" || done.result.status !== "completed") return;
    expect(done.result.output).toBe('completed: "because"');
    expect(seen.filter((effect) => effect.kind === "delegation")).toHaveLength(2);
  });

  it("fails the tool call, not the parent, when the flow fails", async () => {
    const { durable } = host(() => ({
      status: "completed",
      outcome: { value: { kind: "failed", code: "agent.failed", message: "searcher broke" } },
    }));
    const done = await runDurable({
      manifest: lead.manifest,
      checkpoint: checkpoint(),
      host: durable,
    });
    expect(done.status).toBe("completed");
    if (done.status !== "completed" || done.result.status !== "completed") return;
    expect(done.result.output).toContain("agent.failed: searcher broke");
  });

  it("is refused in a local run, which has no flow engine", async () => {
    const result = await run({ binding: bindingFromAgent(lead), input: "go", onModelCall: model });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(String(result.output)).toContain("flow agents used as tools run on the Runtime");
  });
});
