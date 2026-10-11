/**
 * What each check concludes from what the Runtime served: pure functions of turns already
 * observed, so they can be tested against canned API responses (`test/evaluate.test.ts`).
 */
import type { ModelCallRow, RecordEvent, SessionView, ToolCallRow } from "./client.js";

/** One turn as the suite saw it, after it ended. */
export interface TurnObservation {
  readonly sessionId: string;
  readonly turnId: string;
  /** The session's events of this turn, in record order. */
  readonly items: readonly RecordEvent[];
  /** The turn's end: `turn.completed`, `turn.failed` or `turn.cancelled`, if it ended so. */
  readonly terminal?: RecordEvent;
  /** The session's status once the turn ended. */
  readonly status: string;
  readonly modelCalls: readonly ModelCallRow[];
  readonly toolCalls: readonly ToolCallRow[];
}

export interface Verdict {
  readonly ok: boolean;
  readonly detail: string;
}

const pass = (detail: string): Verdict => ({ ok: true, detail });
const fail = (detail: string): Verdict => ({ ok: false, detail });

const TERMINAL = /^turn\.(completed|failed|cancelled)$/;

export const isTerminal = (event: RecordEvent): boolean => TERMINAL.test(event.type);

/** The events a harness reported (R4.9): `source.kind` `harness`. */
const reported = (turn: TurnObservation) =>
  turn.items.filter((event) => event.source?.kind === "harness");

const ofType = (turn: TurnObservation, type: string) =>
  turn.items.filter((event) => event.type === type);

const describe = (event: RecordEvent | undefined) =>
  event === undefined
    ? "no end"
    : `${event.type}${event.source ? ` from ${event.source.kind}${event.source.id ? ` ${event.source.id}` : ""}` : ""}${
        event.payload?.error?.code ? ` (${event.payload.error.code})` : ""
      }`;

/** Combines verdicts: all must pass. */
export function all(verdicts: readonly Verdict[]): Verdict {
  const failed = verdicts.filter((verdict) => !verdict.ok);
  return failed.length > 0
    ? fail(failed.map((verdict) => verdict.detail).join("; "))
    : pass(verdicts.map((verdict) => verdict.detail).join("; "));
}

/** HC01: the harness took a run of a session pinned to it and settled it. */
export function tookRun(turn: TurnObservation, harness: string): Verdict {
  const writer = turn.terminal?.source;
  if (writer?.kind !== "harness" || writer.id !== harness)
    return fail(
      `the turn ended with ${describe(turn.terminal)} (session ${turn.status}), not a report of ${harness}: is it connected with its own token, saying hello.name ${harness}?`,
    );
  return pass(`${harness} took the run of ${turn.sessionId} and settled it ${turn.terminal!.type}`);
}

/** HC02: each turn ran under one run: every event the harness reported carries one run id. */
export function oneRun(turns: readonly TurnObservation[]): Verdict {
  for (const turn of turns) {
    const events = reported(turn);
    if (events.length === 0) return fail(`turn ${turn.turnId} has no events the harness reported`);
    const missing = events.filter((event) => !event.runId);
    if (missing.length > 0)
      return fail(`${missing[0]!.type} of turn ${turn.turnId} carries no run id`);
    const runs = new Set(events.map((event) => event.runId));
    if (runs.size !== 1)
      return fail(
        `turn ${turn.turnId} was reported under ${runs.size} runs: ${[...runs].join(", ")}`,
      );
  }
  return pass(`${turns.length} turns, each reported under one run`);
}

/** HC03: a text turn settles with the gate's answer, and the next turn's prompt holds it. */
export function textTurn(
  first: TurnObservation,
  second: TurnObservation,
  expected = "conformance ok",
): Verdict {
  if (first.terminal?.type !== "turn.completed")
    return fail(`the text turn ended ${describe(first.terminal)}, not turn.completed`);
  if (first.terminal.payload?.output !== expected)
    return fail(
      `turn.completed's output is ${JSON.stringify(first.terminal.payload?.output)}, not the gate's ${JSON.stringify(expected)}`,
    );
  const assistant = ofType(first, "message.assistant");
  if (assistant.length !== 1)
    return fail(`the text turn has ${assistant.length} message.assistant events, not 1`);
  if (assistant[0]!.payload?.text !== expected)
    return fail(
      `message.assistant says ${JSON.stringify(assistant[0]!.payload?.text)}, not the gate's ${JSON.stringify(expected)}`,
    );
  const before = first.modelCalls[0]?.usage?.inputTokens;
  const after = second.modelCalls[0]?.usage?.inputTokens;
  if (before === undefined || after === undefined)
    return fail("the turns' model calls are not metered, so the transcript cannot be seen");
  if (!(after > before))
    return fail(
      `the next turn's prompt (${after} tokens) is not longer than the first's (${before}): its transcript was not recorded or not read`,
    );
  return pass(
    `turn.completed and message.assistant say ${JSON.stringify(expected)}; the next prompt grew from ${before} to ${after} tokens`,
  );
}

