/**
 * A message's `removeTools` (Host feature `remove-tools`) and turn variants across versions
 * (track T3): the Runtime takes the named tools out of the version the turn runs, after the turn's
 * first segment re-pins the session to its Agent's version (`repinTurn`), so a session that always
 * sends them still moves. A whole turn manifest is validated again against the new version; one
 * that is no variant of it keeps the turn on the version it pinned (`turn.version_kept`).
 */
import { expect, it } from "vitest";
import { z } from "zod";
import { Agent, http } from "@nylorun/agents";
import { loopManifestOf } from "@nylorun/core/define";
import { startTestTenant } from "./support/tenant.js";
import { testTenantPool, withTestSessionStore } from "./support/store.js";
import { deploy, manifestOf, openSession, saveManifest } from "./support/agents.js";
import type { ModelProvider } from "../src/core/provider.js";
import { repinTurn } from "../src/tenant/agent-versions.js";
import type { Session } from "../src/tenant/context.js";

const APP = "remove-tools-token-aaaaaaaaaaaa";
const headers = { authorization: `Bearer ${APP}`, "content-type": "application/json" };
const input = z.object({ orderId: z.string() });

const bot = (instructions: string) =>
  Agent({ id: "bot", name: "bot" })
    .instructions(instructions)
    .tools(
      http({ name: "refund", input, url: "https://orders.example/refunds" }),
      http({ name: "lookup", input, url: "https://orders.example/lookup" }),
    )
    .build();

/** A model that answers `ok` and keeps the tools each call offered, and its input. */
function recording(seen: { tools: string[]; text: string }[]): ModelProvider {
  return async (effect) => {
    const request = effect.input as { tools?: { name: string }[] };
    seen.push({ tools: (request.tools ?? []).map((tool) => tool.name).sort(), text: JSON.stringify(effect.input) });
    return { output: [{ type: "text", text: "ok" }] };
  };
}

async function boot(modelProvider: ModelProvider) {
  return startTestTenant({ mode: "test", applicationKey: APP, vaultKek: null, modelProvider, sandbox: { backend: "virtual" } });
}
type Runtime = Awaited<ReturnType<typeof boot>>;

async function turn(runtime: Runtime, id: string, key: string, extra: Record<string, unknown> = {}) {
  const sent = await fetch(`${runtime.url}/v1/sessions/${id}/commands`, {
    method: "POST",
    headers,
    body: JSON.stringify({ type: "message", requestId: key, idempotencyKey: key, content: "go", ...extra }),
  });
  expect(sent.ok, await sent.clone().text()).toBe(true);
  let session: Record<string, any> = { status: "" };
  for (let attempt = 0; attempt < 400 && !["completed", "failed"].includes(session.status); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    session = (await (await fetch(`${runtime.url}/v1/sessions/${id}`, { headers })).json()) as Record<string, any>;
  }
  return session;
}

async function move(runtime: Runtime, version: number): Promise<void> {
  const view = (await (await fetch(`${runtime.url}/v1/agent-manifests/bot/versions/${version}`, { headers })).json()) as {
    hash: string;
  };
  await withTestSessionStore(runtime, (store) =>
    store.tx(async (t) => {
      await t.environment("bot", { lock: true });
      await t.updateEnvironment("bot", { manifestVersion: version, manifestHash: view.hash }, new Date().toISOString());
    }),
  );
}

const toolNames = (seen: { tools: string[] }) => seen.tools.filter((name) => name === "refund" || name === "lookup");

it("takes removeTools out of the turn's manifest, and still moves the session to its Agent's new version", async () => {
  const seen: { tools: string[]; text: string }[] = [];
  const runtime = await boot(recording(seen));
  try {
    await deploy(runtime.url, headers, bot("Answer as version one."));
    expect((await openSession(runtime.url, headers, "s1", { agent: "bot", ownerUserId: "ada" })).ok).toBe(true);
    expect((await turn(runtime, "s1", "m1", { removeTools: ["refund", "not-a-tool"] })).status).toBe("completed");
    expect(toolNames(seen.at(-1)!)).toEqual(["lookup"]);
    // The next message names nothing: the turn has every tool again.
    expect((await turn(runtime, "s1", "m2")).status).toBe("completed");
    expect(toolNames(seen.at(-1)!)).toEqual(["lookup", "refund"]);

    await saveManifest(runtime.url, headers, manifestOf(bot("Answer as version two.")));
    await move(runtime, 2);
    const after = await turn(runtime, "s1", "m3", { removeTools: ["refund"] });
    expect(after.status).toBe("completed");
    expect(after.manifest).toEqual({ name: "bot", version: 2 });
    expect(seen.at(-1)!.text).toContain("Answer as version two.");
    expect(toolNames(seen.at(-1)!)).toEqual(["lookup"]);

    const items = (await (await fetch(`${runtime.url}/v1/sessions/s1/items`, { headers })).json()) as {
      items: { type: string; payload: any }[];
    };
    const messages = items.items.filter((item) => item.type === "command.message").map((item) => item.payload.removeTools);
    expect(messages).toEqual([["refund", "not-a-tool"], undefined, ["refund"]]);
  } finally {
    await runtime.close();
  }
});

