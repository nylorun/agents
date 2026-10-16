/**
 * Moving an Agent between versions of its manifest (track T3, D73): `PUT /v1/agents/{id}` with
 * another version (or `?dryRun=true` for the plan), the wait for a required secret the version
 * adds, and a secret the version drops staying in the vault, unused.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import type { RuntimeSection } from "@nylorun/core/contracts";
import { startTestTenant } from "./support/tenant.js";
import { withTestSessionStore } from "./support/store.js";
import { manifestOf, openSession, saveManifest, writeManifest } from "./support/agents.js";
import { VaultService } from "../src/vault/service.js";

const APP = "server-token-value-aaaaaaaa";
const headers = { authorization: `Bearer ${APP}`, "content-type": "application/json" };

const bot = (instructions: string) => Agent({ id: "bot", name: "bot" }).instructions(instructions).build();

let runtime: Awaited<ReturnType<typeof startTestTenant>>;

beforeAll(async () => {
  runtime = await startTestTenant({ mode: "test", applicationKey: APP, vaultKek: null, sandbox: { backend: "virtual" } });
});
afterAll(async () => {
  await runtime.close();
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${runtime.url}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

const agents = (id: string, rest = "") => `/v1/agents/${encodeURIComponent(id)}${rest}`;
const save = (name: string, instructions: string, runtimeSection?: RuntimeSection) =>
  saveManifest(runtime.url, headers, manifestOf(bot(instructions), { name, ...(runtimeSection ? { runtime: runtimeSection } : {}) }));
const types = async (id: string) =>
  ((await call("GET", agents(id, "/events"))).body.events as { type: string; payload: any }[]).filter((event) =>
    ["agent.outdated", "agent.version_changed"].includes(event.type),
  );

/** The variables the Agent's sandbox commands get now. */
const variables = (id: string) =>
  withTestSessionStore(runtime, (store) =>
    store.tx((t) => new VaultService({ store, kek: () => Buffer.alloc(32, 9) }).environmentVariables(t, id)),
  );

