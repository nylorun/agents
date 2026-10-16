/**
 * Versions per turn (track T3, D73): a session runs the version its Agent runs, taken again at a
 * turn's first segment (`repinTurn`), and keeps it for the rest of the turn. The Agent's version
 * is moved here through the store; the API that moves it is T3's next step.
 */
import { expect, it } from "vitest";
import { Agent, hashManifest, loopManifestOf } from "@nylorun/core/define";
import { startTestTenant } from "./support/tenant.js";
import { withTestSessionStore } from "./support/store.js";
import { deploy, manifestOf, openSession, saveManifest } from "./support/agents.js";
import type { ModelProvider } from "../src/core/provider.js";
import { repinTurn } from "../src/tenant/agent-versions.js";
import type { Session } from "../src/tenant/context.js";

const APP = "server-token-value-aaaaaaaa";
const headers = { authorization: `Bearer ${APP}`, "content-type": "application/json" };

const bot = (instructions: string) => Agent({ id: "bot", name: "bot" }).instructions(instructions).build();

/** A model that answers `ok` and keeps every call's input. */
function recording(seen: string[]): ModelProvider {
  return async (effect) => {
    seen.push(JSON.stringify(effect.input));
    return { output: [{ type: "text", text: "ok" }] };
  };
}

async function boot(modelProvider: ModelProvider) {
  return startTestTenant({ mode: "test", applicationKey: APP, vaultKek: null, modelProvider, sandbox: { backend: "virtual" } });
}

type Runtime = Awaited<ReturnType<typeof boot>>;

/** Sends one message to session `id` and waits for its turn to end. */
async function turn(runtime: Runtime, id: string, key: string): Promise<Record<string, any>> {
  const sent = await fetch(`${runtime.url}/v1/sessions/${id}/commands`, {
    method: "POST",
    headers,
    body: JSON.stringify({ type: "message", requestId: key, idempotencyKey: key, content: "go" }),
  });
  expect(sent.ok, await sent.clone().text()).toBe(true);
  let session: Record<string, any> = { status: "" };
  for (let attempt = 0; attempt < 400 && !["completed", "failed"].includes(session.status); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    session = (await (await fetch(`${runtime.url}/v1/sessions/${id}`, { headers })).json()) as Record<string, any>;
  }
  return session;
}

/** Moves Agent `agent` to version `version` of its manifest, as T3's moves will. */
async function move(runtime: Runtime, agent: string, version: number, hash: string): Promise<void> {
  await withTestSessionStore(runtime, (store) =>
    store.tx(async (t) => {
      await t.environment(agent, { lock: true });
      await t.updateEnvironment(agent, { manifestVersion: version, manifestHash: hash }, new Date().toISOString());
    }),
  );
}

async function manifestHashOf(runtime: Runtime, version: number): Promise<string> {
  const view = (await (await fetch(`${runtime.url}/v1/agent-manifests/bot/versions/${version}`, { headers })).json()) as {
    hash: string;
  };
  return view.hash;
}

it("runs a turn on the version its Agent runs when the turn starts, and names it at the turn's end", async () => {
  const seen: string[] = [];
  const runtime = await boot(recording(seen));
  try {
    await deploy(runtime.url, headers, bot("Answer as version one."));
    expect((await openSession(runtime.url, headers, "s1", { agent: "bot", ownerUserId: "ada" })).ok).toBe(true);
    expect((await turn(runtime, "s1", "m1")).status).toBe("completed");
    expect(seen.at(-1)).toContain("Answer as version one.");

    const v2 = await saveManifest(runtime.url, headers, manifestOf(bot("Answer as version two.")));
    expect(v2).toBe(2);
    await move(runtime, "bot", 2, await manifestHashOf(runtime, 2));

    const after = await turn(runtime, "s1", "m2");
    expect(after.status).toBe("completed");
    expect(seen.at(-1)).toContain("Answer as version two.");
    expect(after.manifest).toEqual({ name: "bot", version: 2 });
    expect(after.manifestHash).toBe(hashManifest(loopManifestOf(manifestOf(bot("Answer as version two."))) as never));

    const items = (await (await fetch(`${runtime.url}/v1/sessions/s1/items`, { headers })).json()) as {
      items: { type: string; payload: any }[];
    };
    const ends = items.items.filter((item) => item.type === "turn.completed").map((item) => item.payload.manifest);
    expect(ends).toEqual([
      { name: "bot", version: 1 },
      { name: "bot", version: 2 },
    ]);
  } finally {
    await runtime.close();
  }
});

it("re-pins only a turn's first segment, before anything of it has run, and never a variant", async () => {
  const runtime = await boot(recording([]));
  try {
    await deploy(runtime.url, headers, bot("One."));
    expect((await openSession(runtime.url, headers, "s1", { agent: "bot", ownerUserId: "ada" })).ok).toBe(true);
    await saveManifest(runtime.url, headers, manifestOf(bot("Two.")));
    await move(runtime, "bot", 2, await manifestHashOf(runtime, 2));
    const stored = await withTestSessionStore(runtime, (store) => store.tx(async (t) => (await t.get<Session>("sessions", "s1"))!));
    const base = {
      ...stored,
      activeTurnId: "turn-1",
      checkpoint: { manifestHash: stored.manifestHash, segment: 0, turnId: "turn-1" } as any,
    } as Session;
    const tried = (session: Session) =>
      withTestSessionStore(runtime, (store) => store.tx((t) => repinTurn(t, structuredClone(session))));

    // A later segment, a variant the message named, and no active turn keep the version.
    expect(await tried({ ...base, checkpoint: { ...(base.checkpoint as any), segment: 1 } })).toBe(false);
    expect(await tried({ ...base, checkpoint: { ...(base.checkpoint as any), manifestHash: "variant" } })).toBe(false);
    expect(await tried({ ...base, activeTurnId: null })).toBe(false);
    // A flow's linked session keeps the version its flow pinned.
    expect(await tried({ ...base, flowRootId: "root" })).toBe(false);

    // The first segment of a turn with nothing journaled takes the Agent's version.
    const fresh = structuredClone(base);
    fresh.mcpSnapshot = { snapshotSchemaVersion: 2, manifestHash: base.manifestHash, servers: [] } as any;
    expect(await withTestSessionStore(runtime, (store) => store.tx((t) => repinTurn(t, fresh)))).toBe(true);
    expect(fresh.definition).toEqual({ name: "bot", version: 2 });
    expect((fresh.checkpoint as any).manifestHash).toBe(fresh.manifestHash);
    expect(fresh.mcpSnapshot).toBeUndefined();
    // Already on the Agent's version: nothing to do.
    expect(await withTestSessionStore(runtime, (store) => store.tx((t) => repinTurn(t, structuredClone(fresh))))).toBe(false);
  } finally {
    await runtime.close();
  }
});
