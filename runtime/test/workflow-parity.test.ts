import { expect, it, describe } from "vitest";
import { z } from "zod";
import {
  Agent,
  Loop,
  tool,
  createClient,
  type AgentsClient,
  type BuiltAgent,
  type BuiltWorkflow,
} from "@nylorun/agents";
import { startTestTenant } from "./support/tenant.js";
import { serveAgents, type ServedAgents } from "./support/endpoint.js";

/**
 * G3 / system-design.md §10 — client-only parity suite.
 * The same cases run against one agent and one workflow through the SDK only.
 *
 * Ledger: SD-PAR1 … SD-PAR9 (L9).
 */

const APP = "workflow-parity-app-token-aaaaaa";

type Kind = "agent" | "workflow";

type Gates = {
  /** When true, tool.approval pauses for a human. */
  requireApproval: boolean;
  /** When true, tool.run blocks until released (cancel / kill / redeploy). */
  holdRun: boolean;
};

function createGates(): Gates & {
  releaseRun: () => void;
  waitUntilHeld: () => Promise<void>;
} {
  const gates: Gates = { requireApproval: false, holdRun: false };
  let release!: () => void;
  let heldResolve!: () => void;
  let holdPromise = new Promise<void>((r) => {
    release = r;
  });
  let heldPromise = new Promise<void>((r) => {
    heldResolve = r;
  });
  let held = false;

  return {
    get requireApproval() {
      return gates.requireApproval;
    },
    set requireApproval(v: boolean) {
      gates.requireApproval = v;
    },
    get holdRun() {
      return gates.holdRun;
    },
    set holdRun(v: boolean) {
      gates.holdRun = v;
    },
    releaseRun: () => release(),
    waitUntilHeld: async () => {
      for (let i = 0; i < 400 && !held; i++)
        await new Promise((r) => setTimeout(r, 10));
      if (!held) throw new Error("tool.run was not held");
      await heldPromise;
    },
    /** Internal: reset hold latch for a fresh mid-run. */
    _armHold() {
      held = false;
      holdPromise = new Promise<void>((r) => {
        release = r;
      });
      heldPromise = new Promise<void>((r) => {
        heldResolve = r;
      });
    },
    async _runHold() {
      if (!gates.holdRun) return;
      held = true;
      heldResolve();
      await holdPromise;
    },
  } as Gates & {
    releaseRun: () => void;
    waitUntilHeld: () => Promise<void>;
    _armHold: () => void;
    _runHold: () => Promise<void>;
  };
}

function workTool(gates: ReturnType<typeof createGates>) {
  return tool({
    name: "work",
    description: "Do the parity work.",
    input: z.object({ note: z.string() }),
    output: z.object({ done: z.literal(true), note: z.string() }),
    approval: () => (gates.requireApproval ? "Approve work?" : false),
    async run({ note }) {
      await gates._runHold();
      return { done: true as const, note };
    },
  });
}

function buildWorker(gates: ReturnType<typeof createGates>, id: string) {
  return Agent({
    id,
    name: id,
    instructions: "Always call the work tool with the user note, then stop.",
  })
    .use({
      id: "parity-tools",
      tools: [workTool(gates)],
    })
    .build();
}

function buildDefinition(
  kind: Kind,
  gates: ReturnType<typeof createGates>
): BuiltAgent | BuiltWorkflow {
  if (kind === "agent") return buildWorker(gates, "parity");
  return Loop({
    id: "parity",
    run: buildWorker(gates, "parity-worker"),
    verify: () => ({ pass: true as const }),
    decide: ({ output }) => ({ output }),
  });
}

/** Redeploy variant: same id, different hashed document (new manifest hash). */
function buildRedeployed(
  kind: Kind,
  gates: ReturnType<typeof createGates>
): BuiltAgent | BuiltWorkflow {
  if (kind === "agent") {
    return Agent({
      id: "parity",
      name: "parity",
      instructions: "REDEPLOYED — still call work, then stop.",
    })
      .use({
        id: "parity-tools",
        tools: [workTool(gates)],
      })
      .build();
  }
  // Slot-rename the run agent so the workflow document hash changes (referenced
  // agent instruction edits alone do not change the workflow manifest).
  return Loop({
    id: "parity",
    run: {
      id: "parity-worker-v2",
      run: Agent({
        id: "parity-worker",
        name: "parity-worker",
        instructions: "REDEPLOYED worker — call work, then stop.",
      })
        .use({
          id: "parity-tools",
          tools: [workTool(gates)],
        })
        .build(),
    },
    verify: () => ({ pass: true as const }),
    decide: ({ output }) => ({ output }),
  });
}

