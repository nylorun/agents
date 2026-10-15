/**
 * The artifact seam (protocol 15): a harness reads and writes the artifacts of the run it holds,
 * scoped by the run's session, in chunks of at most its `limits.chunkBytes`, idempotent by key,
 * linked to a tool call of its turn. A fake harness holds a real run, over the in-process memory
 * channel (JSON, every frame validated) and over a WebSocket to the Harness API listener.
 */
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  HARNESS_API_VERSION,
  createChannel,
  effectRequestHash,
  fromBase64,
  memoryChannels,
  toBase64,
  writeArtifactBytes,
  type EffectIntent,
  type HarnessChannel,
  type RunGrant,
  type TurnStart,
} from "@nylorun/core/harness-api";
import { newArtifactId } from "@nylorun/core/compatibility";
import { startHarnessListener } from "../../src/harness-api/ws-server.js";
import { wsPort } from "../../src/harness/ws-port.js";
import { sessionMayRead } from "../../src/artifacts/files.js";
import type { Tx } from "../../src/store/types.js";
import { boot, openSession, server, until, view, type Started } from "../host/execution-support.js";

const TOKEN = "ef".repeat(32);
const logger = { info() {}, warn() {} };

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Transport = "memory" | "ws";

/** A harness channel to the Runtime, said hello as ours. */
async function connect(runtime: Started, transport: Transport): Promise<HarnessChannel> {
  let channel: HarnessChannel;
  if (transport === "memory") {
    const channels = memoryChannels({ json: true });
    const detach = runtime.handle.attachHarness!(channels.core, { name: "test" });
    cleanups.push(() => {
      channels.harness.close("test over");
      detach();
    });
    channel = channels.harness;
  } else {
    const listener = await startHarnessListener({
      host: "127.0.0.1",
      port: 0,
      allowedHosts: [],
      token: TOKEN,
      attach: async () => (core, peer) => runtime.handle.attachHarness!(core, peer),
      logger,
    });
    cleanups.push(() => listener.close());
    const socket = new WebSocket(listener.url, {
      headers: { authorization: `Bearer ${TOKEN}`, "nylorun-harness-api": "1" },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    channel = createChannel(wsPort(socket), { validate: true });
    cleanups.push(() => channel.close("test over"));
  }
  await channel.request("hello", { api: HARNESS_API_VERSION, name: "nylorun", version: "0", features: {} });
  return channel;
}

async function call(runtime: Started, method: string, path: string, body?: unknown) {
  const response = await fetch(`${runtime.url}${path}`, {
    method,
    headers: server,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json().catch(() => undefined)) as any };
}

async function upload(runtime: Started, query: string, body: string | Uint8Array, contentType = "text/plain") {
  const response = await fetch(`${runtime.url}/v1/artifacts?${query}`, {
    method: "POST",
    headers: { authorization: server.authorization, "content-type": contentType },
    body,
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { artifact: { artifactId: string } }).artifact.artifactId;
}

async function putLimits(runtime: Started, path: string, limits: Record<string, number>) {
  const response = await fetch(`${runtime.url}${path}`, {
    method: "PUT",
    headers: { ...runtime.managementHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ limits }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

const ctxOf = (runtime: Started) =>
  (runtime.handle as unknown as { ctx: { store: { tx<T>(work: (t: Tx) => Promise<T>): Promise<T> } } }).ctx;

interface Held {
  readonly runtime: Started;
  readonly harness: HarnessChannel;
  readonly run: RunGrant;
  readonly input: TurnStart;
  readonly ids: Record<string, string>;
}

/**
 * A Runtime with only the fake harness connected, holding session s1's run. The message named
 * the Tenant-wide artifact `named`; `unnamed` is Tenant-wide too, `others` is session s2's.
 */
async function hold(transport: Transport, options: { chunkBytes?: number } = {}): Promise<Held> {
  const runtime = await boot({ harness: "remote" });
  cleanups.push(() => runtime.close());
  if (options.chunkBytes !== undefined) await putLimits(runtime, "/v1/tenant/limits", { chunkBytes: options.chunkBytes });
  const harness = await connect(runtime, transport);
  await openSession(runtime, "s1");
  await openSession(runtime, "s2", false);
  const ids = {
    own: await upload(runtime, "name=own.txt&sessionId=s1", "hello, seam"),
    others: await upload(runtime, "name=theirs.txt&sessionId=s2", "not yours"),
    named: await upload(runtime, "name=named.txt", "tenant wide"),
    unnamed: await upload(runtime, "name=unnamed.txt", "never named"),
  };
  const leased = harness.request("lease", {});
  const sent = await call(runtime, "POST", "/v1/sessions/s1/commands", {
    type: "message",
    requestId: "m1",
    idempotencyKey: "m1",
    parts: [
      { type: "text", text: "go" },
      { type: "file", artifactId: ids.named },
    ],
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  const { run, input } = await leased;
  cleanups.unshift(async () => {
    await harness.request("turn.completed", { runId: run.runId, status: "completed", state: {}, output: "done" }).catch(() => undefined);
  });
  return { runtime, harness, run, input, ids };
}

const read = (held: Held, params: Record<string, unknown>) =>
  held.harness.request("artifact.read", { runId: held.run.runId, ...params } as never);
const write = (held: Held, params: Record<string, unknown>) =>
  held.harness.request("artifact.write", { runId: held.run.runId, ...params } as never);

async function items(runtime: Started, sessionId = "s1") {
  return (await call(runtime, "GET", `/v1/sessions/${sessionId}/items`)).body.items as {
    type: string;
    turnId: string | null;
    payload: Record<string, unknown>;
  }[];
}

describe.each(["memory", "ws"] as const)("the artifact seam over %s", (transport) => {
  it("reads the session's own artifacts and the Tenant-wide ones its messages named, and nothing else", async () => {
    const held = await hold(transport);
    const own = await read(held, { artifactId: held.ids.own });
    expect(own).toEqual({
      artifact: {
        artifactId: held.ids.own,
        kind: "file",
        name: "own.txt",
        version: 1,
        contentType: "text/plain",
        size: 11,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        tenantWide: false,
      },
      offset: 0,
      base64: toBase64(new TextEncoder().encode("hello, seam")),
      eof: true,
    });
    const named = await read(held, { artifactId: held.ids.named, offset: 7 });
    expect(named).toMatchObject({ artifact: { tenantWide: true }, offset: 7, eof: true });
    expect(new TextDecoder().decode(fromBase64(named.base64))).toBe("wide");
    // Metadata alone.
    expect(await read(held, { artifactId: held.ids.own, length: 0 })).toMatchObject({ base64: "", eof: false });
    // Another session's, a Tenant-wide one never named, and none at all: the same not_found.
    for (const artifactId of [held.ids.others, held.ids.unnamed, newArtifactId(), "not-an-id"])
      await expect(read(held, { artifactId })).rejects.toMatchObject({
        code: "not_found",
        message: `Artifact ${artifactId} is not an artifact of this session.`,
      });
    await expect(read(held, { artifactId: held.ids.own, version: 2 })).rejects.toMatchObject({ code: "not_found" });
    await expect(read(held, { artifactId: held.ids.own, offset: 12 })).rejects.toMatchObject({
      code: "invalid",
      message: "Offset 12 is past the end of own.txt, which is 11 bytes.",
    });
    expect(await read(held, { artifactId: held.ids.own, offset: 11 })).toMatchObject({ base64: "", eof: true });
  });

  it("answers a folder's metadata without bytes", async () => {
    const held = await hold(transport);
    const id = newArtifactId();
    const at = new Date().toISOString();
    await ctxOf(held.runtime).store.tx((t) =>
      t.insertArtifact(
        { id, kind: "folder", name: "outputs", contentType: "application/json", sessionId: "s1", latestVersion: 1, labelsJson: null, createdAt: at, updatedAt: at, environmentId: null },
        { artifactId: id, version: 1, blobKey: `artifacts/${id}/manifest`, size: 10, sha256: "0".repeat(64), contentType: "application/json", source: "export", createdAt: at, writeKey: null },
      ),
    );
    expect(await read(held, { artifactId: id })).toMatchObject({ artifact: { kind: "folder", name: "outputs" }, base64: "", eof: true });
  });

  it("holds a read to the run's chunkBytes", async () => {
    const held = await hold(transport, { chunkBytes: 4 });
    expect(held.input.limits.chunkBytes).toBe(4);
    const first = await read(held, { artifactId: held.ids.own, length: 100 });
    expect(new TextDecoder().decode(fromBase64(first.base64))).toBe("hell");
    expect(first.eof).toBe(false);
  });

  it("writes in chunks with begin, chunk and commit, and acknowledges a repeated chunk", async () => {
    const held = await hold(transport, { chunkBytes: 4 });
    const begun = await write(held, { op: "begin", key: "k1", name: "report.md", size: 10 });
    expect(begun).toMatchObject({ status: "open", maxBytes: expect.any(Number), received: 0 });
    const uploadId = (begun as { uploadId: string }).uploadId;
    const chunk = (offset: number, text: string) => write(held, { op: "chunk", uploadId, offset, base64: toBase64(new TextEncoder().encode(text)) });
    expect(await chunk(0, "# Re")).toMatchObject({ status: "open", received: 4 });
    // Its answer lost, the harness sends the chunk again: acknowledged, not taken twice.
    expect(await chunk(0, "# Re")).toMatchObject({ status: "open", received: 4 });
    await expect(chunk(8, "xx")).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("starts at 8") });
    // A chunk past the run's chunkBytes is past a Runtime limit.
    await expect(chunk(4, "port!")).rejects.toMatchObject({ code: "limit_exceeded", message: expect.stringContaining("chunkBytes (4 bytes") });
    expect(await chunk(4, "port")).toMatchObject({ received: 8 });
    expect(await chunk(8, "\n.")).toMatchObject({ received: 10 });
    const done = await write(held, { op: "commit", uploadId });
    expect(done).toMatchObject({ status: "written", created: true, artifact: { name: "report.md", contentType: "text/markdown", size: 10, version: 1 } });
    const artifactId = (done as { artifact: { artifactId: string } }).artifact.artifactId;
    const content = await fetch(`${held.runtime.url}/v1/artifacts/${artifactId}/versions/1/content`, { headers: { authorization: server.authorization } });
    expect(await content.text()).toBe("# Report\n.");
    // The upload is gone once committed; an abort of it is answered all the same.
    await expect(write(held, { op: "commit", uploadId })).rejects.toMatchObject({ code: "invalid" });
    expect(await write(held, { op: "abort", uploadId })).toEqual({ status: "aborted" });
    // A whole body that fits one chunk goes in the begin.
    const inline = await write(held, { op: "begin", key: "k2", name: "a.txt", base64: toBase64(new Uint8Array([97])) });
    expect(inline).toMatchObject({ status: "written", created: true, artifact: { size: 1 } });
    const created = (await items(held.runtime)).filter((item) => item.type === "artifact.created" && item.payload.source === "engine");
    expect(created.map((item) => [item.payload.name, item.payload.source, item.turnId])).toEqual([
      ["report.md", "engine", held.run.turnId],
      ["a.txt", "engine", held.run.turnId],
    ]);
  });

  it("writes a new version only of the session's own file artifacts", async () => {
    const held = await hold(transport);
    const again = await writeArtifactBytes(
      held.harness,
      { runId: held.run.runId, key: "v2", artifactId: held.ids.own, chunkBytes: held.input.limits.chunkBytes },
      new TextEncoder().encode("second"),
    );
    expect(again).toMatchObject({ created: true, artifact: { artifactId: held.ids.own, version: 2, name: "own.txt" } });
    expect((await items(held.runtime)).some((item) => item.type === "artifact.version.created")).toBe(true);
    for (const artifactId of [held.ids.others, held.ids.named])
      await expect(write(held, { op: "begin", key: `x-${artifactId}`, artifactId, base64: "" })).rejects.toMatchObject({
        code: "not_found",
      });
    await expect(write(held, { op: "begin", key: "nameless", base64: "" })).rejects.toMatchObject({ code: "invalid" });
    await expect(write(held, { op: "begin", key: "bad-type", name: "a", contentType: "not a type", base64: "" })).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("refuses a write past the artifact limits before and while it streams", async () => {
    const held = await hold(transport, { chunkBytes: 4 });
    await putLimits(held.runtime, "/v1/tenant/artifacts", { fileBytes: 6 });
    await expect(write(held, { op: "begin", key: "big", name: "big.bin", size: 7 })).rejects.toMatchObject({
      code: "limit_exceeded",
      message: "A file may hold at most 6 bytes (limitBytes 6)",
    });
    await expect(write(held, { op: "begin", key: "big-inline", name: "big.bin", base64: toBase64(new Uint8Array(7)) })).rejects.toMatchObject({
      code: "limit_exceeded",
    });
    const begun = (await write(held, { op: "begin", key: "grows", name: "grows.bin" })) as { uploadId: string; maxBytes: number };
    expect(begun.maxBytes).toBe(6);
    await write(held, { op: "chunk", uploadId: begun.uploadId, offset: 0, base64: toBase64(new Uint8Array(4)) });
    await expect(write(held, { op: "chunk", uploadId: begun.uploadId, offset: 4, base64: toBase64(new Uint8Array(4)) })).rejects.toMatchObject({
      code: "limit_exceeded",
    });
    // The upload ended with its refusal; nothing was stored.
    await expect(write(held, { op: "commit", uploadId: begun.uploadId })).rejects.toMatchObject({ code: "invalid" });
    expect((await items(held.runtime)).filter((item) => item.type === "artifact.created" && item.payload.source === "engine")).toEqual([]);
  });

  it("answers a key written before with its version, also when two writes race", async () => {
    const held = await hold(transport);
    const begin = { op: "begin", key: "same", name: "once.txt", base64: toBase64(new TextEncoder().encode("once")) };
    const first = await write(held, begin);
    expect(first).toMatchObject({ status: "written", created: true });
    expect(await write(held, begin)).toEqual({ ...first, created: false });
    const racing = { ...begin, key: "race" };
    const both = await Promise.all([write(held, racing), write(held, racing)]);
    expect(both.map((answer) => (answer as { created: boolean }).created).sort()).toEqual([false, true]);
    expect(new Set(both.map((answer) => JSON.stringify((answer as { artifact: unknown }).artifact))).size).toBe(1);
    const created = (await items(held.runtime)).filter((item) => item.type === "artifact.created" && item.payload.source === "engine");
    expect(created).toHaveLength(2);
  });

  it("links an artifact to a tool call of the run's turn, and refuses any other effect", async () => {
    const held = await hold(transport);
    const checkpoint = held.input.checkpoint as { turnId: string; segment: number; manifestHash: string };
    const effect: EffectIntent = {
      effectId: `${checkpoint.turnId}:${checkpoint.segment}:tool:c1`,
      sessionId: "s1",
      turnId: held.run.turnId,
      agentId: "bot",
      manifestHash: checkpoint.manifestHash,
      kind: "tool",
      toolName: "lookup",
      input: {},
      context: { callId: "call-7", invocationId: "i1" },
    };
    await held.harness.request("effect.intent", { runId: held.run.runId, effect, requestHash: effectRequestHash(effect) });
    await write(held, { op: "begin", key: effect.effectId, effectId: effect.effectId, name: "linked.txt", base64: "" });
    const created = (await items(held.runtime)).find((item) => item.type === "artifact.created" && item.payload.source === "engine")!;
    expect(created.payload).toMatchObject({ name: "linked.txt", callId: "call-7" });
    await expect(write(held, { op: "begin", key: "k", effectId: "t1:0:tool:nope", name: "x.txt", base64: "" })).rejects.toMatchObject({
      code: "invalid",
      message: expect.stringContaining("is not a tool call of this run's turn"),
    });
  });

  it("ends an open upload with the run, and refuses the run to any other connection", async () => {
    const held = await hold(transport);
    const other = await connect(held.runtime, transport);
    await expect(other.request("artifact.read", { runId: held.run.runId, artifactId: held.ids.own })).rejects.toMatchObject({
      code: "run_not_held",
    });
    await expect(
      other.request("artifact.write", { runId: held.run.runId, op: "begin", key: "k", name: "x.txt", base64: "" }),
    ).rejects.toMatchObject({ code: "run_not_held" });
    const begun = (await write(held, { op: "begin", key: "left-open", name: "left.txt" })) as { uploadId: string };
    await write(held, { op: "chunk", uploadId: begun.uploadId, offset: 0, base64: toBase64(new Uint8Array([1])) });
    await held.harness.request("turn.completed", { runId: held.run.runId, status: "completed", state: {}, output: "done" });
    await until(() => view(held.runtime), (v) => v.status === "completed", "turn");
    await expect(write(held, { op: "commit", uploadId: begun.uploadId })).rejects.toMatchObject({ code: "run_not_held" });
    expect((await items(held.runtime)).filter((item) => item.type === "artifact.created" && item.payload.source === "engine")).toEqual([]);
  });
});

describe("the read rule", () => {
  it("lets a session read its own artifacts and the Tenant-wide ones it named, never a disk version", () => {
    const session = { id: "s1", fileArtifacts: ["af_named", "af_disk"] };
    const row = (id: string, sessionId: string | null, environmentId: string | null = null) => ({ id, sessionId, environmentId });
    expect(sessionMayRead(session, row("af_own", "s1"))).toBe(true);
    expect(sessionMayRead(session, row("af_named", null))).toBe(true);
    expect(sessionMayRead(session, row("af_theirs", "s2"))).toBe(false);
    expect(sessionMayRead(session, row("af_other", null))).toBe(false);
    expect(sessionMayRead(session, row("af_disk", null, "env-1"))).toBe(false);
    expect(sessionMayRead(undefined, row("af_own", "s1"))).toBe(false);
  });
});