it("validates a turn's variant again against the version it re-pins, and keeps the old one when it is none", async () => {
  const runtime = await boot(recording([]));
  try {
    await deploy(runtime.url, headers, bot("One."));
    expect((await openSession(runtime.url, headers, "s1", { agent: "bot", ownerUserId: "ada" })).ok).toBe(true);
    const stored = await withTestSessionStore(runtime, (store) => store.tx(async (t) => (await t.get<Session>("sessions", "s1"))!));
    const variantOf = (manifest: any) => ({ ...manifest, instructions: ["Be brief."], tools: [manifest.tools[1]] });
    const at = (manifest: any, request: Session["turnRequest"]) =>
      ({
        ...stored,
        activeTurnId: "turn-1",
        turnRequest: request,
        checkpoint: { manifestHash: "variant-of-v1", segment: 0, turnId: "turn-1" } as any,
        variants: { "variant-of-v1": manifest },
      }) as Session;
    const repinned = async (session: Session) => {
      const copy = structuredClone(session);
      const changed = await withTestSessionStore(runtime, (store) => store.tx((t) => repinTurn(t, copy)));
      return { changed, session: copy };
    };

    // Version two changes only the instructions: the variant (one tool, its own instructions) is
    // still a variant of it, and runs on it.
    await saveManifest(runtime.url, headers, manifestOf(bot("Two.")));
    await move(runtime, 2);
    const variant = variantOf(stored.manifest);
    const moved = await repinned(at(variant, { turnId: "turn-1", manifest: variant, removeTools: ["lookup"] }));
    expect(moved.changed).toBe(true);
    expect(moved.session.definition).toEqual({ name: "bot", version: 2 });
    const turnManifest = moved.session.variants![(moved.session.checkpoint as any).manifestHash] as any;
    expect(turnManifest.instructions).toEqual(["Be brief."]);
    // `removeTools` applies after the variant: nothing of it is left.
    expect(turnManifest.tools).toEqual([]);

    // A variant without its request recorded (an older Runtime's) keeps its version.
    expect((await repinned(at(variant, undefined))).changed).toBe(false);

    // Version three changes the tool the variant keeps: it is no variant of it, so the turn keeps
    // version one, and says why.
    const three = Agent({ id: "bot", name: "bot" })
      .instructions("Three.")
      .tools(http({ name: "lookup", description: "Changed.", input, url: "https://orders.example/lookup" }))
      .build();
    await saveManifest(runtime.url, headers, manifestOf(three));
    await move(runtime, 3);
    const refused = await repinned(at(variant, { turnId: "turn-1", manifest: variant }));
    expect(refused.changed).toBe(false);
    expect(refused.session.definition).toEqual({ name: "bot", version: 1 });
    // Written in the test's own store, which no relay reads: from the session's log.
    const rows = await testTenantPool(runtime.tenantId)<{ body: { type: string; payload: unknown } }[]>`
      SELECT body FROM nylorun_streams.session_events WHERE session_id = 's1' ORDER BY seq`;
    const kept = rows
      .map((row) => (typeof row.body === "string" ? JSON.parse(row.body) : row.body))
      .filter((body) => body.type === "turn.version_kept")
      .map((body) => body.payload);
    expect(kept).toEqual([
      expect.objectContaining({ reason: "variant_invalid", from: { name: "bot", version: 1 }, to: { name: "bot", version: 3 } }),
    ]);
    // `removeTools` alone always re-pins.
    const loop = loopManifestOf(manifestOf(three)) as any;
    const removed = await repinned({
      ...at(variant, { turnId: "turn-1", removeTools: ["lookup"] }),
      checkpoint: { manifestHash: stored.manifestHash, segment: 0, turnId: "turn-1" } as any,
    });
    expect(removed.changed).toBe(true);
    expect(removed.session.definition).toEqual({ name: "bot", version: 3 });
    expect(removed.session.variants![(removed.session.checkpoint as any).manifestHash]).toEqual({ ...loop, tools: [] });
  } finally {
    await runtime.close();
  }
});
