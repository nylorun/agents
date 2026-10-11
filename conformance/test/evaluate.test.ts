/**
 * The checks' conclusions, from canned API responses shaped as the Runtime serves them
 * (`/items`, `/calls/model`, `/calls/tool`).
 */
import { describe, expect, it } from "vitest";
import * as judge from "../src/evaluate.js";
import type { ModelCallRow, RecordEvent, ToolCallRow } from "../src/client.js";
import type { TurnObservation } from "../src/evaluate.js";

const TURN = "6f1c0a52-0000-4000-8000-000000000001";
const TEXT = "6f1c0a52-0000-4000-8000-000000000002";
const RUN = "run-1";
let seq = 0;

const harness = (
  type: string,
  payload: unknown,
  extra: Partial<RecordEvent> = {},
): RecordEvent => ({
  type,
  seq: (seq += 1),
  turnId: TURN,
  runId: RUN,
  source: { kind: "harness", id: "minimal" },
  evidence: "claimed",
  payload,
  ...extra,
});
const command = (content: string): RecordEvent => ({
  type: "command.message",
  seq: (seq += 1),
  turnId: TURN,
  runId: null,
  source: { kind: "client", id: "principal_1" },
  evidence: "observed",
  principal: { kind: "application", id: "principal_1" },
  payload: { type: "message", content },
});
const model = (n: number, inputTokens = 50, turnId = TURN): ModelCallRow => ({
  effectId: `${turnId}:0:model:${n}`,
  turnId,
  provider: "fixture",
  outcome: "completed",
  usage: { inputTokens, outputTokens: 10 },
});

function textTurn(inputTokens = 50, turnId = TEXT): TurnObservation {
  const items = [
    command("conformance:text"),
    harness("message.assistant", { text: "conformance ok", toolCalls: [] }, { turnId }),
    harness("turn.completed", { output: "conformance ok" }, { turnId }),
  ].map((item) => ({ ...item, turnId }));
  return {
    sessionId: "s",
    turnId,
    items,
    terminal: items[2]!,
    status: "completed",
    modelCalls: [model(0, inputTokens, turnId)],
    toolCalls: [],
  };
}

function bashTurn(stdout = "nylorun-conformance-42\nPATH=/usr/bin\n"): TurnObservation {
  const items = [
    command('conformance:tool bash {"command":"echo"}'),
    harness("message.assistant", { text: "", toolCalls: [{ callId: "c1", name: "bash" }] }),
    harness("tool.completed", {
      toolName: "bash",
      status: "completed",
      output: { exitCode: 0, stdout },
    }),
    harness("message.assistant", { text: "conformance tool completed: …", toolCalls: [] }),
    harness("turn.completed", { output: "conformance tool completed: …" }),
  ];
  const tool: ToolCallRow = {
    effectId: `${TURN}:0:tool:0:c1`,
    turnId: TURN,
    toolName: "bash",
    kind: "sandbox",
    status: "completed",
    attempts: 1,
    error: null,
  };
  return {
    sessionId: "b",
    turnId: TURN,
    items,
    terminal: items[4]!,
    status: "completed",
    modelCalls: [model(0), model(1)],
    toolCalls: [tool],
  };
}

describe("HC01 took the run", () => {
  it("passes when the harness settled the turn", () => {
    expect(judge.tookRun(textTurn(), "minimal").ok).toBe(true);
  });
  it("fails when another writer ended it, or nothing did", () => {
    const turn = textTurn();
    const other = {
      ...turn,
      terminal: { ...turn.terminal!, source: { kind: "harness", id: "nylorun" } },
    };
    expect(judge.tookRun(other, "minimal")).toMatchObject({
      ok: false,
      detail: expect.stringContaining("hello.name minimal"),
    });
    const { terminal: _, ...unended } = turn;
    expect(judge.tookRun({ ...unended, status: "runnable" }, "minimal").ok).toBe(false);
  });
});

