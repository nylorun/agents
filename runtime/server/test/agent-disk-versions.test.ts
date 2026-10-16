/**
 * Disk versions of a virtual Agent (R2d step 3): a snapshot keeps a version of the workspace (an
 * unchanged one makes none), a restore puts one back at once, `from` creates a new Agent from
 * another's version that then diverges, versions list and delete, a turn holds the disk, and
 * deleting the Agent deletes its versions.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import { RUNTIME_LIMIT_DEFAULTS } from "@nylorun/core/contracts";
import type { ModelProvider } from "../src/core/provider.js";
import type { RuntimeSection } from "@nylorun/core/contracts";
import { startTestTenant } from "./support/tenant.js";
import { manifestOf, saveManifest, writeManifest } from "./support/agents.js";

const APP = "disk-versions-app-key-aaaaaaaaaaaa";
const KEK = Buffer.alloc(32, 9).toString("base64");

let runtime: Awaited<ReturnType<typeof startTestTenant>>;
const headers = { authorization: `Bearer ${APP}`, "content-type": "application/json" };
const bot = Agent({ id: "bot", name: "bot" }).instructions("Work.").build();
/** Agent manifest `name`: bot's loop with `section` (kind virtual by default). */
const save = (name: string, section: RuntimeSection = { kind: "virtual" }) =>
  saveManifest(runtime.url, headers, manifestOf(bot, { name, runtime: section }));
let gate: Promise<void> | undefined;
const model: ModelProvider = async () => {
  await gate;
  return { output: [{ type: "text", text: "ok" }] };
};

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${runtime.url}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: response.status, body: parsed };
}
const path = (id: string) => `/v1/agents/${encodeURIComponent(id)}`;
/** `PUT /v1/agents/{id}` from manifest `manifest` (default `ws`, kind virtual). */
const make = (id: string, body: Record<string, unknown> = {}) => call("PUT", path(id), { manifest: "ws", ...body });
let opened = 0;
async function session(agent: string): Promise<string> {
  opened += 1;
  const id = `disk-s${opened}`;
  const reply = await call("PUT", `/v1/sessions/${id}`, { requestId: id, agent, ownerUserId: "app:ada" });
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  return id;
}
const write = (sessionId: string, file: string, content: string) =>
  call("POST", `/v1/sessions/${sessionId}/sandbox/write`, { path: file, content });
async function read(sessionId: string, file: string): Promise<string> {
  return JSON.stringify((await call("POST", `/v1/sessions/${sessionId}/sandbox/read`, { path: file })).body);
}

beforeAll(async () => {
  runtime = await startTestTenant({ applicationKey: APP, vaultKek: KEK, modelProvider: model, sandbox: { backend: "virtual" } });
  await save("ws");
});
afterAll(async () => {
  await runtime?.close();
});