/** HC04: one metered call per model effect, each with its own effect id, all from the fixture model. */
export function meteredOnce(turns: readonly TurnObservation[], provider = "fixture"): Verdict {
  const seen = new Set<string>();
  let calls = 0;
  for (const turn of turns) {
    const answers = ofType(turn, "message.assistant").length;
    const metered = turn.modelCalls.length;
    if (metered !== answers)
      return fail(
        `turn ${turn.turnId} has ${metered} metered model calls for ${answers} model answers`,
      );
    for (const call of turn.modelCalls) {
      if (!call.effectId) return fail(`a metered call of turn ${turn.turnId} has no effect id`);
      if (seen.has(call.effectId)) return fail(`effect ${call.effectId} was metered twice`);
      seen.add(call.effectId);
      if (call.provider !== provider)
        return fail(
          `effect ${call.effectId} was answered by ${call.provider}, not the ${provider} model at the gate`,
        );
      calls += 1;
    }
  }
  return pass(
    `${calls} model calls across ${turns.length} turns, each metered once at the gate with its own effect id`,
  );
}

/** HC05: one bash call, journaled and settled once, with the output the command printed. */
export function bashTurn(turn: TurnObservation, stdout: string): Verdict {
  if (turn.terminal?.type !== "turn.completed")
    return fail(`the bash turn ended ${describe(turn.terminal)}, not turn.completed`);
  const rows = turn.toolCalls.filter((row) => row.toolName === "bash");
  if (rows.length !== 1)
    return fail(`the bash turn has ${rows.length} journaled bash calls, not 1`);
  const row = rows[0]!;
  if (row.status !== "completed" || (row.attempts ?? 1) !== 1)
    return fail(
      `the bash call is ${row.status} after ${row.attempts} attempts, not completed after 1`,
    );
  const completed = ofType(turn, "tool.completed").filter(
    (event) => event.payload?.toolName === "bash",
  );
  if (completed.length !== 1)
    return fail(`the bash turn has ${completed.length} tool.completed events, not 1`);
  const event = completed[0]!;
  if (
    event.payload?.status !== "completed" ||
    !String(event.payload?.output?.stdout ?? "").includes(stdout)
  )
    return fail(
      `tool.completed is ${event.payload?.status} without ${JSON.stringify(stdout)} in its stdout`,
    );
  const call = ofType(turn, "message.assistant").find((message) =>
    (message.payload?.toolCalls ?? []).some((tool: { name?: string }) => tool.name === "bash"),
  );
  if (call && call.seq > event.seq)
    return fail("tool.completed is recorded before the model asked for the call");
  return pass(
    `one bash call ${row.effectId}, journaled and settled once, printed ${JSON.stringify(stdout)}`,
  );
}

/** HC06: every effect id of a turn begins `<turnId>:<segment>:`. */
export function effectIdsPrefixed(turns: readonly TurnObservation[]): Verdict {
  let count = 0;
  for (const turn of turns) {
    const prefix = new RegExp(`^${turn.turnId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\d+:.`);
    for (const id of [
      ...turn.modelCalls.map((call) => call.effectId),
      ...turn.toolCalls.map((call) => call.effectId),
    ]) {
      if (!id || !prefix.test(id))
        return fail(`effect id ${JSON.stringify(id)} does not begin ${turn.turnId}:<segment>:`);
      count += 1;
    }
  }
  return pass(`${count} effect ids, each with its turn and segment prefix`);
}

/**
 * HC07, and HC06's stability: a turn interrupted by a restart after its first model outcome.
 * `before` are the metered calls seen before the restart.
 */