describe("HC02 one run per turn", () => {
  it("fails a turn reported under two runs, or an event without one", () => {
    expect(judge.oneRun([textTurn(), bashTurn()]).ok).toBe(true);
    const turn = textTurn();
    const split = {
      ...turn,
      items: [turn.items[0]!, turn.items[1]!, { ...turn.items[2]!, runId: "run-2" }],
    };
    expect(judge.oneRun([split])).toMatchObject({
      ok: false,
      detail: expect.stringContaining("2 runs"),
    });
    const bare = { ...turn, items: [turn.items[0]!, { ...turn.items[1]!, runId: null }] };
    expect(judge.oneRun([bare])).toMatchObject({
      ok: false,
      detail: expect.stringContaining("no run id"),
    });
  });
});

describe("HC03 a text turn", () => {
  it("needs the gate's answer and a longer next prompt", () => {
    expect(judge.textTurn(textTurn(50), textTurn(90, "turn-2")).ok).toBe(true);
    expect(judge.textTurn(textTurn(50), textTurn(50, "turn-2"))).toMatchObject({
      ok: false,
      detail: expect.stringContaining("not recorded or not read"),
    });
    const turn = textTurn();
    const wrong = { ...turn, terminal: { ...turn.terminal!, payload: { output: "hello" } } };
    expect(judge.textTurn(wrong, textTurn(90, "turn-2")).ok).toBe(false);
  });
});

describe("HC04 metered once", () => {
  it("passes one row per model answer, and fails a duplicate, a missing id or another provider", () => {
    expect(judge.meteredOnce([textTurn(), bashTurn()]).ok).toBe(true);
    const turn = bashTurn();
    expect(judge.meteredOnce([{ ...turn, modelCalls: [model(0), model(0)] }]).detail).toContain(
      "metered twice",
    );
    expect(judge.meteredOnce([{ ...turn, modelCalls: [model(0)] }]).detail).toContain(
      "1 metered model calls for 2",
    );
    expect(
      judge.meteredOnce([{ ...turn, modelCalls: [model(0), { ...model(1), provider: "openai" }] }])
        .detail,
    ).toContain("answered by openai");
    expect(
      judge.meteredOnce([{ ...turn, modelCalls: [model(0), { ...model(1), effectId: "" }] }])
        .detail,
    ).toContain("no effect id");
  });
});

describe("HC05 a bash call", () => {
  it("passes one journaled, settled call with the command's output", () => {
    expect(judge.bashTurn(bashTurn(), "nylorun-conformance-42").ok).toBe(true);
  });
  it("fails output that is not the command's, a second attempt, or two settlements", () => {
    expect(
      judge.bashTurn(bashTurn("echo nylorun-conformance-$((6*7))"), "nylorun-conformance-42").ok,
    ).toBe(false);
    const turn = bashTurn();
    expect(
      judge.bashTurn(
        { ...turn, toolCalls: [{ ...turn.toolCalls[0]!, attempts: 2 }] },
        "nylorun-conformance-42",
      ).ok,
    ).toBe(false);
    const twice = { ...turn, items: [...turn.items, { ...turn.items[2]!, seq: 99 }] };
    expect(judge.bashTurn(twice, "nylorun-conformance-42").detail).toContain("2 tool.completed");
  });
});

describe("HC06 effect ids", () => {
  it("need the turn and segment prefix", () => {
    expect(judge.effectIdsPrefixed([bashTurn()]).ok).toBe(true);
    const turn = bashTurn();
    expect(
      judge.effectIdsPrefixed([{ ...turn, modelCalls: [{ ...model(0), effectId: "model-0" }] }]).ok,
    ).toBe(false);
    expect(
      judge.effectIdsPrefixed([
        { ...turn, modelCalls: [{ ...model(0), effectId: `${TURN}:model:0` }] },
      ]).ok,
    ).toBe(false);
  });
});

describe("HC07 and HC08 across a restart", () => {
  const interrupted = (status = "failed", code = "tool.interrupted"): TurnObservation => {
    const turn = bashTurn();
    return {
      ...turn,
      toolCalls: [{ ...turn.toolCalls[0]!, status, error: { code, message: "" } }],
    };
  };
  it("passes an outcome replayed without a second gate call", () => {
    expect(judge.replayedAfterRestart(bashTurn(), [model(0)]).ok).toBe(true);
    expect(
      judge.replayedAfterRestart({ ...bashTurn(), modelCalls: [model(0), model(0), model(1)] }, [
        model(0),
      ]).ok,
    ).toBe(false);
    expect(judge.replayedAfterRestart(bashTurn(), []).ok).toBe(false);
  });
  it("passes an interrupted command that ran once", () => {
    expect(judge.interruptedOnce(interrupted(), 1).ok).toBe(true);
    expect(judge.interruptedOnce(interrupted("uncertain", ""), 1).ok).toBe(true);
    expect(judge.interruptedOnce(interrupted(), 2).detail).toContain("ran 2 times");
    expect(judge.interruptedOnce(bashTurn(), 1).detail).toContain("not interrupted");
    expect(judge.interruptedOnce(interrupted(), undefined).ok).toBe(false);
  });
});

