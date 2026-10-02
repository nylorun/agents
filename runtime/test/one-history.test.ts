/**
 * One history (blueprint P0.3), outside shadow mode: the session row holds no transcript, the
 * engine resumes from the transcript folded from the record, a row written by the previous
 * release is taken over, and a cancelled turn's recorded edits are undone.
 */
import { afterEach, expect, it } from "vitest";
import { Agent, createClient, type AgentsClient } from "@nylorun/agents";
import type { LiveEvent } from "@nylorun/core/contracts";
import type { ModelCall } from "@nylorun/core/define";
import type { ModelProvider } from "../src/core/provider.js";
import { foldTranscript, setTranscriptShadow } from "../src/tenant/history.js";
import { startTestTenant } from "./support/tenant.js";
import { withTestSessionStore } from "./support/store.js";

const APP = "one-history-app-token-aaaaaaaaaaa";

const restore: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of restore.splice(0).reverse()) await fn();
});

/** Answers each call; records each prompt; `hold` makes calls of matching turns wait. */
function model(options: { hold?: (prompt: string, step: number) => boolean } = {}) {
  const prompts: string[] = [];
  const steps = new Map<string, number>();
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const provider: ModelProvider = async (effect, signal) => {
    const prompt = JSON.stringify((effect.input as ModelCall).prompt);
    prompts.push(prompt);
    const step = steps.get(effect.turnId) ?? 0;
    steps.set(effect.turnId, step + 1);
    if (options.hold?.(prompt, step)) {
      await new Promise<void>((resolve, reject) => {
        void released.then(resolve);
        signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), {
          once: true,
        });
      });
    }
    if (options.hold && prompt.includes("bravo") && step === 0)
      return {
        output: [
          { type: "tool-call", id: `call-${effect.turnId}`, name: "write", args: { path: "b.txt", content: "b" } },
        ],
      };
    return { output: [{ type: "text", text: `answer ${prompts.length}` }] };
  };
  return { provider, prompts, release: () => release() };
}

async function settle(session: ReturnType<AgentsClient["session"]>, statuses = ["completed", "failed", "cancelled", "uncertain"]) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const view = await session.inspect();
    if (statuses.includes(view.status)) return view;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("session did not settle");
}

async function open(provider: ModelProvider, rollover?: { steps: number }) {
  const runtime = await startTestTenant({
    applicationKey: APP,
    vaultKek: null,
    sandbox: { backend: "virtual" },
    modelProvider: provider,
    ...(rollover ? { rollover } : {}),
  });
  restore.push(() => runtime.close());
  const client = createClient({ url: runtime.url, key: runtime.applicationKey, tenant: runtime.tenantId });
  await client.saveAgent(Agent({ id: "bot", name: "Bot" }).instructions("Help.").build(), {
    implementationVersion: "dev",
  });
  const session = await client.createSession({ id: "s1", agentId: "bot", ownerUserId: "ada", sandbox: {} });
  const ref = { root: runtime.root, tenantId: runtime.tenantId };
  const row = () => withTestSessionStore(ref, (store) => store.tx((t) => t.get<any>("sessions", "s1")));
  const events = () =>
    withTestSessionStore(ref, async (store) =>
      (await store.record().readRange(runtime.tenantId, "s1", 0, Number.MAX_SAFE_INTEGER)).map(
        (r) => r.body as LiveEvent
      )
    );
  return { runtime, session, row, events, ref };
}

function lean() {
  const previous = setTranscriptShadow(false);
  restore.push(() => void setTranscriptShadow(previous));
}

it("stores no transcript on the row and resumes each turn from the fold", async () => {
  lean();
  const m = model();
  const { session, row, events } = await open(m.provider);
  for (const [n, text] of ["alpha", "bravo", "charlie"].entries()) {
    await session.input(text, { idempotencyKey: `m${n}` });
    expect((await settle(session)).status).toBe("completed");
  }
  expect(m.prompts.at(-1)).toContain("alpha");
  expect(m.prompts.at(-1)).toContain("bravo");
  const stored = await row();
  expect(stored.state.transcript).toEqual([]);
  expect(stored.turnStartState.transcript).toEqual([]);
  expect(stored.checkpoint.state.transcript).toEqual([]);
  expect(stored.history.from).toBeGreaterThanOrEqual(0);
  const transcript = foldTranscript(await events());
  expect(JSON.stringify(transcript)).toContain("charlie");
  expect((transcript.at(-1) as { kind: string }).kind).toBe("final");
});

it("takes over a row written by the previous release, whose transcript is on the row", async () => {
  const m = model();
  const { session, row, events, ref } = await open(m.provider);
  await session.input("alpha", { idempotencyKey: "m0" });
  expect((await settle(session)).status).toBe("completed");
  // Shadow mode kept the transcript on the row; drop `history`, as the previous release did.
  await withTestSessionStore(ref, (store) =>
    store.tx(async (t) => {
      const s = await t.get<any>("sessions", "s1");
      delete s.history;
      await t.put("sessions", "s1", s);
    })
  );
  const before = (await events()).length;
  lean();
  await session.input("bravo", { idempotencyKey: "m1" });
  expect((await settle(session)).status).toBe("completed");
  expect(m.prompts.at(-1)).toContain("alpha");
  const adopted = (await events()).slice(before).find((e) => e.type === "transcript.updated")!;
  expect(adopted.turnId).toBeNull();
  expect((adopted.payload as { keep: number }).keep).toBe(0);
  expect((await row()).state.transcript).toEqual([]);
});

it("undoes a cancelled turn's recorded edits", async () => {
  lean();
  // In the "bravo" turn the first call writes a file (a rollover after it records an edit),
  // and the second call waits until the turn is cancelled.
  const m = model({ hold: (prompt, step) => prompt.includes("bravo") && step === 1 });
  const { session, events } = await open(m.provider, { steps: 1 });
  await session.input("alpha", { idempotencyKey: "m0" });
  expect((await settle(session)).status).toBe("completed");
  await session.input("bravo", { idempotencyKey: "m1" });
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const recorded = await events();
    if (recorded.filter((e) => e.type === "transcript.updated").length >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const bravoEdits = (await events()).filter((e) => e.type === "transcript.updated" && JSON.stringify(e.payload).includes("bravo"));
  expect(bravoEdits.length).toBeGreaterThan(0);
  await session.cancel({ idempotencyKey: "c1" });
  expect((await settle(session, ["cancelled"])).status).toBe("cancelled");
  m.release();
  await session.input("charlie", { idempotencyKey: "m2" });
  expect((await settle(session)).status).toBe("completed");
  const last = m.prompts.at(-1)!;
  expect(last).toContain("alpha");
  expect(last).toContain("charlie");
  expect(last).not.toContain("bravo");
}, 30_000);
