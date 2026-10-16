/**
 * Harness ids and routing (R4.1): a session pins its harness when it opens (its Agent's
 * manifest's `harness.id`, else ours), and only a connection that said that id in `hello` takes
 * its runs. A custom harness runs from its pod's image (protocol 16): its Agent is a pod Agent,
 * and the pod's host takes its sessions' runs. A custom harness and ours share an installation
 * without taking each other's sessions; placement is keyed by the real id; an Agent id made
 * again with another harness refuses the old sessions' turns.
 */
import { afterEach, expect, it } from "vitest";
import { HARNESS_API_VERSION, memoryChannels, type HarnessChannel } from "@nylorun/core/harness-api";
import { boot, openSession, plain, sendMessage, server, until, type Started } from "../host/execution-support.js";
import { attachHost, deployCustom, pods } from "../support/custom-harness.js";
import { manifestOf, writeManifest } from "../support/agents.js";
import { resolveRecipe } from "../../src/sandbox/resolve.js";
import { effectiveSandboxConfig } from "../../src/sandbox/tenant-config.js";
import { podSpecOf } from "../../src/sandbox/pods/spec.js";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function attach(runtime: Started, peer: { name: string; harness?: string } = { name: "test" }): HarnessChannel {
  const channels = memoryChannels({ json: true });
  const detach = runtime.handle.attachHarness!(channels.core, peer);
  cleanups.push(() => {
    channels.harness.close("test over");
    detach();
  });
  return channels.harness;
}

const hello = (name: string) => ({ api: HARNESS_API_VERSION, name, version: "0", features: {} });

