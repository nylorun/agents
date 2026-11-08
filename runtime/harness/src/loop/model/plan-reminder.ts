import type { ModelRequest } from "@nylorun/core/define";
import { UPDATE_PLAN_TOOL } from "@nylorun/core/engine";

/**
 * How many tool calls a turn makes after its last `update_plan` before the model is reminded of
 * its plan, and again after as many more.
 */
export const PLAN_REMINDER_CALLS = 8;

/**
 * The reminder to keep the plan (`update_plan`, `progress/v1`), or `undefined`. A model often sets
 * its plan when it starts and never moves it, so the caller watches step 1 run until the end. When
 * the turn in progress set a plan that still has an open step, and made `PLAN_REMINDER_CALLS` more
 * tool calls since (another reminder after as many more), the call ends with one line naming the
 * step the plan says is current.
 *
 * Read from the request alone, so the same transcript gives the same prompt, and never written
 * into the transcript. Nothing when the turn has no `update_plan` tool or has set no plan.
 */
export function planReminder(request: ModelRequest): string | undefined {
  if (!request.configuration.tools.some((tool) => tool.name === UPDATE_PLAN_TOOL)) return undefined;
  let plan: unknown;
  let since = 0;
  let before = 0;
  for (const entry of request.transcript) {
    if (entry.turnId !== request.turnId || entry.kind !== "candidate") continue;
    before = since;
    for (const block of entry.candidate.output) {
      if (block.type !== "tool-call") continue;
      if (block.name === UPDATE_PLAN_TOOL) {
        plan = block.args;
        since = 0;
        before = 0;
      } else if (plan !== undefined) since += 1;
    }
  }
  if (plan === undefined || since < PLAN_REMINDER_CALLS) return undefined;
  if (Math.floor(since / PLAN_REMINDER_CALLS) === Math.floor(before / PLAN_REMINDER_CALLS))
    return undefined;
  const step = currentStep(plan);
  if (!step) return undefined;
  return `Your plan (${UPDATE_PLAN_TOOL}) still shows "${step.label}" as ${step.state}, and you have made ${since} tool calls since you last set it. The person follows the plan while you work: if that step is done or another has started, call ${UPDATE_PLAN_TOOL} now with the whole plan. If it is still going, carry on.`;
}

/** The step a plan says is current: the first active or blocked one, else the first pending one. */
function currentStep(plan: unknown): { label: string; state: string } | undefined {
  const steps = (plan as { steps?: unknown } | null | undefined)?.steps;
  if (!Array.isArray(steps)) return undefined;
  const open = steps.flatMap((raw) => {
    const step = (raw ?? {}) as { label?: unknown; state?: unknown };
    return typeof step.label === "string" &&
      step.label.trim() !== "" &&
      typeof step.state === "string"
      ? [{ label: step.label.trim(), state: step.state }]
      : [];
  });
  return (
    open.find((step) => step.state === "active" || step.state === "blocked") ??
    open.find((step) => step.state === "pending")
  );
}