function scriptedModel() {
  let calls = 0;
  return async (effect: {
    input?: { prompt?: { kind?: string }[] };
  }) => {
    calls += 1;
    const prompt = effect.input?.prompt ?? [];
    const last = prompt.at(-1);
    if (last?.kind === "tool-result") {
      return { output: [{ type: "text" as const, text: "done" }] };
    }
    return {
      output: [
        {
          type: "tool-call" as const,
          id: `call-${calls}`,
          name: "work",
          args: { note: "parity-note" },
        },
      ],
    };
  };
}

async function collectUntil(
  session: ReturnType<AgentsClient["session"]>,
  options: {
    cursor?: string;
    follow?: boolean;
    /** When set, only these session ids count for turn terminal events. */
    rootSessionId?: string;
    done: (events: {
      type: string;
      cursor: string;
      sessionId: string;
      payload: unknown;
    }[]) => boolean;
    timeoutMs?: number;
  }
) {
  const events: {
    type: string;
    cursor: string;
    sessionId: string;
    payload: unknown;
  }[] = [];
  const timeoutMs = options.timeoutMs ?? 20_000;
  const deadline = Date.now() + timeoutMs;
  for await (const event of session.observe({
    cursor: options.cursor,
    follow: options.follow,
  })) {
    events.push({
      type: event.type,
      cursor: event.cursor,
      sessionId: event.sessionId,
      payload: event.payload,
    });
    if (options.done(events)) break;
    if (Date.now() > deadline) throw new Error("observe timeout");
  }
  return events;
}

function rootTurnDone(
  rootSessionId: string
): (events: { type: string; sessionId: string }[]) => boolean {
  return (ev) =>
    ev.some(
      (e) =>
        e.sessionId === rootSessionId &&
        (e.type === "turn.completed" || e.type === "turn.failed")
    );
}

async function waitStatus(
  session: ReturnType<AgentsClient["session"]>,
  statuses: string[],
  timeoutMs = 15_000
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const view = await session.inspect();
    if (statuses.includes(view.status)) return view;
    await new Promise((r) => setTimeout(r, 25));
  }
  const last = await session.inspect();
  throw new Error(
    `timeout waiting for status ${statuses.join("|")}; got ${last.status}`
  );
}

