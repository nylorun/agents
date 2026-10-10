import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, tool, type ModelAdapter, type ModelCall } from "@nylorun/core/define";
import {
  bindingFromAgent,
  createDurableCheckpoint,
  run,
  runDurable,
  type DurableHost,
  type EffectResolution,
  type HostEffect,
} from "../src/run/index.js";
import type { ExecutionEvent } from "../src/types/execution.js";

type Text = { readonly type: string; readonly text?: string };
const text = (content: readonly Text[]) => content.map((part) => part.text ?? "").join("");
const userText = (call: ModelCall) =>
  text(
    (call.prompt.find((item) => item.kind === "message" && item.role === "user")?.content ??
      []) as Text[],
  );
const results = (call: ModelCall) =>
  call.prompt.flatMap((item) =>
    item.kind === "tool-result"
      ? [{ status: item.status, text: text(item.content as Text[]) }]
      : [],
  );
/** The model reads tool results as JSON: a string answer, or a failure with its message. */
const decode = (raw: string) => {
  const value = JSON.parse(raw);
  return typeof value === "string" ? value : (value.message ?? raw);
};
const isChild = (call: ModelCall) => call.tools.some((item) => item.name === "search_orders");

const search = tool({
  name: "search_orders",
  description: "Search orders.",
  input: z.object({ query: z.string() }),
  run: async ({ query }, ctx) => ({ found: query, agent: ctx.agent?.path ?? null }),
});

function agents(options: { childOutput?: z.ZodType; childTools?: readonly any[] } = {}) {
  const researcher = Agent({
    id: "researcher",
    description: "Investigates one order.",
    instructions: "Investigate.",
    tools: options.childTools ?? [search],
    ...(options.childOutput ? { outputSchema: options.childOutput } : {}),
  });
  return Agent({ id: "support", instructions: "Delegate.", tools: [researcher] }).build();
}

/** Parent fans out to two children; each child searches once, then answers. */
function scripted(
  childAnswer: (task: string, found: string) => string = (task) => `answer ${task}`,
) {
  const adapter: ModelAdapter = async (call) => {
    const done = results(call);
    if (isChild(call)) {
      if (!done.length)
        return {
          output: [
            { type: "tool-call", id: "s1", name: "search_orders", args: { query: userText(call) } },
          ],
        };
      return childAnswer(userText(call), done[0]!.text);
    }
    if (!done.length)
      return {
        output: [
          { type: "tool-call", id: "d1", name: "researcher", args: { task: "A" } },
          { type: "tool-call", id: "d2", name: "researcher", args: { task: "B" } },
        ],
      };
    return done.map((item) => `${item.status}:${decode(item.text)}`).join(" | ");
  };
  return { adapter };
}