describe("disk versions of a virtual Agent", { timeout: 60_000 }, () => {
  it("snapshots, makes no version of an unchanged disk, and restores a version at once", async () => {
    expect((await make("disk/a")).status).toBe(200);
    expect((await call("GET", path("disk/a"))).body.disk).toEqual({ latestVersion: null, operation: null });
    const s = await session("disk/a");
    expect((await write(s, "notes.txt", "one\n")).status).toBe(200);
    expect((await write(s, "app/src/main.ts", "export {};\n")).status).toBe(200);

    const first = await call("POST", `${path("disk/a")}/snapshot`);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ agentId: "disk/a", version: 1, files: 2, unchanged: false, format: "nylorun.folder.v2" });
    expect(first.body.storedBytes).toBe(first.body.bytes);
    const same = await call("POST", `${path("disk/a")}/snapshot`);
    expect(same.body).toMatchObject({ version: 1, unchanged: true, storedBytes: 0 });

    await write(s, "notes.txt", "two\n");
    await write(s, "later.txt", "later\n");
    const second = await call("POST", `${path("disk/a")}/snapshot`);
    expect(second.body).toMatchObject({ version: 2, files: 3, unchanged: false });
    // main.ts was stored already: only the new bytes are stored.
    expect(second.body.storedBytes).toBe("two\n".length + "later\n".length);

    const versions = await call("GET", `${path("disk/a")}/versions`);
    expect(versions.body).toMatchObject({ agentId: "disk/a", artifactId: first.body.artifactId, latest: 2 });
    expect(versions.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    // The artifact names the Agent whose disk it holds, also in artifact pages.
    const artifact = await call("GET", `/v1/artifacts/${first.body.artifactId}`);
    expect(artifact.body).toMatchObject({ agentId: "disk/a", name: "disk", kind: "folder" });
    expect(artifact.body.environmentId).toBeUndefined();
    expect(artifact.body.sessionId).toBeUndefined();
    const page = await call("GET", "/v1/artifacts?limit=200");
    expect(page.body.artifacts.find((a: { artifactId: string }) => a.artifactId === first.body.artifactId))
      .toMatchObject({ agentId: "disk/a" });
    // A version reads as any folder artifact's.
    const tree = await call("GET", `/v1/artifacts/${first.body.artifactId}/versions/1/tree`);
    expect(tree.status).toBe(200);
    expect(JSON.stringify(tree.body)).toContain("workspace/app/src/main.ts");

    const restored = await call("POST", `${path("disk/a")}/restore`, { version: 1 });
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(restored.body).toEqual({ agentId: "disk/a", restored: 1, status: "done" });
    expect(await read(s, "notes.txt")).toContain("one");
    expect(await read(s, "later.txt")).toContain("sandbox.not_found");
    expect(await read(s, "app/src/main.ts")).toContain("export {}");
    // What was restored snapshots as unchanged from version 1's bytes: a new version, nothing stored.
    const after = await call("POST", `${path("disk/a")}/snapshot`);
    expect(after.body).toMatchObject({ version: 3, unchanged: false, storedBytes: 0 });
    expect((await call("GET", path("disk/a"))).body.disk).toEqual({ latestVersion: 3, operation: null });
  });

  it("refuses a snapshot past the Agent's own total, which its manifest sets", async () => {
    await save("tight", { kind: "virtual", limits: { artifacts: { totalBytes: 10 } } });
    expect((await make("disk/tight", { manifest: "tight" })).status).toBe(200);
    const s = await session("disk/tight");
    expect((await write(s, "notes.txt", "twenty bytes of text")).status).toBe(200);
    const refused = await call("POST", `${path("disk/tight")}/snapshot`);
    expect(refused.status).toBe(413);
    expect(refused.body).toMatchObject({
      code: "limit_exceeded",
      message: "Agent disk/tight's artifacts may hold at most 10 bytes; this version adds 20 to 0.",
      details: { limit: "environment_total", max: 10 },
    });
    expect((await call("GET", path("disk/tight"))).body.disk).toEqual({ latestVersion: null, operation: null });
  });

  it("holds a version to the Agent's limits.disk, within the Tenant's diskVersion limits", async () => {
    // A manifest may not ask for more than the Tenant allows: refused at save.
    const over = await writeManifest(
      runtime.url,
      headers,
      manifestOf(bot, { name: "over", runtime: { kind: "virtual", limits: { disk: { versionEntries: 1_000_000 } } } }),
    );
    expect(over.status).toBe(400);
    expect(JSON.stringify(over.body)).toContain("limits.disk.versionEntries asks for 1000000 entries");
    await save("few", { kind: "virtual", limits: { disk: { versionBytes: 5 } } });
    expect((await make("disk/few", { manifest: "few" })).status).toBe(200);
    const s = await session("disk/few");
    expect((await write(s, "notes.txt", "twenty bytes of text")).status).toBe(200);
    const refused = await call("POST", `${path("disk/few")}/snapshot`);
    expect(refused.status).toBe(413);
    expect(refused.body).toMatchObject({ code: "limit_exceeded", details: { limit: "bytes", max: 5 } });
    expect(refused.body.message).toContain("diskVersionBytes");
    expect((await call("GET", path("disk/few"))).body.limits.disk).toEqual({
      versionBytes: 5,
      versionEntries: RUNTIME_LIMIT_DEFAULTS.diskVersionEntries,
    });
  });

  it("creates an Agent from another's version, which then diverges", async () => {
    const forked = await make("disk/b", { from: { agent: "disk/a", version: 2 } });
    expect(forked.status, JSON.stringify(forked.body)).toBe(200);
    const b = await session("disk/b");
    expect(await read(b, "notes.txt")).toContain("two");
    expect(await read(b, "later.txt")).toContain("later");
    await write(b, "notes.txt", "b's own\n");
    const a = await session("disk/a");
    expect(await read(a, "notes.txt")).toContain("one");
    expect((await call("GET", path("disk/b"))).body.forkedFrom).toBeNull();
    // `from` only creates; a missing version or Agent is refused.
    expect((await make("disk/b", { from: { agent: "disk/a", version: 1 } })).status).toBe(409);
    expect((await make("disk/c", { from: { agent: "disk/a", version: 9 } })).status).toBe(404);
    expect((await make("disk/c", { from: { agent: "disk/none", version: "latest" } })).status).toBe(404);
    const latest = await make("disk/c", { from: { agent: "disk/a", version: "latest" } });
    expect(latest.status, JSON.stringify(latest.body)).toBe(200);
    expect(await read(await session("disk/c"), "notes.txt")).toContain("one");
  });

  it("refuses a snapshot or restore during a turn, and on kind none", async () => {
    const s = await session("disk/a");
    let open!: () => void;
    gate = new Promise<void>((resolve) => (open = resolve));
    const sent = await call("POST", `/v1/sessions/${s}/commands`, { type: "message", requestId: "m1", idempotencyKey: "m1", content: "go" });
    expect(sent.status).toBe(200);
    let busy: Awaited<ReturnType<typeof call>> | undefined;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      busy = await call("POST", `${path("disk/a")}/snapshot`);
      if (busy.status === 409) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(busy!.status).toBe(409);
    expect(busy!.body.code).toBe("agent_busy");
    expect((await call("POST", `${path("disk/a")}/restore`, { version: 1 })).body.code).toBe("agent_busy");
    open();
    gate = undefined;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if ((await call("POST", `${path("disk/a")}/snapshot`)).status === 201) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await saveManifest(runtime.url, headers, manifestOf(bot, { name: "plain" }));
    expect((await make("disk/none", { manifest: "plain" })).status).toBe(200);
    expect((await call("POST", `${path("disk/none")}/snapshot`)).status).toBe(400);
  });

  it("deletes a version, and the Agent's versions with it", async () => {
    const deleted = await call("DELETE", `${path("disk/a")}/versions/1`);
    expect(deleted.body).toEqual({ agentId: "disk/a", version: 1, deleted: true });
    expect((await call("DELETE", `${path("disk/a")}/versions/1`)).body.deleted).toBe(false);
    expect((await call("POST", `${path("disk/a")}/restore`, { version: 1 })).status).toBe(404);
    expect((await call("DELETE", `${path("disk/a")}/versions/x`)).status).toBe(400);
    const { artifactId } = (await call("GET", `${path("disk/a")}/versions`)).body;
    expect((await call("DELETE", `/v1/artifacts/${artifactId}`)).status).toBe(409);
    expect((await call("DELETE", path("disk/a"))).body.deleted).toBe(true);
    expect((await call("GET", `/v1/artifacts/${artifactId}`)).status).toBe(404);
  });
});
