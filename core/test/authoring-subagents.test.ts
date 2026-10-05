import { describe, expect, it } from "vitest";
import {
  Agent,
  AgentBuildError,
  delegateOf,
  flowDelegatesOf,
  delegatesOf,
  isFlowDelegate,
} from "../src/define.js";
import { AgentManifestSchema } from "../src/contracts.js";

/** Flow Agents Phase 3: a flow agent is a subagent like any agent. */

const agent = (id: string) => Agent({ id, description: `The ${id}.` }).instructions(`Be ${id}.`);
const research = Agent({ id: "research", description: "Researches a question and reports back." })
  .pipe(agent("searcher"))
  .pipe(agent("summarizer"));

const codesOf = (build: () => unknown): string[] => {
  try {
    build();
  } catch (error) {
    if (error instanceof AgentBuildError) return error.diagnostics.map((d) => d.code);
    throw error;
  }
  return [];
};

describe("flow agents as subagents", () => {
  it("inline the flow's workflow manifest v3 in the delegating tool", () => {
    const lead = Agent({ id: "lead" }).instructions("Lead.").subagents(research).build();
    const tool = lead.manifest.capabilities[0]!.tools![0]!;
    expect(tool).toMatchObject({
      name: "research",
      description: "Researches a question and reports back.",
      agent: { kind: "workflow", workflowSchemaVersion: 3, id: "research" },
    });
    expect(tool.agent).toEqual(research.manifest);
    expect(AgentManifestSchema.safeParse(lead.manifest).success).toBe(true);
    expect(flowDelegatesOf(lead.manifest).map((d) => d.manifest.id)).toEqual(["research"]);
    expect(delegatesOf(lead.manifest)).toEqual([]);
  });

  it("keep the authored flow on the delegate, for the executor", () => {
    const lead = Agent({ id: "lead" }).instructions("Lead.").subagents(research).build();
    const delegate = delegateOf(lead.getBinding().tools[0]);
    expect(delegate && isFlowDelegate(delegate)).toBe(true);
    expect(delegate?.workflow?.getBinding().nodes).toEqual(research.getBinding().nodes);
  });

  it("round-trip through Agent.from", () => {
    const lead = Agent({ id: "lead" }).instructions("Lead.").subagents(research).build();
    const rebuilt = Agent.from(JSON.parse(JSON.stringify(lead.manifest)), {});
    expect(rebuilt.manifest).toEqual(lead.manifest);
    expect(isFlowDelegate(delegateOf(rebuilt.getBinding().tools[0])!)).toBe(true);
  });

  it("may have named agents as steps", () => {
    const named = (id: string) =>
      Agent({ id, name: `Named ${id}`, description: `The ${id}.` }).instructions(`Be ${id}.`);
    const desk = Agent({ id: "desk", name: "Desk", description: "Runs a desk." })
      .pipe(named("reader"))
      .pipe(named("writer"));
    expect(codesOf(() => Agent({ id: "lead" }).instructions("Lead.").subagents(desk).build())).toEqual([]);
  });

  it("need a description, like any subagent", () => {
    const plain = Agent({ id: "plain" }).pipe(agent("a"));
    expect(codesOf(() => Agent({ id: "lead" }).instructions("Lead.").subagents(plain).build())).toEqual([
      "delegation.description-required",
    ]);
  });

  it("may have agents that delegate in turn", () => {
    const deep = Agent({ id: "deep", description: "Goes deep." }).pipe(
      Agent({ id: "worker" }).instructions("Work.").subagents(agent("helper"))
    );
    expect(codesOf(() => Agent({ id: "lead" }).instructions("Lead.").subagents(deep).build())).toEqual([]);
  });

});
