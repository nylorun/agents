/**
 * Triggers a client puts on one Agent (D88): `PUT /v1/agents/{agentId}/triggers/{triggerId}` with
 * a `Trigger`, exactly as a definition's `runtime.triggers` entry holds it, and an optional title.
 *
 * - **Origin `api`.** The row keeps its own definition, like an agent-made trigger (D83), and the
 *   principal that put it. Upgrades and moves never touch it (`mergeAgentTriggers` merges
 *   `manifest` rows only); `DELETE` removes it; pause, resume, run and a webhook's secret work as
 *   for any trigger; it fires through `fireTimer` and `deliverRun` like every other.
 * - **Create or replace.** A new id makes it active with its next time. The same id replaces it:
 *   `generation` goes up and the next time is worked out again, so the timer armed for the old
 *   time does nothing. A paused one stays paused; an `at` that ran is active again at its new time.
 * - **The same body again changes nothing** and records no event, so a client may put its desired
 *   state as often as it likes.
 * - **Conflicts.** An id the definition declares, or a row of another origin holds, is
 *   `409 trigger_conflict`: the API never replaces a trigger it didn't put.
 * - **Checks and limits.** Those a definition save runs (`triggerIssues`), against the limits in
 *   force; `count` covers the Agent's `agent` and `api` triggers together (`422 trigger_limit`).
 * - **Events.** `agent.trigger_created` or `agent.trigger_updated` (with `changed`) on the Agent.
 *
 * One transaction with the Agent locked; the timer is armed after the commit.
 */
import { triggerKindOf, type Trigger, type TriggerPut, type TriggerView } from "@nylorun/core/contracts";
import type { AgentTriggerRow, Tx } from "../store/types.js";
import type { TenantContext } from "./context.js";
import { liveEnvironment } from "./agents.js";
import { fail } from "./http.js";
import { triggerLimitsInForce } from "./limits.js";
import { readRuntimeLimits } from "./runtime-limits.js";
import { armTrigger, newEndpointId, nextFireAt, originOf, triggerIssues, triggersOf, triggerView } from "./triggers.js";

/** The definition fields a put compares, in a fixed order. */
const DEFINITION_FIELDS = ["schedule", "timezone", "at", "webhook", "session", "prompt"] as const;

/** The `Trigger` part of a put body, with only the fields it has. */
export function definitionOfPut(body: TriggerPut): Trigger {
  const definition: Record<string, string> = {};
  for (const field of DEFINITION_FIELDS) if (body[field] !== undefined) definition[field] = body[field]!;
  return definition as Trigger;
}

/** The definition fields that differ between `before` and `after`, and `title` when it changed. */
export function changedFields(before: Trigger, after: Trigger, titleBefore: string | null, titleAfter: string | null): string[] {
  const changed: string[] = DEFINITION_FIELDS.filter((field) => before[field] !== after[field]);
  if (titleBefore !== titleAfter) changed.push("title");
  return changed;
}

/** The event payload's timing and session for `trigger`. */
function timingOf(trigger: Trigger): { session: string; schedule?: string; timezone?: string; at?: string } {
  return {
    session: trigger.session,
    ...(trigger.schedule === undefined ? {} : { schedule: trigger.schedule, timezone: trigger.timezone ?? "UTC" }),
    ...(trigger.at === undefined ? {} : { at: trigger.at }),
  };
}

/**
 * `PUT /v1/agents/{agentId}/triggers/{triggerId}` (D88): creates or replaces the Agent's `api`
 * trigger `triggerId` and answers it as the list shows it. `principal` is who put it; `origin` is
 * the URL origin the request reached, for a webhook's URL.
 */