describe("agents used as tools, in process", () => {
  it("runs children with fresh context and returns only their final answers", async () => {
    const parent = agents();
    const { adapter } = scripted();
    const events: ExecutionEvent[] = [];
    const result = await run({
      binding: bindingFromAgent(parent),
      input: "help",
      onModelCall: adapter,
      onEvent: (event) => void events.push(event),
    });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.output).toBe("completed:answer A | completed:answer B");
    // The child's search never appears in the parent's transcript.
    expect(JSON.stringify(result.state.transcript)).not.toContain("search_orders");
    const started = events.filter((event) => event.type === "delegation.started");
    expect(started.map((event: any) => event.attributes.task).sort()).toEqual(["A", "B"]);
    const childTool = events.find(
      (event) => event.type === "tool.completed" && (event as any).toolName === "search_orders",
    ) as any;
    expect(childTool.agent).toMatchObject({ id: "researcher", path: "support/researcher" });
    expect(childTool.attributes.output.agent).toBe("support/researcher");
  });

  it("reports empty output as a failure, never as success", async () => {
    const parent = agents();
    const { adapter } = scripted(() => "");
    const result = await run({
      binding: bindingFromAgent(parent),
      input: "x",
      onModelCall: adapter,
    });
    expect(result.status === "completed" && result.output).toBe(
      "failed:The agent finished without an answer. | failed:The agent finished without an answer.",
    );
  });

  it("returns structured output and fails with partial evidence", async () => {
    const parent = agents({ childOutput: z.object({ summary: z.string() }) });
    const adapter: ModelAdapter = async (call) => {
      const done = results(call);
      if (isChild(call)) {
        if (userText(call) === "A") return { output: [{ type: "json", value: { summary: "ok" } }] };
        return "not json, just my notes";
      }
      if (!done.length)
        return {
          output: [
            { type: "tool-call", id: "d1", name: "researcher", args: { task: "A" } },
            { type: "tool-call", id: "d2", name: "researcher", args: { task: "B" } },
          ],
        };
      return JSON.stringify(done);
    };
    const result = await run({
      binding: bindingFromAgent(parent),
      input: "x",
      onModelCall: adapter,
    });
    if (result.status !== "completed") throw new Error(result.status);
    const [a, b] = JSON.parse(result.output as string);
    expect(a).toEqual({ status: "completed", text: '{"summary":"ok"}' });
    expect(b.status).toBe("failed");
    expect(JSON.parse(b.text).code).toBe("delegation.failed");
    expect(decode(b.text)).toContain(
      "Partial output (evidence, not an answer):\nnot json, just my notes",
    );
  });

  it("turns a child's request for input into a tool failure the child sees", async () => {
    const asking = tool({
      name: "search_orders",
      input: z.object({ query: z.string() }),
      run: async (_args, ctx) => ctx.ask("Which order?"),
    });
    const parent = agents({ childTools: [asking] });
    const seen: string[] = [];
    const { adapter } = scripted((_task, found) => {
      seen.push(found);
      return "gave up";
    });
    const result = await run({
      binding: bindingFromAgent(parent),
      input: "x",
      onModelCall: adapter,
    });
    expect(result.status).toBe("completed");
    expect(seen[0]).toContain("can't ask for input");
  });

  it("cancels every running child with the parent", async () => {
    const parent = agents();
    const controller = new AbortController();
    let started = 0;
    const adapter: ModelAdapter = async (call, ctx) => {
      if (isChild(call)) {
        if (++started === 2) controller.abort();
        await new Promise((_, reject) => {
          if (ctx.signal.aborted) reject(ctx.signal.reason);
          ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason));
        });
      }
      return {
        output: [
          { type: "tool-call", id: "d1", name: "researcher", args: { task: "A" } },
          { type: "tool-call", id: "d2", name: "researcher", args: { task: "B" } },
        ],
      };
    };
    const result = await run({
      binding: bindingFromAgent(parent),
      input: "x",
      onModelCall: adapter,
      signal: controller.signal,
    });
    expect(result.status).toBe("cancelled");
    expect(started).toBe(2);
  });

  it("advertises a child's own skills, which only the Runtime serves", async () => {
    const researcher = Agent({
      id: "researcher",
      description: "Investigates with a skill.",
      instructions: "Load the skill, then answer.",
    })
      .use({
        id: "skills",
        skills: {
          triage: {
            name: "triage",
            description: "Triage an issue.",
            files: { "SKILL.md": `sha256:${"a".repeat(64)}` },
          },
        },
      })
      .build();
    const parent = Agent({
      id: "support",
      instructions: "Delegate.",
      tools: [researcher],
    }).build();
    const seen: { tools: string[]; loaded?: string }[] = [];
    const adapter: ModelAdapter = async (call) => {
      if (call.tools.some((item) => item.name === "load_skill")) {
        const done = results(call);
        if (!done.length) {
          seen.push({ tools: call.tools.map((item) => item.name) });
          return {
            output: [{ type: "tool-call", id: "s1", name: "load_skill", args: { name: "triage" } }],
          };
        }
        seen.push({ tools: call.tools.map((item) => item.name), loaded: done[0]!.text });
        return "skill used";
      }
      if (!results(call).length)
        return {
          output: [
            { type: "tool-call", id: "d1", name: "researcher", args: { task: "triage order" } },
          ],
        };
      return results(call)
        .map((item) => `${item.status}:${decode(item.text)}`)
        .join(" | ");
    };
    const result = await run({
      binding: bindingFromAgent(parent),
      input: "help",
      onModelCall: adapter,
    });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.output).toBe("completed:skill used");
    expect(seen[0]!.tools).toContain("load_skill");
    expect(JSON.stringify(seen[1]!.loaded)).toContain("Skills are served by the Nylorun Runtime");
  });

  it.each(["ask", "approve", "sleep", "waitFor"] as const)(
    "turns a child's %s into interaction-unsupported the child can see",
    async (kind) => {
      const interactive = tool({
        name: "search_orders",
        input: z.object({ query: z.string() }),
        run: async (_args, ctx) => {
          if (kind === "ask") return ctx.ask("Which order?");
          if (kind === "approve") return ctx.approve("Refund?");
          if (kind === "sleep") return ctx.sleep("1s");
          return ctx.waitFor("order.updated");
        },
      });
      const parent = agents({ childTools: [interactive] });
      const seen: string[] = [];
      const { adapter } = scripted((_task, found) => {
        seen.push(found);
        return "gave up";
      });
      const result = await run({
        binding: bindingFromAgent(parent),
        input: "x",
        onModelCall: adapter,
      });
      expect(result.status).toBe("completed");
      expect(seen[0]).toContain("can't ask for input");
    },
  );

  it("reports mixed concurrent success and failure to the parent", async () => {
    const parent = agents();
    const adapter: ModelAdapter = async (call) => {
      const done = results(call);
      if (isChild(call)) {
        if (userText(call) === "A") return "answer A";
        return "";
      }
      if (!done.length)
        return {
          output: [
            { type: "tool-call", id: "d1", name: "researcher", args: { task: "A" } },
            { type: "tool-call", id: "d2", name: "researcher", args: { task: "B" } },
          ],
        };
      return done.map((item) => `${item.status}:${decode(item.text)}`).join(" | ");
    };
    const result = await run({
      binding: bindingFromAgent(parent),
      input: "x",
      onModelCall: adapter,
    });
    expect(result.status === "completed" && result.output).toBe(
      "completed:answer A | failed:The agent finished without an answer.",
    );
  });

  it("settles a missing local child as a failed tool result with matching events", async () => {
    const parent = agents();
    const restored = Agent.from(JSON.parse(JSON.stringify(parent.manifest)), {});
    const events: ExecutionEvent[] = [];
    let calls = 0;
    let failureText = "";
    const result = await run({
      binding: bindingFromAgent(restored),
      input: "x",
      onEvent: (event) => void events.push(event),
      onModelCall: async (call) => {
        calls += 1;
        if (calls > 1) {
          failureText = results(call)
            .map((item) => decode(item.text))
            .join(" | ");
          return failureText;
        }
        return {
          output: [{ type: "tool-call", id: "d1", name: "researcher", args: { task: "A" } }],
        };
      },
    });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(failureText).toContain("no local implementation");
    expect(result.output).toContain("no local implementation");
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["delegation.started", "delegation.completed"]),
    );
    const completed = events.find((event) => event.type === "delegation.completed") as any;
    expect(completed.status).toBe("failed");
    expect(completed.attributes.code).toBe("execution.invalid-input");
  });
});