/** Wait until inspect/pending exposes at least one human wait (paused or waiting+waits). */
async function waitForWaits(
  session: ReturnType<AgentsClient["session"]>,
  timeoutMs = 15_000
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const waits = await session.pending();
    if (Array.isArray(waits) && waits.length > 0) {
      return { view: await session.inspect(), waits };
    }
    const view = await session.inspect();
    if (["idle", "completed", "failed", "cancelled"].includes(view.status)) {
      throw new Error(
        `expected waits but session settled as ${view.status}`
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timeout waiting for pending interaction");
}

function interactionIdOf(wait: unknown): string {
  const w = wait as {
    interactionId?: string;
    interaction?: { id?: string };
  };
  const id = w.interactionId ?? w.interaction?.id;
  if (!id) throw new Error(`no interaction id in wait: ${JSON.stringify(wait)}`);
  return id;
}

function ownerSessionOf(
  root: ReturnType<AgentsClient["session"]>,
  wait: unknown
): string {
  const w = wait as { sessionId?: string };
  return w.sessionId ?? root.id;
}

describe.each([["agent"], ["workflow"]] as const)(
  "parity suite (%s) — system-design.md §10 / G3",
  (kind) => {
    it(
      "SD-PAR1..9: register, input, observe/cursor, inspect/history, approve, cancel, kill/restart, redeploy pin, idempotency",
      async () => {
        // --- SD-PAR1 register ---
        const gates = createGates();
        gates._armHold();
        const first = await startTestTenant({
          applicationKey: APP,
          retainRoot: true,
          modelProvider: scriptedModel(),
        });
        const client = createClient({
          url: first.url,
          key: first.applicationKey,
          tenant: first.tenantId,
        });
        const definition = buildDefinition(kind, gates);
        let connection: ServedAgents = serveAgents({
          agents: [definition],
          application: client,
          implementationVersion: "parity-v1",
        });
        await connection.ready;

        const listed = await client.listAgents();
        const registered = listed.agents.find(
          (a) => (a.manifest as { id?: string }).id === "parity"
        );
        expect(registered).toBeTruthy();
        if (kind === "workflow") {
          expect((registered!.manifest as { kind?: string }).kind).toBe(
            "workflow"
          );
        } else {
          expect((registered!.manifest as { kind?: string }).kind).not.toBe(
            "workflow"
          );
        }

        // --- SD-PAR2 create session + input (happy path completes) ---
        const sessionA = await client.createSession({
          id: `parity-${kind}-a`,
          agentId: "parity",
          ownerUserId: "user-1",
        });
        const completedA = collectUntil(sessionA, {
          done: rootTurnDone(sessionA.id),
        });
        await sessionA.input("run parity", { idempotencyKey: "msg-a" });
        const eventsA = await completedA;
        expect(
          eventsA.some(
            (e) => e.sessionId === sessionA.id && e.type === "turn.completed"
          )
        ).toBe(true);
        expect(
          eventsA.some(
            (e) => e.sessionId === sessionA.id && e.type === "turn.failed"
          )
        ).toBe(false);

        // --- SD-PAR3 observe + resume from cursor ---
        const sessionB = await client.createSession({
          id: `parity-${kind}-b`,
          agentId: "parity",
          ownerUserId: "user-1",
        });
        const firstBatch: { type: string; cursor: string }[] = [];
        let midCursor = "";
        const observeFirst = (async () => {
          for await (const event of sessionB.observe()) {
            firstBatch.push({ type: event.type, cursor: event.cursor });
            if (firstBatch.length === 1) {
              midCursor = event.cursor;
              break;
            }
          }
        })();
        await sessionB.input("cursor run", { idempotencyKey: "msg-b" });
        await observeFirst;
        expect(midCursor).toBeTruthy();

        const resumed = await collectUntil(sessionB, {
          cursor: midCursor,
          done: rootTurnDone(sessionB.id),
        });
        expect(resumed[0]?.cursor).not.toBe(midCursor);
        expect(
          resumed.some(
            (e) => e.sessionId === sessionB.id && e.type === "turn.completed"
          )
        ).toBe(true);

        // --- SD-PAR4 inspect + history ---
        // Turn completion settles the session to idle/completed (both are terminal).
        const viewB = await waitStatus(sessionB, ["idle", "completed"]);
        expect(viewB).toMatchObject({
          id: `parity-${kind}-b`,
          agentId: "parity",
          ownerUserId: "user-1",
        });
        expect(["idle", "completed"]).toContain(viewB.status);
        expect(typeof viewB.manifestHash).toBe("string");
        expect((viewB.manifestHash as string).length).toBeGreaterThan(0);

        const historyB = await sessionB.history();
        expect(historyB.items.length).toBeGreaterThan(0);
        expect(
          historyB.items.some((e) => e.type === "turn.completed")
        ).toBe(true);

        // --- SD-PAR5 approve an interaction ---
        // Answer on the session that owns the wait (P10): root for agents,
        // linked agent session when a workflow surfaces aggregated waits.
        gates.requireApproval = true;
        const sessionC = await client.createSession({
          id: `parity-${kind}-c`,
          agentId: "parity",
          ownerUserId: "user-1",
        });
        await sessionC.input("needs approval", { idempotencyKey: "msg-c" });
        const { waits: waitsC } = await waitForWaits(sessionC);
        const waitC = waitsC[0]!;
        const interactionId = interactionIdOf(waitC);
        const ownerId = ownerSessionOf(sessionC, waitC);
        await client.session(ownerId).approve(interactionId, true, {
          idempotencyKey: "approve-c",
        });
        await waitStatus(sessionC, ["idle", "completed"]);
        const histC = await sessionC.history();
        expect(histC.items.some((e) => e.type === "turn.completed")).toBe(true);

        // --- SD-PAR6 cancel mid-run ---
        gates.requireApproval = false;
        gates.holdRun = true;
        gates._armHold();
        const sessionD = await client.createSession({
          id: `parity-${kind}-d`,
          agentId: "parity",
          ownerUserId: "user-1",
        });
        await sessionD.input("cancel me", { idempotencyKey: "msg-d" });
        await gates.waitUntilHeld();
        await sessionD.cancel({ idempotencyKey: "cancel-d" });
        gates.holdRun = false;
        gates.releaseRun();
        const cancelled = await waitStatus(sessionD, ["cancelled"]);
        expect(cancelled.status).toBe("cancelled");

        // --- SD-PAR7 kill Runtime mid-run and restart ---
        // Pause for approval (durable), kill Runtime, restart, then approve.
        gates.requireApproval = true;
        gates.holdRun = false;
        const sessionE = await client.createSession({
          id: `parity-${kind}-e`,
          agentId: "parity",
          ownerUserId: "user-1",
        });
        await sessionE.input("survive restart", { idempotencyKey: "msg-e" });
        const { waits: waitsE } = await waitForWaits(sessionE);
        const waitE = waitsE[0]!;
        const interactionE = interactionIdOf(waitE);
        const ownerE = ownerSessionOf(sessionE, waitE);
        const pinnedHashBefore = (await sessionE.inspect())
          .manifestHash as string;

        await connection.close();
        const root = first.root;
        const tenantId = first.tenantId;
        const applicationKey = first.applicationKey;
        await first.close();

        const second = await startTestTenant({
          hostRoot: root,
          retainRoot: true,
          tenantId,
          applicationKey,
          modelProvider: scriptedModel(),
        });
        const client2 = createClient({
          url: second.url,
          key: second.applicationKey,
          tenant: second.tenantId,
        });
        connection = serveAgents({
          agents: [buildDefinition(kind, gates)],
          application: client2,
          implementationVersion: "parity-v1",
        });
        await connection.ready;

        const sessionE2 = client2.session(`parity-${kind}-e`);
        // Waits survive restart; approve on the owning session.
        const afterRestart = await waitForWaits(sessionE2, 25_000);
        expect(afterRestart.waits.length).toBeGreaterThan(0);
        await client2.session(ownerE).approve(interactionE, true, {
          idempotencyKey: "approve-e",
        });
        await waitStatus(sessionE2, ["idle", "completed"], 25_000);
        const histE = await sessionE2.history();
        expect(histE.items.some((e) => e.type === "turn.completed")).toBe(true);
        expect((await sessionE2.inspect()).manifestHash).toBe(pinnedHashBefore);

        // --- SD-PAR8 redeploy mid-run (pinning) ---
        const sessionF = await client2.createSession({
          id: `parity-${kind}-f`,
          agentId: "parity",
          ownerUserId: "user-1",
        });
        const pinF = (await sessionF.inspect()).manifestHash as string;
        await sessionF.input("pin me", { idempotencyKey: "msg-f" });
        const { waits: waitsF } = await waitForWaits(sessionF);
        const waitF = waitsF[0]!;
        const interactionF = interactionIdOf(waitF);
        const ownerF = ownerSessionOf(sessionF, waitF);

        await client2.saveAgent(buildRedeployed(kind, gates), {
          implementationVersion: "parity-v2",
        });
        // Serve the redeployed code on a new endpoint (re-registered) so it is what
        // Actions are delivered to after this turn; the live session pin must remain pinF.
        await connection.close();
        connection = serveAgents({
          agents: [buildRedeployed(kind, gates)],
          application: client2,
          implementationVersion: "parity-v2",
        });
        await connection.ready;

        const listedAfter = await client2.listAgents();
        const defAfter = listedAfter.agents.find(
          (a) => (a.manifest as { id?: string }).id === "parity"
        );
        expect(defAfter).toBeTruthy();
        const newHash = (defAfter as { manifestHash?: string }).manifestHash;
        expect(newHash).toBeTruthy();
        expect(newHash).not.toBe(pinF);

        const midView = await sessionF.inspect();
        expect(midView.manifestHash).toBe(pinF);

        await client2.session(ownerF).approve(interactionF, true, {
          idempotencyKey: "approve-f",
        });
        await waitStatus(sessionF, ["idle", "completed"], 25_000);
        const afterView = await sessionF.inspect();
        expect(afterView.manifestHash).toBe(pinF);

        // New session picks up redeployed definition.
        gates.requireApproval = false;
        const sessionF2 = await client2.createSession({
          id: `parity-${kind}-f2`,
          agentId: "parity",
          ownerUserId: "user-1",
        });
        expect((await sessionF2.inspect()).manifestHash).toBe(newHash);
        const doneF2 = collectUntil(sessionF2, {
          done: rootTurnDone(sessionF2.id),
        });
        await sessionF2.input("new pin", { idempotencyKey: "msg-f2" });
        await doneF2;

        // --- SD-PAR9 same input twice with same idempotency key ---
        const sessionG = await client2.createSession({
          id: `parity-${kind}-g`,
          agentId: "parity",
          ownerUserId: "user-1",
        });
        const r1 = await sessionG.input("once", { idempotencyKey: "msg-g" });
        const r2 = await sessionG.input("once", { idempotencyKey: "msg-g" });
        expect(r2).toEqual(r1);
        await waitStatus(sessionG, ["idle", "completed"]);
        const histG = await sessionG.history();
        const completedTurns = histG.items.filter(
          (e) => e.type === "turn.completed"
        );
        expect(completedTurns).toHaveLength(1);

        // Conflicting body with same key must 409.
        await expect(
          sessionG.input("different", { idempotencyKey: "msg-g" })
        ).rejects.toThrow();

        await connection.close();
        await second.close();
      },
      120_000
    );
  }
);
