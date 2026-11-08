import { describe, expect, it } from "vitest";
import type {
  ModelConfigurationSnapshot,
  ModelRequest,
  TranscriptEntry,
} from "@nylorun/core/define";
import { projectModelCall } from "../src/loop/model/project.js";
import { PLAN_REMINDER_CALLS, planReminder } from "../src/loop/model/plan-reminder.js";
import { toolCalls } from "./fixtures.js";

const PLAN = {
  steps: [
    { label: "Read the workflow", state: "done" },
    { label: "Find the failing runs", state: "active" },
    { label: "Write the report", state: "pending" },
  ],
};

function configuration(tools: string[]): ModelConfigurationSnapshot {
  return Object.freeze({
    version: 1,
    instructions: [],
    tools: tools.map((name) => ({
      name,
      inputSchema: { jsonSchema: { type: "object" } },
    })) as never,
    toolContracts: [],
    contributors: [],
  });
}

function request(transcript: TranscriptEntry[], tools = ["update_plan", "bash"]): ModelRequest {
  return Object.freeze({
    executionId: "session",
    turnId: "turn",
    stepId: "step",
    configuration: configuration(tools),
    instructions: [],
    context: { items: [], contributors: [] },
    transcript,
    arrivals: [],
    toolResults: [],
    tools: [],
  }) as ModelRequest;
}

let step = 0;
function candidate(
  turnId: string,
  ...calls: { name: string; args?: Record<string, unknown> }[]
): TranscriptEntry {
  step += 1;
  return {
    kind: "candidate",
    turnId,
    stepId: `s${step}`,
    candidate: toolCalls(
      ...(calls.map((call, index) => ({ id: `c${step}.${index}`, ...call })) as never),
    ),
  };
}

const plan = (args: Record<string, unknown> = PLAN) => ({ name: "update_plan", args });
const bash = { name: "bash", args: { command: "ls" } };
/** `n` model steps of one bash call each. */
const bashSteps = (n: number, turnId = "turn") =>
  Array.from({ length: n }, () => candidate(turnId, bash));

describe("planReminder", () => {
  it("says nothing before the threshold, then names the plan's current step", () => {
    expect(
      planReminder(request([candidate("turn", plan()), ...bashSteps(PLAN_REMINDER_CALLS - 1)])),
    ).toBeUndefined();
    const text = planReminder(
      request([candidate("turn", plan()), ...bashSteps(PLAN_REMINDER_CALLS)]),
    );
    expect(text).toContain('"Find the failing runs" as active');
    expect(text).toContain(`${PLAN_REMINDER_CALLS} tool calls`);
  });

  it("reminds once per threshold's worth of calls, not on every call after it", () => {
    const at = (n: number) => planReminder(request([candidate("turn", plan()), ...bashSteps(n)]));
    expect(at(PLAN_REMINDER_CALLS + 1)).toBeUndefined();
    expect(at(2 * PLAN_REMINDER_CALLS - 1)).toBeUndefined();
    expect(at(2 * PLAN_REMINDER_CALLS)).toContain(`${2 * PLAN_REMINDER_CALLS} tool calls`);
  });

  it("counts a step with several calls, so a crossing inside it still reminds", () => {
    const many = candidate("turn", ...Array.from({ length: 3 }, () => bash));
    expect(
      planReminder(
        request([candidate("turn", plan()), ...bashSteps(PLAN_REMINDER_CALLS - 2), many]),
      ),
    ).toContain(`${PLAN_REMINDER_CALLS + 1} tool calls`);
  });

  it("starts counting again from each update_plan", () => {
    const transcript = [
      candidate("turn", plan()),
      ...bashSteps(PLAN_REMINDER_CALLS - 1),
      candidate("turn", plan()),
      ...bashSteps(PLAN_REMINDER_CALLS - 1),
    ];
    expect(planReminder(request(transcript))).toBeUndefined();
  });

  it("says nothing without a plan in this turn, without the tool, or once no step is open", () => {
    expect(planReminder(request(bashSteps(PLAN_REMINDER_CALLS * 2)))).toBeUndefined();
    expect(
      planReminder(request([candidate("earlier", plan()), ...bashSteps(PLAN_REMINDER_CALLS)])),
    ).toBeUndefined();
    expect(
      planReminder(
        request([candidate("turn", plan()), ...bashSteps(PLAN_REMINDER_CALLS)], ["bash"]),
      ),
    ).toBeUndefined();
    const closed = plan({
      steps: [
        { label: "All of it", state: "done" },
        { label: "Extra", state: "skipped" },
      ],
    });
    expect(
      planReminder(request([candidate("turn", closed), ...bashSteps(PLAN_REMINDER_CALLS)])),
    ).toBeUndefined();
  });

  it("names the first pending step when none is active", () => {
    const waiting = plan({
      steps: [
        { label: "Done one", state: "done" },
        { label: "Next one", state: "pending" },
      ],
    });
    expect(
      planReminder(request([candidate("turn", waiting), ...bashSteps(PLAN_REMINDER_CALLS)])),
    ).toContain('"Next one" as pending');
  });

  it("ends the model call, after the conversation, and is never part of the transcript", () => {
    const transcript = [candidate("turn", plan()), ...bashSteps(PLAN_REMINDER_CALLS)];
    const call = projectModelCall(request(transcript));
    const last = call.prompt[call.prompt.length - 1]!;
    expect(last).toMatchObject({ kind: "context", role: "user" });
    expect(JSON.stringify(last.content)).toContain("Find the failing runs");
    expect(transcript).toHaveLength(PLAN_REMINDER_CALLS + 1);
  });
});