export async function putTrigger(
  ctx: TenantContext,
  agentId: string,
  triggerId: string,
  body: TriggerPut,
  principal: string | undefined,
  origin = "",
): Promise<TriggerView> {
  const definition = definitionOfPut(body);
  const title = body.title ?? null;
  const { row, changed } = await ctx.store.tx(async (t: Tx) => {
    const agent = (await liveEnvironment(t, agentId, { lock: true })) ?? fail(404, `Agent ${agentId} not found`, { code: "not_found" });
    const existing = await t.agentTrigger(agentId, triggerId, { lock: true });
    const declared = await triggersOf(t, agent);
    const held = existing ? originOf(existing) : declared[triggerId] !== undefined ? "manifest" : undefined;
    if (held !== undefined && held !== "api")
      fail(
        409,
        held === "manifest"
          ? `Trigger ${triggerId} comes from the Agent's definition: put your trigger under another id.`
          : held === "agent"
            ? `Trigger ${triggerId} was made by one of the Agent's agents: put your trigger under another id.`
            : `${triggerId} is a session's booked wake: put your trigger under another id.`,
        { code: "trigger_conflict", details: { origin: held } },
      );
    const before = existing?.definition as Trigger | null | undefined;
    if (existing && before) {
      const fields = changedFields(before, definition, existing.title, title);
      // The same body again: nothing changes and nothing is recorded.
      if (fields.length === 0) return { row: existing, changed: undefined };
    }
    const now = new Date();
    const stamp = now.toISOString();
    const runtime = await readRuntimeLimits(t);
    const inForce = triggerLimitsInForce(runtime, agent.applied?.limits);
    if (!existing) {
      // One count for every trigger not from the definition: the tool's and the API's.
      const made = (await t.agentTriggers(agentId)).filter((other) => originOf(other) === "agent" || originOf(other) === "api").length;
      if (made >= inForce.count)
        fail(422, `Agent ${agentId} has ${made} triggers its agents or clients made, the most it can have (limits.triggers.count ${inForce.count}). Delete one to add another.`, {
          code: "trigger_limit",
          details: { limit: "triggers.count", max: inForce.count },
        });
    }
    const issues = triggerIssues(
      { [triggerId]: definition },
      { ...runtime, triggersPerAgent: inForce.count, triggerMinIntervalMs: inForce.minIntervalMs },
      now,
      (id) => `trigger ${id}`,
    );
    if (issues.length > 0) fail(400, issues.join(" "), { code: "invalid_request", details: { issues } });
    const paused = existing?.status === "paused";
    const next = paused ? null : nextFireAt(agentId, triggerId, definition, now, runtime);
    const kind = triggerKindOf(definition);
    const row: AgentTriggerRow = {
      agentId,
      triggerId,
      kind,
      // A webhook has no next time and stays active; an `at` with none has run.
      status: paused ? "paused" : kind === "at" && next === null ? "completed" : "active",
      pausedReason: paused ? existing!.pausedReason : null,
      generation: (existing?.generation ?? -1) + 1,
      nextFireAt: next?.toISOString() ?? null,
      lastFireAt: existing?.lastFireAt ?? null,
      // A webhook keeps its endpoint and secret across replaces; another kind has none.
      endpointId: kind === "webhook" ? (existing?.endpointId ?? newEndpointId()) : null,
      sealedSecret: kind === "webhook" ? (existing?.sealedSecret ?? null) : null,
      sessionId: null,
      note: null,
      effectId: null,
      origin: "api",
      principal: principal ?? existing?.principal ?? null,
      title,
      definition,
      createdSessionId: null,
      createdTurnId: null,
      createdAt: existing?.createdAt ?? stamp,
      updatedAt: stamp,
    };
    await t.putAgentTrigger(row);
    const fields = existing && before ? changedFields(before, definition, existing.title, title) : undefined;
    await t.agentEvent(agentId, existing ? "agent.trigger_updated" : "agent.trigger_created", {
      triggerId,
      kind,
      origin: "api",
      ...(row.principal === null ? {} : { principal: row.principal }),
      ...timingOf(definition),
      ...(title === null ? {} : { title }),
      ...(fields === undefined ? {} : { changed: fields }),
      nextRunAt: row.status === "active" ? row.nextFireAt : null,
    });
    return { row, changed: true };
  });
  if (changed) await armTrigger(ctx, row);
  return triggerView(row, definition, origin);
}