describe("HC09 cancel", () => {
  const cancelledTurn = (late = false, rows: ModelCallRow[] = []): TurnObservation => {
    const end: RecordEvent = {
      type: "turn.cancelled",
      seq: 50,
      turnId: TURN,
      source: { kind: "client", id: "p" },
      payload: {},
    };
    const items = [
      command("conformance:slow 5"),
      end,
      ...(late ? [harness("message.assistant", { text: "late" }, { seq: 60 })] : []),
    ];
    return {
      sessionId: "c",
      turnId: TURN,
      items,
      terminal: end,
      status: "cancelled",
      modelCalls: rows,
      toolCalls: [],
    };
  };
  it("passes both cancels within 2 s with the gate call never completed", () => {
    expect(
      judge.cancelled(
        { what: "a model call", turn: cancelledTurn(), ms: 80 },
        { what: "a command", turn: cancelledTurn(), ms: 40 },
      ).ok,
    ).toBe(true);
  });
  it("fails a slow cancel, a report after it, or a gate call that still completed", () => {
    const ok = { what: "a command", turn: cancelledTurn(), ms: 40 };
    expect(
      judge.cancelled({ what: "a model call", turn: cancelledTurn(), ms: 2_500 }, ok).detail,
    ).toContain("over 2000 ms");
    expect(
      judge.cancelled({ what: "a model call", turn: cancelledTurn(true), ms: 10 }, ok).detail,
    ).toContain("still reported");
    expect(
      judge.cancelled({ what: "a model call", turn: cancelledTurn(false, [model(0)]), ms: 10 }, ok)
        .detail,
    ).toContain("not cancelled there");
  });
});

describe("HC11 a tool not offered", () => {
  const unoffered = (status: string, output: string): TurnObservation => {
    const items = [
      harness("message.assistant", {
        text: "",
        toolCalls: [{ name: "nylorun_conformance_unoffered" }],
      }),
      ...(status === "completed"
        ? [
            harness("tool.completed", {
              toolName: "nylorun_conformance_unoffered",
              status: "completed",
            }),
          ]
        : []),
      harness("turn.completed", { output }),
    ];
    return {
      sessionId: "u",
      turnId: TURN,
      items,
      terminal: items.at(-1)!,
      status: "completed",
      modelCalls: [],
      toolCalls: [],
    };
  };
  it("passes when nothing ran and the model heard the failure", () => {
    expect(
      judge.unofferedTool(
        unoffered("failed", 'conformance tool failed: {"code":"tool.unknown"}'),
        "nylorun_conformance_unoffered",
      ).ok,
    ).toBe(true);
  });
  it("fails when the tool ran", () => {
    expect(
      judge.unofferedTool(
        unoffered("completed", "conformance tool completed: x"),
        "nylorun_conformance_unoffered",
      ).ok,
    ).toBe(false);
  });
});

describe("HC12 a budget refusal", () => {
  const refused = (failures: number): TurnObservation => {
    const items = [
      ...Array.from({ length: failures }, () =>
        harness("model.failed", { code: "budget_exhausted" }),
      ),
      harness("turn.failed", { error: { code: "model.budget_exhausted", message: "" } }),
    ];
    return {
      sessionId: "b",
      turnId: TURN,
      items,
      terminal: items.at(-1)!,
      status: "failed",
      modelCalls: [],
      toolCalls: [],
    };
  };
  it("passes one refusal, and fails a retry", () => {
    expect(judge.budgetRefused(refused(1)).ok).toBe(true);
    expect(judge.budgetRefused(refused(2)).detail).toContain("not retried");
  });
});