async function call(runtime: Started, method: string, path: string, body?: unknown, headers = server) {
  const response = await fetch(`${runtime.url}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json().catch(() => undefined)) as any };
}

async function openOn(runtime: Started, id: string, agent: string) {
  return call(runtime, "PUT", `/v1/sessions/${id}`, { requestId: `session-${id}`, agent, ownerUserId: "u" });
}

/** Pod Agent env-acme, from manifest `name`, run by harness `harness`. */
const acmeAgent = (runtime: Started, harness = "acme-mini", name = harness) =>
  deployCustom(runtime.url, server, plain, { id: "env-acme", harness, name });

it("pins each session's harness, and gives its runs only to that harness", async () => {
  const runtime = await boot({ harness: "remote", pods: pods() });
  cleanups.push(() => runtime.close());
  await acmeAgent(runtime);
  const ours = attach(runtime);
  const acme = attachHost(runtime, "env-acme", cleanups);
  await ours.request("hello", hello("nylorun"));
  await acme.request("hello", hello("acme-mini"));

  await openSession(runtime, "s-ours");
  expect((await openOn(runtime, "s-acme", "env-acme")).status).toBe(200);
  expect((await call(runtime, "GET", "/v1/sessions/s-ours")).body).toMatchObject({ harness: "nylorun" });
  expect((await call(runtime, "GET", "/v1/sessions/s-acme")).body).toMatchObject({ harness: "acme-mini" });

  // Each harness waits for a run; each gets its own session's, whichever message came first.
  const acmeLease = acme.request("lease", {});
  const oursLease = ours.request("lease", {});
  await sendMessage(runtime, "s-ours");
  await sendMessage(runtime, "s-acme");
  expect((await acmeLease).run.sessionId).toBe("s-acme");
  expect((await oursLease).run.sessionId).toBe("s-ours");
});

it("refuses a hello that names no harness id, our old name, or another id than its credential's", async () => {
  const runtime = await boot({ harness: "remote" });
  cleanups.push(() => runtime.close());
  await expect(attach(runtime).request("hello", hello("@nylorun/harness"))).rejects.toMatchObject({
    code: "invalid",
    message: expect.stringContaining("ours is nylorun"),
  });
  await expect(attach(runtime).request("hello", hello("Acme Mini"))).rejects.toMatchObject({
    code: "invalid",
    message: expect.stringContaining("is not a harness id"),
  });
  await expect(
    attach(runtime, { name: "token", harness: "acme-mini" }).request("hello", hello("nylorun"))
  ).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("for the acme-mini harness") });
  // Without hello there is no id to lease runs of.
  await expect(attach(runtime).request("lease", {})).rejects.toMatchObject({ code: "invalid" });
});

it("keys placement by the harness id: '*' with no hosts refuses a harness the map does not name", async () => {
  const runtime = await boot({ harness: "remote", pods: pods() });
  cleanups.push(() => runtime.close());
  const placement = {
    requestId: "placement",
    placement: { nylorun: { hosts: ["harness-container", "sandbox"] }, "*": { hosts: [] } },
  };
  expect(
    (await call(runtime, "PUT", "/v1/tenant/sandbox", placement, runtime.managementHeaders() as typeof server)).status
  ).toBe(200);
  await acmeAgent(runtime);
  await openSession(runtime, "s-ours");
  const refused = await openOn(runtime, "s-acme", "env-acme");
  expect(refused.status).toBe(409);
  // A custom harness runs in its pod: the host it needs is the sandbox.
  expect(refused.body).toMatchObject({
    code: "placement_refused",
    details: { harness: "acme-mini", host: "sandbox", allowed: [] },
  });
});

it("refuses a turn of a session whose Agent was made again with another harness", async () => {
  const runtime = await boot({ harness: "remote", pods: pods() });
  cleanups.push(() => runtime.close());
  await acmeAgent(runtime);
  await openSession(runtime, "s-other", true);
  expect((await openOn(runtime, "s-acme", "env-acme")).status).toBe(200);
  // An Agent never changes what it runs: another manifest is refused...
  await deployCustom(runtime.url, server, plain, { id: "env-next", harness: "acme-next", name: "acme-next" });
  const changed = await call(runtime, "PUT", "/v1/agents/env-acme", { manifest: "acme-next" });
  expect(changed.status).toBe(409);
  expect(changed.body).toMatchObject({ code: "agent_upgrade_unavailable" });
  // ...but the id can name a new one, made from a manifest with another harness.
  const deleted = await call(runtime, "DELETE", "/v1/agents/env-acme");
  expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
  // A pod Agent is gone once its pod is.
  const remade = await until(
    () => call(runtime, "PUT", "/v1/agents/env-acme", { manifest: "acme-next" }),
    (reply) => reply.body?.code !== "agent_busy",
    "the old Agent to be gone",
  );
  expect(remade.status, JSON.stringify(remade.body)).toBe(200);
  const turn = await call(runtime, "POST", "/v1/sessions/s-acme/commands", {
    type: "message",
    requestId: "m1",
    idempotencyKey: "m1",
    content: "hello",
  });
  expect(turn.status).toBe(409);
  expect(turn.body).toMatchObject({
    code: "harness_mismatch",
    details: { harness: "acme-mini", agentHarness: "acme-next" },
  });
  // A session opened now pins the new harness.
  expect((await openOn(runtime, "s-next", "env-acme")).status).toBe(200);
  expect((await call(runtime, "GET", "/v1/sessions/s-next")).body).toMatchObject({ harness: "acme-next" });
});

it("needs an image for a pod Agent whose harness is not ours: the image is the harness", () => {
  const config = effectiveSandboxConfig({});
  const refused = resolveRecipe("pod", { harness: "acme-mini" }, config);
  expect(refused.kind === "error" && refused.errors.join(" ")).toContain("needs image");
  expect(resolveRecipe("pod", { harness: "acme-mini", image: "ghcr.io/acme/mini:1" }, config)).toMatchObject({
    kind: "recipe",
    recipe: { harness: "acme-mini", image: "ghcr.io/acme/mini:1" },
  });
  expect(resolveRecipe("virtual", { harness: "acme-mini" }, config)).toMatchObject({ kind: "recipe" });
});

it("runs a custom harness's image as the pod's entrypoint, and copies our engine in only for ours", () => {
  const input = {
    environmentId: "env-acme",
    spec: { image: "ghcr.io/acme/mini:1" } as never,
    pod: { k8sName: "sbx-a-g0", volumeGen: 0, desired: "running", observed: "creating", hostEpoch: 1, rev: 1 } as never,
    config: {},
    mode: "Running" as const,
    harnessImage: "ghcr.io/nylorun/runtime:1",
  };
  expect(podSpecOf({ ...input, harness: "acme-mini" })).toMatchObject({ entrypoint: "image", image: "ghcr.io/acme/mini:1" });
  expect(podSpecOf({ ...input, harness: "acme-mini" })).not.toHaveProperty("harnessImage");
  expect(podSpecOf({ ...input, harness: "nylorun" })).toMatchObject({ harnessImage: "ghcr.io/nylorun/runtime:1" });
  expect(podSpecOf(input)).not.toHaveProperty("entrypoint");
});

it("saves a custom harness only on a pod with an image", async () => {
  const runtime = await boot({ harness: "remote" });
  cleanups.push(() => runtime.close());
  for (const [runtimeSection, gap] of [
    [undefined, 'harness.id "acme-mini" needs runtime.kind "pod"; the manifest has no runtime section'],
    [{ kind: "virtual" }, 'harness.id "acme-mini" needs runtime.kind "pod"; the runtime is "virtual"'],
    [{ kind: "pod" }, 'harness.id "acme-mini" needs runtime.image'],
  ] as const) {
    const saved = await writeManifest(
      runtime.url,
      server,
      manifestOf(plain, { name: "acme", harness: "acme-mini", ...(runtimeSection ? { runtime: runtimeSection } : {}) }),
    );
    expect(saved.status).toBe(422);
    expect(saved.body).toMatchObject({ code: "manifest_inconsistent", details: { gaps: [expect.stringContaining(gap)] } });
  }
});

it("never serves a custom harness's session from our harness's workspaces", async () => {
  const runtime = await boot({ harness: "remote", pods: pods() });
  cleanups.push(() => runtime.close());
  const ours = attach(runtime);
  const asked: string[] = [];
  ours.handle(async (method, params) => {
    // Sweeps and reports are ours to serve; a session's request is not.
    if ((params as { session?: unknown }).session !== undefined) asked.push(method);
    return { kind: "completed", output: { content: "ours" } };
  });
  await ours.request("hello", { ...hello("nylorun"), features: { workspace: { backends: ["local"] } } });
  await acmeAgent(runtime);
  await openSession(runtime, "s-ours");
  expect((await openOn(runtime, "s-acme", "env-acme")).status).toBe(200);
  const read = await call(runtime, "POST", "/v1/sessions/s-acme/sandbox/read", { path: "/workspace/note.txt" });
  // Only the pod's host serves its workspace, and none is connected: the request is refused,
  // never sent to ours.
  expect(read.status).toBe(409);
  expect(read.body).toMatchObject({ code: "agent_unavailable" });
  expect(asked).toEqual([]);
});