describe("moving an Agent", () => {
  it("plans a move, applies a harness-only change at once, and pins an older version back", async () => {
    expect(await save("plain", "One.")).toBe(1);
    expect((await call("PUT", agents("plain/a"), { manifest: "plain@1" })).body).toMatchObject({ resolvedVersion: 1, tracking: "pinned" });
    expect((await openSession(runtime.url, headers, "plain-s1", { agent: "plain/a", ownerUserId: "ada" })).ok).toBe(true);
    expect(await save("plain", "Two.")).toBe(2);
    // Pinned: the save leaves it on version 1.
    expect((await call("GET", agents("plain/a"))).body).toMatchObject({ resolvedVersion: 1, targetVersion: null });

    const plan = await call("PUT", `${agents("plain/a")}?dryRun=true`, { manifest: "plain" });
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    expect(plan.body).toEqual({
      dryRun: true,
      plan: {
        agent: "plain/a",
        manifest: "plain",
        from: 1,
        to: 2,
        tracking: "tracking",
        applies: "now",
        changes: [expect.objectContaining({ section: "harness", path: "instructions", op: "replace" })],
        missingSecrets: [],
        dormantSecrets: [],
        refusals: [],
        sessions: 1,
      },
    });
    // Nothing changed.
    expect((await call("GET", agents("plain/a"))).body).toMatchObject({ resolvedVersion: 1, tracking: "pinned" });
    expect((await call("PUT", `${agents("nobody")}?dryRun=true`, { manifest: "plain" })).status).toBe(404);

    expect((await call("PUT", agents("plain/a"), { manifest: "plain" })).body).toMatchObject({
      manifest: "plain",
      resolvedVersion: 2,
      tracking: "tracking",
      targetVersion: null,
      waitingFor: null,
      state: "sleeping",
    });
    expect((await call("PUT", agents("plain/a"), { manifest: "plain@1" })).body).toMatchObject({ resolvedVersion: 1, tracking: "pinned" });
    expect((await types("plain/a")).map((event) => [event.type, event.payload])).toEqual([
      ["agent.version_changed", { from: 1, to: 2 }],
      ["agent.version_changed", { from: 2, to: 1 }],
    ]);
    expect((await call("PUT", agents("plain/a"), { manifest: "plain@9" })).body.code).toBe("manifest_not_found");
  });

  it("refuses a version of another kind: kind, harness and storage are fixed for an Agent's life", async () => {
    expect(await save("kinded", "One.")).toBe(1);
    expect((await call("PUT", agents("kinded/a"), { manifest: "kinded" })).status).toBe(200);
    expect(await save("kinded", "One.", { kind: "virtual" })).toBe(2);
    // The tracking Agent stays: the save cannot move it.
    expect((await call("GET", agents("kinded/a"))).body).toMatchObject({ resolvedVersion: 1, kind: "none", targetVersion: null });
    const refused = await call("PUT", agents("kinded/a"), { manifest: "kinded@2" });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: "agent_fixed_field",
      details: { fields: [{ field: "kind", from: "none", to: "virtual" }], from: 1, to: 2 },
    });
    const plan = await call("PUT", `${agents("kinded/a")}?dryRun=true`, { manifest: "kinded@2" });
    expect(plan.body.plan).toMatchObject({ applies: "refused", refusals: [{ field: "kind" }] });
  });

  it("waits for a required secret the version adds, and moves once it is set", async () => {
    expect(await save("keyed", "One.", { kind: "virtual" })).toBe(1);
    expect((await call("PUT", agents("keyed/a"), { manifest: "keyed@1" })).status).toBe(200);
    const slots = { TOKEN: { type: "environment_variable" as const, required: true } };
    expect(await save("keyed", "Two.", { kind: "virtual", secrets: slots })).toBe(2);

    const plan = await call("PUT", `${agents("keyed/a")}?dryRun=true`, { manifest: "keyed@2" });
    expect(plan.body.plan).toMatchObject({ applies: "secrets", missingSecrets: ["TOKEN"] });
    const waiting = await call("PUT", agents("keyed/a"), { manifest: "keyed@2" });
    expect(waiting.body).toMatchObject({
      resolvedVersion: 1,
      targetVersion: 2,
      waitingFor: "secrets",
      state: "input_required",
      attention: [{ state: "input_required", reason: expect.stringContaining("secret_required") }],
      slots: [{ name: "TOKEN", required: true, set: false }],
    });
    expect((await call("GET", "/v1/agents?outdated=true")).body.agents.map((agent: { id: string }) => agent.id)).toContain("keyed/a");
    // Asked again, nothing new is recorded.
    await call("PUT", agents("keyed/a"), { manifest: "keyed@2" });

    // The version's slot takes its value before it applies; then it moves.
    const written = await call("PUT", agents("keyed/a", "/secrets/TOKEN"), { value: "t-1" });
    expect(written.status, JSON.stringify(written.body)).toBe(200);
    expect((await call("GET", agents("keyed/a"))).body).toMatchObject({
      resolvedVersion: 2,
      targetVersion: null,
      waitingFor: null,
      state: "sleeping",
      slots: [{ name: "TOKEN", set: true }],
    });
    expect((await types("keyed/a")).map((event) => [event.type, event.payload])).toEqual([
      ["agent.outdated", { from: 1, to: 2, waitingFor: "secrets" }],
      ["agent.version_changed", { from: 1, to: 2 }],
    ]);
    expect(await variables("keyed/a")).toEqual({ TOKEN: "t-1" });
  });

  it("keeps a secret the version drops in the vault, unused, until a version declares it again", async () => {
    const v1 = { kind: "virtual" as const, secrets: { MODE: { type: "environment_variable" as const } } };
    expect(await save("dropped", "One.", v1)).toBe(1);
    expect((await call("PUT", agents("dropped/a"), { manifest: "dropped@1" })).status).toBe(200);
    expect((await call("PUT", agents("dropped/a", "/secrets/MODE"), { value: "fast" })).status).toBe(200);
    expect(await variables("dropped/a")).toEqual({ MODE: "fast" });

    expect(await save("dropped", "Two.", { kind: "virtual", secrets: { LEVEL: { type: "environment_variable" } } })).toBe(2);
    const plan = await call("PUT", `${agents("dropped/a")}?dryRun=true`, { manifest: "dropped@2" });
    expect(plan.body.plan).toMatchObject({ applies: "now", dormantSecrets: ["MODE"] });
    expect((await call("PUT", agents("dropped/a"), { manifest: "dropped@2" })).body).toMatchObject({ resolvedVersion: 2, slots: [{ name: "LEVEL", set: false }] });
    // Dormant: still in the vault, given to no command.
    expect(await variables("dropped/a")).toEqual({});
    expect((await call("GET", agents("dropped/a", "/secrets"))).body.secrets.map((secret: { name: string }) => secret.name)).toEqual(["MODE"]);
    // Back on a version that declares it, it is used again.
    expect((await call("PUT", agents("dropped/a"), { manifest: "dropped@1" })).body.resolvedVersion).toBe(1);
    expect(await variables("dropped/a")).toEqual({ MODE: "fast" });
  });

  it("counts the Agents a save would move in its plan", async () => {
    expect(await save("counted", "One.", { kind: "virtual" })).toBe(1);
    expect((await call("PUT", agents("counted/a"), { manifest: "counted" })).status).toBe(200);
    expect((await call("PUT", agents("counted/b"), { manifest: "counted@1" })).status).toBe(200);
    const plan = await writeManifest(runtime.url, headers, manifestOf(bot("Two."), { name: "counted", runtime: { kind: "virtual" } }), { dryRun: true });
    expect(plan.body).toMatchObject({ to: 2, behind: 1, moves: { now: 1, nextStart: 0, secrets: 0 } });
    expect((plan.body.warnings as { code: string }[]).map((warning) => warning.code)).toEqual(["agents_move", "agents_behind"]);
  });
});
