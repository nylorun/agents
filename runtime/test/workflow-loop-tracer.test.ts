import { expect, it } from "vitest";
import { Agent, Loop, createClient } from "@nylorun/agents";
import { startTestTenant } from "./support/tenant.js";
import { serveAgents } from "./support/endpoint.js";

const APP = "workflow-tracer-app-token-aaaaaa";

/**
 * Wave 2 tracer bullet (implementation-plan Done when):
 * SDK-only registration and run of a root Loop against a scripted model,
 * two iterations with loop.* events, Runtime kill/restart between iterations,
 * exactly one agent turn per iteration.
 */
it("tracer: root Loop runs two iterations through the SDK with Runtime restart", async () => {
  const writer = Agent({
    id: "writer",
    instructions: "Return a short draft.",
  }).build();

  // Hold decide(iteration=1) only in the first process so the kill lands
  // between iterations. After restart, the same decide must complete.
  const gate = { hold: true };
  let releaseDecide!: () => void;
  const holdDecide = new Promise<void>((resolve) => {
    releaseDecide = resolve;
  });
  let decideHeld = false;

  function buildLoop() {
    return Loop({
      id: "polish",
      run: writer,
      verify: ({ iteration }) =>
        iteration === 1
          ? { pass: false as const, feedback: "Please revise." }
          : { pass: true as const },
      decide: async ({ verdict, output, iteration }) => {
        if (verdict.pass) return { output };
        if (iteration === 1 && gate.hold) {
          decideHeld = true;
          await holdDecide;
        }
        return { input: verdict.feedback };
      },
    });
  }

  let modelCalls = 0;

  const first = await startTestTenant({
    applicationKey: APP,
    retainRoot: true,
    modelProvider: async () => {
      modelCalls += 1;
      const n = modelCalls;
      return {
        output: [{ type: "text", text: n === 1 ? "draft-v1" : "draft-v2" }],
      };
    },
  });

  const client = createClient({
    url: first.url,
    key: first.applicationKey,
    tenant: first.tenantId,
  });

  const polish = buildLoop();
  const connection = serveAgents({
    agents: [polish],
    application: client,
    implementationVersion: "tracer",
    // The held decide is still `delivering` when the Runtime is killed; after the restart
    // it is delivered again once its deadline (endpoint timeout + grace) passes. Keep that
    // deadline short so the restarted Runtime redelivers it within the test.
    timeoutMs: 1_000,
  });
  await connection.ready;

  const session = await client.createSession({
    id: "wf-polish-1",
    agentId: "polish",
    ownerUserId: "user-1",
  });

  const seen: { type: string; payload: any }[] = [];
  let stopObserve = false;
  const observe = (async () => {
    for await (const event of session.observe()) {
      seen.push({ type: event.type, payload: event.payload });
      if (
        stopObserve ||
        event.type === "turn.completed" ||
        event.type === "turn.failed"
      )
        break;
    }
  })();

  await session.input("Write a draft.", { idempotencyKey: "msg-1" });

  for (let i = 0; i < 200 && !decideHeld; i++)
    await new Promise((r) => setTimeout(r, 10));
  expect(decideHeld).toBe(true);
  expect(modelCalls).toBe(1);

  stopObserve = true;
  await connection.close();
  const root = first.root;
  const tenantId = first.tenantId;
  const applicationKey = first.applicationKey;
  await first.close();

  gate.hold = false; // restarted decide must not block

  const second = await startTestTenant({
    hostRoot: root,
    retainRoot: true,
    tenantId,
    applicationKey,
    modelProvider: async () => {
      modelCalls += 1;
      return {
        output: [{ type: "text", text: "draft-v2" }],
      };
    },
  });

  const client2 = createClient({
    url: second.url,
    key: second.applicationKey,
    tenant: second.tenantId,
  });
  const connection2 = serveAgents({
    agents: [buildLoop()],
    application: client2,
    implementationVersion: "tracer",
  });
  await connection2.ready;

  const session2 = client2.session("wf-polish-1");
  const seen2: { type: string; payload: any }[] = [];
  const observe2 = (async () => {
    for await (const event of session2.observe()) {
      seen2.push({ type: event.type, payload: event.payload });
      if (event.type === "turn.completed" || event.type === "turn.failed")
        break;
    }
  })();

  await Promise.race([
    observe2,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("timeout waiting for turn.completed")),
        20000
      )
    ),
  ]);

  const all = [...seen, ...seen2];
  const completed = all.find((e) => e.type === "turn.completed");
  expect(completed).toBeTruthy();
  expect(completed!.payload).toMatchObject({ output: "draft-v2" });

  expect(
    all.some((e) => e.type === "loop.iteration" && e.payload?.n === 1)
  ).toBe(true);
  expect(
    all.some((e) => e.type === "loop.iteration" && e.payload?.n === 2)
  ).toBe(true);
  expect(all.some((e) => e.type === "loop.verified")).toBe(true);
  expect(
    all.some((e) => e.type === "loop.decided" && e.payload?.next === "output")
  ).toBe(true);

  expect(modelCalls).toBe(2);

  const agentSessions = await client2.listSessions({ agentId: "writer" });
  expect(agentSessions.sessions.length).toBe(1);
  const agentHistory = await client2
    .session(agentSessions.sessions[0]!.id)
    .history();
  const agentTurns = agentHistory.items.filter(
    (e) => e.type === "turn.completed"
  );
  expect(agentTurns).toHaveLength(2);

  await connection2.close();
  await second.close();
  void observe.catch(() => {});
  void releaseDecide;
}, 30_000);
