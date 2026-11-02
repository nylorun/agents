/**
 * The `triggers` tool (D83): an agent whose version declares `harness.engine.triggers` lists,
 * creates and deletes its own triggers. The Runtime serves each call as a `runtime` effect
 * (operation `triggers`), in the call's own transaction, keyed by the effect id, so a replayed turn
 * changes nothing twice (`harness-api/record.ts`). The Tenant's tool policy decides it first (a
 * rule of `kind: "runtime"`, `tool: "triggers"`), so an `ask` rule can hold a create for a person.
 *
 * A trigger an agent makes is a row of `agent_triggers` with origin `agent`: its definition (a
 * `Trigger`, as a manifest entry holds it) and title on the row, with the session and turn that
 * made it. It fires through `fireTimer` and `deliverRun` like a manifest's (`triggers.ts`), and an
 * upgrade never touches it.
 *
 * - **Where it runs.** `session: "this"` runs it in the calling session (a follow-up); `"own"` in
 *   a session named from the calling one, `<session>_t_<id>`, opened at its first run and kept.
 * - **Scope.** A session lists and deletes the triggers made from it, and a trigger's own session
 *   may list and delete it too. Creating with an id the session's trigger has replaces it; an id
 *   another session's trigger, a manifest's or a wake holds is `tool.conflict`.
 * - **Runs can't multiply.** A turn a trigger or a booked wake started may list and delete, never
 *   create.
 * - **Checks.** Every create runs the checks a manifest save runs (`triggerIssues`): cron and
 *   zone, the minimum interval, `at` in the future, the prompt's length; and the count of the
 *   Agent's agent-made triggers. Each against the limits in force: the manifest's
 *   `runtime.limits.triggers` within the Tenant's (`triggerLimitsInForce`).
 * - **Arming.** No I/O in the transaction: the call returns the rows to arm, which the record arms
 *   after its commit; the sweep's reconcile arms any it missed.
 */
import {
  TriggerSchema,
  TriggerToolInputSchema,
  triggerKindOf,
  type AgentManifestV8,
  type Trigger,
  type TriggerToolOutput,
} from "@nylorun/core/contracts";
import type { AgentTriggerRow, Tx } from "../store/types.js";
import type { Session } from "./context.js";
import { liveEnvironment } from "./agents.js";
import { triggerLimitsInForce } from "./limits.js";
import { readRuntimeLimits } from "./runtime-limits.js";
import { nextFireAt, originOf, triggerIssues } from "./triggers.js";

/** What a served call settles as, and the rows to arm once its transaction commits. */
export interface ServedTriggers {
  readonly outcome: { kind: "completed"; output: TriggerToolOutput } | { kind: "failed"; code: string; message: string };
  readonly arm: readonly AgentTriggerRow[];
}

const DELAY_UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

const failed = (code: string, message: string): ServedTriggers => ({ outcome: { kind: "failed", code, message }, arm: [] });
const completed = (output: TriggerToolOutput, arm: readonly AgentTriggerRow[] = []): ServedTriggers => ({
  outcome: { kind: "completed", output },
  arm,
});

/** The session an agent-made trigger runs in: the calling one, or its own, `<session>_t_<id>`. */
export function triggerSessionOf(callingSessionId: string, id: string, session: "this" | "own"): string {
  return session === "this" ? callingSessionId : `${callingSessionId}_t_${id}`;
}

/** Whether session `sessionId` may see and delete agent-made trigger `row`: it made it, or the trigger runs there. */
function reaches(row: AgentTriggerRow, sessionId: string): boolean {
  if (originOf(row) !== "agent") return false;
  return row.createdSessionId === sessionId || (row.definition as Trigger | null)?.session === sessionId;
}

/** Whether the version session `s` runs declares the Runtime's `nylorun-triggers` plugin (ADR-106). */
async function declaresTriggersPlugin(t: Tx, s: Pick<Session, "definition">): Promise<boolean> {
  if (!s.definition) return false;
  const body = (await t.agentManifest(s.definition.name, s.definition.version))?.body as AgentManifestV8 | undefined;
  const plugins = (body?.harness as { engine?: { plugins?: { name?: unknown }[] } } | undefined)?.engine?.plugins;
  return Array.isArray(plugins) && plugins.some((plugin) => plugin?.name === "nylorun-triggers");
}

/** Whether the version session `s` runs declares `harness.engine.triggers`. */
async function declaresTriggers(t: Tx, s: Pick<Session, "definition">): Promise<boolean> {
  if (!s.definition) return false;
  const body = (await t.agentManifest(s.definition.name, s.definition.version))?.body as AgentManifestV8 | undefined;
  return (body?.harness as { engine?: { triggers?: unknown } } | undefined)?.engine?.triggers === true;
}

/**
 * Why session `s` cannot make `triggers` call `request` at all, before the Tenant's tool policy
 * is asked (off means off, ADR-100): its version does not declare `engine.triggers`
 * (`tool.unavailable`), or an agent used as a tool made it (`tool.forbidden`). Undefined when it can.
 */
export async function triggersRefusal(
  t: Tx,
  s: Session,
  request: { agent?: unknown },
): Promise<ServedTriggers["outcome"] | undefined> {
  if (!(await declaresTriggers(t, s)))
    return { kind: "failed", code: "tool.unavailable", message: "This session's agent does not set up triggers (engine.triggers)." };
  if (request.agent !== undefined)
    return {
      kind: "failed",
      code: "tool.forbidden",
      message: "Triggers are the root agent's: an agent used as a tool can't list, create or delete them.",
    };
  return undefined;
}

/**
 * Serves one `triggers` call of session `s`'s active turn in `t` (see the module comment). The
 * call's `agent` is the agent used as a tool that made it, absent for the root agent.
 */
