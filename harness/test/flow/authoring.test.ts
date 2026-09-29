import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, flow, tool, VerdictSchema, type JsonValue } from "@nylorun/core/define";
import {
  createFlowCheckpoint,
  runFlowDurable,
  type DurableHost,
  type EffectResolution,
  type HostEffect,
} from "../../src/run/index.js";

/**
 * Flow Agents Phase 1, end to end: flow agents written with the new syntax compile to
 * WorkflowManifest v1 and run on today's engine. Every fn, verify and tool effect is
 * resolved through the flow's own bindings, as the executor does.
 */

type Built = {
  readonly manifest: never;
  getBinding(): {
    nodes: Record<
      string,
      {
        kind: string;
        fn?: (args: never) => unknown;
        tool?: { execute(i: unknown, c: never): Promise<unknown> };
      }
    >;
  };
};

async function run(
  workflow: Built,
  input: JsonValue,
  agents: (agentId: string, input: unknown, iteration: string) => unknown,
) {
  const { nodes } = workflow.getBinding();
  const seen: HostEffect[] = [];
  const journal = new Map<string, EffectResolution>();
  const host: DurableHost = {
    async resolveEffect(effect) {
      const recorded = journal.get(effect.effectId);
      if (recorded) return recorded;
      seen.push(effect);
      let value: unknown;
      try {
        if (effect.kind === "agent") {
          const body = effect.input as { agentId: string; input: unknown };
          value = agents(body.agentId, body.input, effect.iterations);
        } else {
          const impl = nodes[effect.key];
          const expected = effect.kind === "tool" ? "tool" : effect.kind;
          if (!impl || impl.kind !== expected)
            throw new Error(`No ${effect.kind} binding for key '${effect.key}'`);
          value =
            impl.kind === "tool"
              ? await impl.tool!.execute(effect.input, {} as never)
              : await impl.fn!(effect.input as never);
        }
      } catch (error) {
        value = {
          kind: "failed",
          code: effect.kind === "verify" ? "loop.verify-failed" : "fn.failed",
          message: String((error as Error).message),
        };
      }
      const resolution: EffectResolution = {
        status: "completed",
        outcome: { value: value as JsonValue },
      };
      journal.set(effect.effectId, resolution);
      return resolution;
    },
  };
  const result = await runFlowDurable({
    manifest: workflow.manifest,
    checkpoint: createFlowCheckpoint({
      manifest: workflow.manifest,
      sessionId: "s1",
      turnId: "t1",
      input,
    }),
    host,
  });
  return { result, seen };
}

const agent = (id: string) => Agent({ id }).instructions(`Be ${id}.`);
const Review = z.object({ score: z.number() });
const triage = agent("triage").output(
  z.object({ kind: z.enum(["bug", "docs", "feature"]), summary: z.string() }),
);
const planner = agent("planner").output(z.object({ tasks: z.array(z.string()) }));
const tester = agent("tester").output(VerdictSchema);
const docsWriter = agent("docs-writer");
const openPr = tool({
  name: "open_pr",
  input: z.object({ title: z.string() }),
  output: z.object({ url: z.string() }),
  async run({ title }) {
    return { url: `https://example.com/pr/${encodeURIComponent(title)}` };
  },
});

const issueDesk = Agent({ id: "issue-desk" })
  .step(triage)
  .switch(
    {
      bug: flow().loop(agent("fixer"), { verify: tester, max: 3 }),
      docs: docsWriter,
      default: flow()
        .step(planner)
        .map(agent("implementer"), { input: ({ input }) => input.tasks })
        .step(docsWriter, { id: "feature-docs" }),
    },
    { on: ({ input }) => input.kind, id: "route" },
  )
  .parallel(
    {
      security: agent("security-reviewer").output(Review),
      style: agent("style-reviewer").output(Review),
    },
    { id: "reviews" },
  )
  .step(openPr, {
    input: ({ results, flowInput }) => ({
      title: `${results.triage.summary} #${(flowInput as { issue: number }).issue} ${results.reviews.security.score}/${results.reviews.style.score}`,
    }),
  });

function agents(kind: "bug" | "docs" | "feature", failures = 1) {
  let attempts = 0;
  return (agentId: string, input: unknown): unknown => {
    switch (agentId) {
      case "triage":
        return { kind, summary: `fix ${kind}` };
      case "fixer":
        attempts += 1;
        return `patch ${attempts} for ${String(input)}`;
      case "tester":
        return attempts > failures
          ? { pass: true }
          : { pass: false, feedback: `attempt ${attempts} fails` };
      case "planner":
        return { tasks: ["api", "ui"] };
      case "implementer":
        return `done ${String(input)}`;
      case "docs-writer":
        return "docs updated";
      case "security-reviewer":
        return { score: 4 };
      case "style-reviewer":
        return { score: 5 };
      default:
        throw new Error(`unexpected agent ${agentId}`);
    }
  };
}

const paths = (seen: HostEffect[]) => seen.filter((e) => e.kind === "agent").map((e) => e.path);

describe("issue-desk written with the new syntax runs on today's engine", () => {
  it("routes a feature through the default case: planner, map, feature docs", async () => {
    const { result, seen } = await run(
      issueDesk as never,
      { repo: "r", issue: 7 },
      agents("feature"),
    );
    expect(result).toMatchObject({
      status: "completed",
      result: { output: { url: "https://example.com/pr/fix%20feature%20%237%204%2F5" } },
    });
    expect(paths(seen)).toEqual([
      "issue-desk/triage",
      "issue-desk/route/default/planner",
      "issue-desk/route/default/map-2[0]/implementer",
      "issue-desk/route/default/map-2[1]/implementer",
      "issue-desk/route/default/feature-docs",
      "issue-desk/reviews/security",
      "issue-desk/reviews/style",
    ]);
  });

  it("routes a bug through the loop, retrying with the verifier's feedback", async () => {
    const { result, seen } = await run(
      issueDesk as never,
      { repo: "r", issue: 8 },
      agents("bug", 1),
    );
    expect(result).toMatchObject({ status: "completed" });
    const fixerInputs = seen
      .filter((e) => e.kind === "agent" && (e.input as { agentId: string }).agentId === "fixer")
      .map((e) => (e.input as { input: unknown }).input);
    expect(fixerInputs).toEqual([{ kind: "bug", summary: "fix bug" }, "attempt 1 fails"]);
  });

  it("routes docs straight to the docs writer", async () => {
    const { result, seen } = await run(issueDesk as never, { repo: "r", issue: 9 }, agents("docs"));
    expect(result).toMatchObject({ status: "completed" });
    expect(paths(seen)).toContain("issue-desk/route/docs");
  });

  it("stops a loop after max failed attempts", async () => {
    const { result } = await run(issueDesk as never, { repo: "r", issue: 1 }, agents("bug", 99));
    expect(result).toMatchObject({
      status: "failed",
      result: { status: "failed", error: { code: "loop.stopped" } },
    });
    expect(JSON.stringify(result)).toContain("stopped after 3 attempts");
  });

  it("fails clearly when a nested flow() reads flowInput", async () => {
    const nested = Agent({ id: "nested" }).switch(
      {
        any: flow()
          .step(agent("a"))
          .step(openPr, {
            input: (args) => ({ title: String((args as { flowInput?: unknown }).flowInput) }),
          }),
      },
      { on: () => "any" },
    );
    const { result } = await run(nested as never, "x", () => "a out");
    expect(JSON.stringify(result)).toContain("flow.flow-input-nested");
  });
});