describe("agents used as tools, durable", () => {
  function journalHost(model: ModelAdapter, tools: (effect: HostEffect) => EffectResolution) {
    const journal = new Map<string, EffectResolution>();
    const requests = new Map<string, string>();
    const executed: HostEffect[] = [];
    const host: DurableHost = {
      async resolveEffect(effect) {
        const recorded = journal.get(effect.effectId);
        if (recorded) {
          expect(JSON.stringify(effect)).toBe(requests.get(effect.effectId));
          return recorded;
        }
        requests.set(effect.effectId, JSON.stringify(effect));
        executed.push(effect);
        const resolution: EffectResolution =
          effect.kind === "model"
            ? {
                status: "completed",
                outcome: { value: await model(effect.input as ModelCall, {} as any) },
              }
            : effect.kind === "delegation"
              ? { status: "completed", outcome: { value: null } }
              : tools(effect);
        journal.set(effect.effectId, resolution);
        return resolution;
      },
    };
    return { host, journal, executed };
  }

  it("journals children as namespaced effects and never repeats completed work", async () => {
    const parent = agents();
    const manifest = parent.manifest;
    const { adapter } = scripted();
    const { host, journal, executed } = journalHost(adapter, () => ({ status: "pending" }));
    const checkpoint = createDurableCheckpoint({
      manifest,
      sessionId: "s",
      turnId: "t",
      input: "help",
    });
    const original = JSON.stringify(checkpoint);

    const first = await runDurable({ manifest, checkpoint, host });
    expect(first.status).toBe("waiting");
    if (!("effectIds" in first)) throw new Error("expected waiting");
    // Both children reached their tool call in parallel; both actions carry the child's identity.
    const actions = executed.filter((effect) => effect.kind === "tool");
    expect(actions).toHaveLength(2);
    for (const action of actions) {
      expect(action).toMatchObject({
        agentId: "support",
        capabilityId: "agent",
        toolName: "search_orders",
        agent: { id: "researcher", path: "support/researcher" },
      });
      expect(action.effectId).toContain(`:tool:${action.agent!.delegationId}/`);
      expect((action.context as any).idempotencyKey).toContain(`${action.agent!.delegationId}/`);
    }
    expect(new Set(actions.map((action) => action.agent!.delegationId)).size).toBe(2);
    expect(executed.filter((effect) => effect.kind === "delegation")).toHaveLength(2);

    const before = executed.length;
    const replay = await runDurable({ manifest, checkpoint: JSON.parse(original), host });
    expect(replay).toEqual(first);
    expect(executed.length).toBe(before);

    for (const action of actions)
      journal.set(action.effectId, {
        status: "completed",
        outcome: { value: { kind: "completed", output: { found: action.input } } },
      });
    const done = await runDurable({ manifest, checkpoint: JSON.parse(original), host });
    expect(done.status).toBe("completed");
    if (done.status !== "completed") return;
    expect(done.result.status === "completed" && done.result.output).toBe(
      "completed:answer A | completed:answer B",
    );
    const kinds = executed
      .slice(before)
      .map((effect) => `${effect.kind}:${effect.agent?.id ?? "root"}`);
    // Only the children's final model calls, their settle points, and the parent's answer are new.
    expect(kinds.sort()).toEqual(
      [
        "delegation:researcher",
        "delegation:researcher",
        "model:researcher",
        "model:researcher",
        "model:root",
      ].sort(),
    );
    const settled = executed.filter(
      (effect) => effect.kind === "delegation" && effect.effectId.endsWith(":settled"),
    );
    expect(settled.map((effect) => (effect.input as any).status)).toEqual([
      "completed",
      "completed",
    ]);
  });

  it("gives local and durable runs the same answer", async () => {
    const parent = agents();
    const local = await run({
      binding: bindingFromAgent(parent),
      input: "help",
      onModelCall: scripted().adapter,
    });
    const { host } = journalHost(scripted().adapter, (effect) => ({
      status: "completed",
      outcome: {
        value: {
          kind: "completed",
          output: { found: (effect.input as any).query, agent: "support/researcher" },
        },
      },
    }));
    const durable = await runDurable({
      manifest: parent.manifest,
      checkpoint: createDurableCheckpoint({
        manifest: parent.manifest,
        sessionId: "s",
        turnId: "t",
        input: "help",
      }),
      host,
    });
    expect(durable.status).toBe("completed");
    expect(local.status === "completed" && local.output).toBe(
      durable.status === "completed" && durable.result.status === "completed"
        ? durable.result.output
        : undefined,
    );
  });

  it("routes a child's session tools to the child only", async () => {
    const parent = agents();
    const seen: Record<string, string[]> = {};
    const adapter: ModelAdapter = async (call) => {
      const who = isChild(call) ? "child" : "parent";
      seen[who] = call.tools.map((item) => item.name);
      if (who === "child") return "child done";
      return results(call).length
        ? "parent done"
        : { output: [{ type: "tool-call", id: "d1", name: "researcher", args: { task: "A" } }] };
    };
    const { host } = journalHost(adapter, () => ({ status: "pending" }));
    const result = await runDurable({
      manifest: parent.manifest,
      checkpoint: createDurableCheckpoint({
        manifest: parent.manifest,
        sessionId: "s",
        turnId: "t",
        input: "go",
      }),
      host,
      sessionTools: [
        {
          agentId: "researcher",
          capabilityId: "agent",
          name: "github__get_issue",
          inputSchema: { type: "object" },
        },
      ],
    });
    expect(result.status).toBe("completed");
    expect(seen.child).toContain("github__get_issue");
    expect(seen.parent).not.toContain("github__get_issue");
  });
});