export function replayedAfterRestart(
  turn: TurnObservation,
  before: readonly ModelCallRow[],
): Verdict {
  if (before.length === 0) return fail("no model call was metered before the restart");
  if (
    turn.terminal?.payload?.error?.code === "effect_drift" ||
    turn.items.some((event) => JSON.stringify(event.payload ?? "").includes("effect_drift"))
  )
    return fail(
      "the run after the restart asked for an effect with another request (effect_drift): its effect ids are not stable",
    );
  for (const call of before) {
    const again = turn.modelCalls.filter((row) => row.effectId === call.effectId);
    if (again.length !== 1)
      return fail(
        `model effect ${call.effectId} was metered ${again.length} times across the restart`,
      );
  }
  const ids = turn.modelCalls.map((call) => call.effectId);
  if (new Set(ids).size !== ids.length)
    return fail("a model effect was metered twice across the restart");
  if (turn.terminal === undefined)
    return fail(`the turn did not end after the restart (session ${turn.status})`);
  return pass(
    `the ${before.length} model outcome(s) before the restart replayed with no second gate call; ${turn.modelCalls.length} metered in all; the turn ended ${turn.terminal.type}`,
  );
}

/** HC08: the command a restart interrupted is not settled as completed, and ran once. */
export function interruptedOnce(turn: TurnObservation, runs: number | undefined): Verdict {
  const rows = turn.toolCalls.filter((row) => row.toolName === "bash");
  if (rows.length !== 1)
    return fail(`the interrupted turn has ${rows.length} journaled bash calls, not 1`);
  const row = rows[0]!;
  const unsettled =
    row.status === "uncertain" ||
    row.status === "invoking" ||
    row.error?.code === "tool.interrupted";
  if (!unsettled)
    return fail(
      `the interrupted call is ${row.status}${row.error ? ` (${row.error.code})` : ""}, not interrupted or uncertain`,
    );
  if (runs === undefined) return fail("the marker the command writes could not be read back");
  if (runs !== 1) return fail(`the command ran ${runs} times, not once`);
  return pass(`the interrupted call is ${row.error?.code ?? row.status}, and its command ran once`);
}

/** One cancel case of HC09. */
export interface CancelCase {
  readonly what: string;
  readonly turn: TurnObservation;
  /** From the cancel's answer to the turn's end. */
  readonly ms: number;
}

/** HC09: each cancel ends its turn `turn.cancelled` within `withinMs`; the model call never completes. */
export function cancelled(model: CancelCase, command: CancelCase, withinMs = 2_000): Verdict {
  for (const one of [model, command]) {
    if (one.turn.terminal?.type !== "turn.cancelled")
      return fail(
        `a cancel during ${one.what} ended the turn ${describe(one.turn.terminal)}, not turn.cancelled`,
      );
    if (one.ms > withinMs)
      return fail(`a cancel during ${one.what} took ${one.ms} ms, over ${withinMs} ms`);
    const late = one.turn.items.filter(
      (event) =>
        event.source?.kind === "harness" &&
        event.seq > one.turn.terminal!.seq &&
        event.type !== "environment.exec",
    );
    if (late.length > 0)
      return fail(
        `after the cancel during ${one.what}, the harness still reported ${late[0]!.type}`,
      );
  }
  if (model.turn.modelCalls.length > 0)
    return fail("the cancelled model call still completed at the gate: it was not cancelled there");
  const row = command.turn.toolCalls.find((call) => call.toolName === "bash");
  if (row && row.status !== "cancelled")
    return fail(`the cancelled command's call is ${row.status}, not cancelled`);
  return pass(
    `cancelled during ${model.what} in ${model.ms} ms (the gate call never completed) and during ${command.what} in ${command.ms} ms`,
  );
}

/** HC10: a turn longer than a run token's life completes. */
export function longTurn(turn: TurnObservation, stdout: string): Verdict {
  if (turn.terminal?.type !== "turn.completed")
    return fail(`the long turn ended ${describe(turn.terminal)}, not turn.completed`);
  if (!String(turn.terminal.payload?.output ?? "").includes(stdout))
    return fail(`the long turn's output lacks ${JSON.stringify(stdout)}`);
  if (turn.modelCalls.length < 2)
    return fail("the model was not called again after the long command");
  return pass("the 16-minute turn completed, with a model call after the run token was re-minted");
}

/** HC11: a call of a tool not offered runs nothing, and the turn continues. */
export function unofferedTool(turn: TurnObservation, tool: string): Verdict {
  if (turn.terminal?.type !== "turn.completed")
    return fail(
      `the turn ended ${describe(turn.terminal)}: a call of a tool it does not offer must not end it`,
    );
  const ran = ofType(turn, "tool.completed").filter(
    (event) => event.payload?.toolName === tool && event.payload?.status === "completed",
  );
  if (ran.length > 0) return fail(`${tool} was run: tool.completed says completed`);
  if (ofType(turn, "environment.exec").length > 0) return fail("a command ran in the sandbox");
  const rows = turn.toolCalls.filter(
    (row) => row.toolName === tool && row.status === "completed" && !row.error,
  );
  if (rows.length > 0) return fail(`${tool} has a completed tool call row`);
  if (!/^conformance tool failed/.test(String(turn.terminal.payload?.output ?? "")))
    return fail(
      `the model did not hear the call failed: the turn's output is ${JSON.stringify(turn.terminal.payload?.output)?.slice(0, 120)}`,
    );
  const settled = turn.toolCalls.find((row) => row.toolName === tool);
  return pass(
    `nothing ran; the model heard ${settled?.error?.code ?? "a failure"} and the turn completed`,
  );
}