describe("HC13 cursor and state", () => {
  it("needs every turn completed with a longer prompt than the last", () => {
    expect(
      judge.cursorAndState([textTurn(50, "t1"), textTurn(90, "t2"), textTurn(130, "t3")]).ok,
    ).toBe(true);
    expect(judge.cursorAndState([textTurn(50, "t1"), textTurn(50, "t2")]).ok).toBe(false);
  });
});

describe("HC14 no credentials", () => {
  it("finds a signed token, a token variable, or a named secret", () => {
    const jwt = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJydW4ifQ.c2lnbmF0dXJl";
    expect(
      judge.noCredentials([
        { where: "items", text: '{"stdout":"PATH=/usr/bin\\nHOME=/workspace"}' },
      ]).ok,
    ).toBe(true);
    expect(judge.noCredentials([{ where: "items", text: `{"stdout":"${jwt}"}` }]).ok).toBe(false);
    expect(
      judge.noCredentials([{ where: "items", text: "NYLORUN_HARNESS_TOKEN=abcdef0123456789" }]).ok,
    ).toBe(false);
    expect(judge.noCredentials([{ where: "items", text: "…cafe…" }], ["cafe"]).detail).toContain(
      "a secret you named",
    );
  });
});

describe("HC16 workspace routes", () => {
  const completed = (output: unknown) => ({ status: 200, body: { kind: "completed", output } });
  it("passes routes that serve the turn's files and refuse 409 during a turn", () => {
    const probe = {
      read: completed("1\tnylorun-conformance-ws"),
      write: completed({ path: "/workspace/x", bytes: 3 }),
      exec: completed({ exitCode: 0, stdout: "nylorun-conformance-put" }),
      during: { status: 409, body: {} },
    };
    expect(
      judge.workspaceServed(probe, "nylorun-conformance-ws", "nylorun-conformance-put").ok,
    ).toBe(true);
    expect(
      judge.workspaceServed(
        { ...probe, during: completed("x") },
        "nylorun-conformance-ws",
        "nylorun-conformance-put",
      ).ok,
    ).toBe(false);
    expect(
      judge.workspaceServed(
        {
          ...probe,
          read: { status: 200, body: { kind: "failed", code: "sandbox.not_found", message: "" } },
        },
        "nylorun-conformance-ws",
        "nylorun-conformance-put",
      ).ok,
    ).toBe(false);
  });
});

describe("HC18 routing", () => {
  it("needs each session pinned to and served by its harness", () => {
    const view = (id: string, harnessId: string) => ({
      id,
      status: "completed",
      activeTurnId: null,
      harness: harnessId,
    });
    const ours = {
      ...textTurn(),
      items: textTurn().items.map((item) =>
        item.source?.kind === "harness"
          ? { ...item, source: { kind: "harness", id: "nylorun" } }
          : item,
      ),
    };
    expect(
      judge.routed([
        { harness: "nylorun", view: view("a", "nylorun"), turn: ours },
        { harness: "minimal", view: view("b", "minimal"), turn: textTurn() },
      ]).ok,
    ).toBe(true);
    expect(
      judge.routed([{ harness: "minimal", view: view("b", "minimal"), turn: ours }]).detail,
    ).toContain("served by nylorun");
  });
});

describe("HC19 attribution", () => {
  it("needs the harness's reports claimed by it, with the run, and commands from the client", () => {
    expect(judge.attributed([textTurn(), bashTurn()], "minimal").ok).toBe(true);
    const turn = textTurn();
    const observed = {
      ...turn,
      items: turn.items.map((item) =>
        item.type === "turn.completed" ? { ...item, evidence: "observed" } : item,
      ),
    };
    expect(judge.attributed([observed], "minimal").detail).toContain("evidence observed");
    const core = {
      ...turn,
      items: turn.items.map((item) =>
        item.type === "message.assistant"
          ? { ...item, source: { kind: "core", id: "runtime" } }
          : item,
      ),
    };
    expect(judge.attributed([core], "minimal").ok).toBe(false);
    const anonymous = {
      ...turn,
      items: turn.items.map((item) =>
        item.type === "command.message" ? { ...item, principal: undefined } : item,
      ),
    };
    expect(judge.attributed([anonymous as TurnObservation], "minimal").detail).toContain(
      "principal",
    );
  });
});