export async function serveTriggersTool(
  t: Tx,
  s: Session,
  request: { effectId: string; input?: unknown; agent?: unknown },
): Promise<ServedTriggers> {
  const refused = await triggersRefusal(t, s, request);
  if (refused) return { outcome: refused, arm: [] };
  const parsed = TriggerToolInputSchema.safeParse(request.input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const at = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    return failed("tool.invalid-input", `${at}${issue?.message ?? "Not a triggers call"}`);
  }
  const input = parsed.data;
  if (input.command === "list") {
    const rows = (await t.agentTriggers(s.agentId)).filter((row) => reaches(row, s.id));
    return completed({
      now: new Date().toISOString(),
      triggers: rows.map((row) => {
        const trigger = row.definition as Trigger;
        return {
          id: row.triggerId,
          title: row.title,
          status: row.status,
          ...(trigger.schedule === undefined ? {} : { schedule: trigger.schedule, timezone: trigger.timezone ?? "UTC" }),
          ...(trigger.at === undefined ? {} : { at: trigger.at }),
          session: trigger.session,
          nextRunAt: row.status === "active" ? row.nextFireAt : null,
          prompt: trigger.prompt,
        };
      }),
    });
  }
  if (input.command === "delete") {
    const row = await t.agentTrigger(s.agentId, input.id, { lock: true });
    if (!row || !reaches(row, s.id)) return failed("tool.not-found", `This session has no trigger ${input.id}: list shows the ones it has.`);
    await t.deleteAgentTrigger(s.agentId, input.id);
    await t.agentEvent(s.agentId, "agent.trigger_deleted", { triggerId: input.id, sessionId: s.id });
    return completed({ id: input.id, deleted: true });
  }
  // create: never from a turn a trigger or a booked wake started. Under the `nylorun-triggers`
  // plugin (ADR-106) such a turn may still set a one-off follow-up in its own session, as a woken
  // turn books the next wake: never a schedule, never a session of its own.
  if (s.turnCause !== undefined) {
    const plugin = await declaresTriggersPlugin(t, s);
    const followUp = plugin && input.schedule === undefined && input.session === "this";
    if (!followUp)
      return failed(
        "tool.forbidden",
        plugin
          ? "A run can't create triggers other than a one-off follow-up here (in or at, with session: this): this turn was started by a trigger. It may list and delete them."
          : "A run can't create triggers: this turn was started by a trigger. It may list and delete them.",
      );
  }
  const now = new Date();
  const stamp = now.toISOString();
  const session = triggerSessionOf(s.id, input.id, input.session);
  const delay = input.in === undefined ? undefined : /^([1-9][0-9]*)(m|h|d)$/.exec(input.in)!;
  const checked = TriggerSchema.safeParse({
    ...(input.schedule === undefined ? {} : { schedule: input.schedule }),
    ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
    ...(input.at === undefined ? {} : { at: input.at }),
    ...(delay ? { at: new Date(now.getTime() + Number(delay[1]) * DELAY_UNITS[delay[2]!]!).toISOString() } : {}),
    session,
    prompt: input.prompt,
  });
  if (!checked.success)
    return failed(
      "tool.invalid-input",
      checked.error.issues[0]?.path[0] === "session"
        ? `session: own would run it in session ${session}, longer than a trigger's session may be: use a shorter id.`
        : (checked.error.issues[0]?.message ?? "Not a trigger"),
    );
  const definition: Trigger = checked.data;
  const existing = await t.agentTrigger(s.agentId, input.id, { lock: true });
  if (existing && (originOf(existing) !== "agent" || existing.createdSessionId !== s.id))
    return failed("tool.conflict", `The id ${input.id} is taken by another trigger of this Agent: choose another id.`);
  const runtime = await readRuntimeLimits(t);
  const agent = await liveEnvironment(t, s.agentId);
  const inForce = triggerLimitsInForce(runtime, agent?.applied?.limits);
  if (!existing) {
    const made = (await t.agentTriggers(s.agentId)).filter((row) => originOf(row) === "agent").length;
    if (made >= inForce.count)
      return failed("tool.limit", `This Agent has ${made} triggers, the most it can have. Delete one to add another.`);
  }
  const issues = triggerIssues(
    { [input.id]: definition },
    { ...runtime, triggersPerAgent: inForce.count, triggerMinIntervalMs: inForce.minIntervalMs },
    now,
    (id) => id,
  );
  if (issues.length > 0) return failed("tool.invalid-input", issues.join(" "));
  const next = nextFireAt(s.agentId, input.id, definition, now, runtime);
  const row: AgentTriggerRow = {
    agentId: s.agentId,
    triggerId: input.id,
    kind: triggerKindOf(definition),
    status: next === null ? "completed" : "active",
    pausedReason: null,
    generation: (existing?.generation ?? -1) + 1,
    nextFireAt: next?.toISOString() ?? null,
    lastFireAt: existing?.lastFireAt ?? null,
    endpointId: null,
    sealedSecret: null,
    sessionId: session,
    note: null,
    effectId: request.effectId,
    origin: "agent",
    title: input.title ?? null,
    definition,
    createdSessionId: s.id,
    createdTurnId: s.activeTurnId,
    createdAt: existing?.createdAt ?? stamp,
    updatedAt: stamp,
  };
  await t.putAgentTrigger(row);
  await t.agentEvent(s.agentId, existing ? "agent.trigger_updated" : "agent.trigger_created", {
    triggerId: input.id,
    kind: definition.schedule === undefined ? "at" : "schedule",
    sessionId: s.id,
    session,
    ...(row.title === null ? {} : { title: row.title }),
    nextRunAt: row.nextFireAt,
  });
  return completed({ id: input.id, status: row.status, nextRunAt: row.nextFireAt, session, now: stamp }, [row]);
}