/** HC12: a budget refusal ends the turn after one model call. */
export function budgetRefused(turn: TurnObservation): Verdict {
  if (
    turn.terminal?.type !== "turn.failed" ||
    turn.terminal.payload?.error?.code !== "model.budget_exhausted"
  )
    return fail(
      `the turn ended ${describe(turn.terminal)}, not turn.failed model.budget_exhausted`,
    );
  const failed = ofType(turn, "model.failed");
  if (failed.length !== 1)
    return fail(
      `the turn has ${failed.length} model.failed events, not 1: a refusal is not retried`,
    );
  if (ofType(turn, "message.assistant").length > 0)
    return fail("the turn has a message.assistant after the refusal");
  if (turn.modelCalls.length > 1)
    return fail(`${turn.modelCalls.length} model calls were metered, not at most 1`);
  return pass("turn.failed model.budget_exhausted after one model call, not retried");
}

/** HC13: turn after turn, the prompt grows (new cursor) and core accepts the harness's state. */
export function cursorAndState(turns: readonly TurnObservation[]): Verdict {
  if (turns.length < 2) return fail("fewer than two turns");
  let previous: number | undefined;
  for (const [index, turn] of turns.entries()) {
    if (turn.terminal?.type !== "turn.completed")
      return fail(
        `turn ${index + 1} ended ${describe(turn.terminal)}: core refused its output or state`,
      );
    const tokens = turn.modelCalls[0]?.usage?.inputTokens;
    if (tokens === undefined) return fail(`turn ${index + 1}'s model call is not metered`);
    if (previous !== undefined && !(tokens > previous))
      return fail(
        `turn ${index + 1}'s prompt (${tokens} tokens) is not longer than turn ${index}'s (${previous}): it did not start from the new cursor`,
      );
    previous = tokens;
  }
  return pass(
    `${turns.length} turns completed, each prompt longer than the last; core accepted the harness's state each time`,
  );
}

/** Strings that look like a credential: a signed token, or a token variable with its value. */
const CREDENTIALS: readonly RegExp[] = [
  /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/,
  /NYLORUN_[A-Z_]*(?:TOKEN|SECRET|KEY)=[^\s"\\]{8,}/,
];

/** HC14: no credential in what the session's readers see. */
export function noCredentials(
  documents: readonly { readonly where: string; readonly text: string }[],
  secrets: readonly string[] = [],
): Verdict {
  for (const { where, text } of documents) {
    for (const pattern of CREDENTIALS) {
      const found = pattern.exec(text);
      if (found)
        return fail(`${where} holds something credential-shaped: ${found[0].slice(0, 24)}…`);
    }
    for (const secret of secrets)
      if (secret && text.includes(secret)) return fail(`${where} holds a secret you named`);
  }
  return pass(
    `${documents.length} documents (items, model and tool calls) hold no token${secrets.length ? ` and none of the ${secrets.length} secrets named` : ""}`,
  );
}

/** HC15: a pod's harness took the run and ran bash on /workspace. */
export function podTurn(turn: TurnObservation, harness: string, stdout: string): Verdict {
  const took = tookRun(turn, harness);
  if (!took.ok) return took;
  const bash = ofType(turn, "tool.completed").find((event) => event.payload?.toolName === "bash");
  const out = String(bash?.payload?.output?.stdout ?? "");
  if (!out.includes(stdout))
    return fail(
      `bash in the pod printed ${JSON.stringify(out.slice(0, 120))}, without ${JSON.stringify(stdout)}`,
    );
  return pass(`the pod's ${harness} joined, took the run and ran bash on /workspace`);
}

/** HC16's observations: the session sandbox routes after a turn, and during one. */
export interface WorkspaceProbe {
  readonly read: { readonly status: number; readonly body: any };
  readonly write: { readonly status: number; readonly body: any };
  readonly exec: { readonly status: number; readonly body: any };
  readonly during: { readonly status: number; readonly body: any };
}

export function workspaceServed(probe: WorkspaceProbe, written: string, put: string): Verdict {
  const completed = (answer: { status: number; body: any }) =>
    answer.status === 200 && answer.body?.kind === "completed";
  if (!completed(probe.read) || !JSON.stringify(probe.read.body.output).includes(written))
    return fail(
      `reading the file the turn wrote answered ${probe.read.status} ${JSON.stringify(probe.read.body)?.slice(0, 160)}`,
    );
  if (!completed(probe.write))
    return fail(
      `a write answered ${probe.write.status} ${JSON.stringify(probe.write.body)?.slice(0, 160)}`,
    );
  if (!completed(probe.exec) || !String(probe.exec.body.output?.stdout ?? "").includes(put))
    return fail(
      `bash answered ${probe.exec.status} ${JSON.stringify(probe.exec.body)?.slice(0, 160)}`,
    );
  if (probe.during.status !== 409)
    return fail(`a sandbox route during a turn answered ${probe.during.status}, not 409`);
  return pass("read, write and bash serve the turn's workspace; refused 409 during a turn");
}

/** HC17: an MCP tool call through the Tool Gate, settled once. */
export function mcpCalled(turn: TurnObservation, view: SessionView, tool: string): Verdict {
  if (turn.terminal?.type !== "turn.completed")
    return fail(`the MCP turn ended ${describe(turn.terminal)}`);
  if (!view.mcpSnapshot)
    return fail("the session has no MCP snapshot: the harness did not record session.mcp");
  const rows = turn.toolCalls.filter(
    (row) => row.toolName === tool || row.toolName?.endsWith(tool),
  );
  if (rows.length !== 1) return fail(`${rows.length} journaled calls of ${tool}, not 1`);
  const row = rows[0]!;
  if (row.kind !== "mcp" || row.status !== "completed")
    return fail(`the call of ${tool} is a ${row.kind} call, ${row.status}`);
  const completed = ofType(turn, "tool.completed").filter(
    (event) => event.payload?.toolName === row.toolName,
  );
  if (completed.length !== 1)
    return fail(`${completed.length} tool.completed events for ${tool}, not 1`);
  return pass(
    `the snapshot was recorded; ${tool} was called once through the Tool Gate as ${row.effectId}`,
  );
}

/** HC18: each session ran on the harness it is pinned to. */
export function routed(
  cases: readonly {
    readonly harness: string;
    readonly view: SessionView;
    readonly turn: TurnObservation;
  }[],
): Verdict {
  for (const { harness, view, turn } of cases) {
    if (view.harness !== harness)
      return fail(`session ${view.id} is pinned to ${view.harness}, not ${harness}`);
    const writers = new Set(reported(turn).map((event) => event.source!.id));
    if (turn.terminal?.type !== "turn.completed")
      return fail(
        `session ${view.id}, pinned to ${harness}, ended ${describe(turn.terminal)}${harness === "nylorun" ? ": is our harness connected?" : ""}`,
      );
    if (writers.size !== 1 || !writers.has(harness))
      return fail(
        `session ${view.id}, pinned to ${harness}, was served by ${[...writers].join(", ") || "no harness"}`,
      );
  }
  return pass(cases.map(({ harness, view }) => `${view.id} ran on ${harness}`).join(", "));
}

/** HC19: what the harness reported is its claim, and commands are the client's. */
export function attributed(turns: readonly TurnObservation[], harness: string): Verdict {
  const claimed = ["message.assistant", "turn.completed", "turn.failed", "model.failed"];
  let checked = 0;
  for (const turn of turns) {
    for (const event of turn.items) {
      const fromRun =
        claimed.includes(event.type) ||
        // A tool call the harness ran and settled; core settles a cancelled or refused one.
        (event.type === "tool.completed" && event.payload?.status === "completed");
      if (fromRun) {
        if (event.source?.kind !== "harness" || event.source.id !== harness)
          return fail(
            `${event.type} of turn ${turn.turnId} says source ${JSON.stringify(event.source)}, not harness ${harness}`,
          );
        if (event.evidence !== "claimed")
          return fail(
            `${event.type} of turn ${turn.turnId} has evidence ${event.evidence}, not claimed`,
          );
        if (!event.runId) return fail(`${event.type} of turn ${turn.turnId} carries no run id`);
        checked += 1;
      }
      if (event.type.startsWith("command.")) {
        if (event.source?.kind !== "client")
          return fail(`${event.type} says source ${JSON.stringify(event.source)}, not client`);
        if (!event.principal) return fail(`${event.type} names no principal`);
      }
    }
  }
  const metered = meteredOnce(turns);
  if (!metered.ok) return metered;
  return pass(
    `${checked} reported events say harness ${harness}, claimed, with their run; commands are the client's; ${metered.detail}`,
  );
}
