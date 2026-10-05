/**
 * F8.1 file artifacts (protocol 6): one streamed upload, list, Range downloads, capability links,
 * limits, `artifact.*` events, delete, a subject's reach, and an image named by a message part
 * reaching the model. Every test runs on the `fs` BlobStore; the S3 path is the conformance
 * suite's (`test/blob/`).
 */
import { afterEach, expect, it, vi } from "vitest";
import { Agent } from "@nylorun/core/define";
import { createClient } from "@nylorun/agents";
import { createFsBlobStore } from "../src/blob/index.js";
import { artifactFiles, FileUnavailableError } from "../src/artifacts/files.js";
import type { SessionStore } from "../src/store/types.js";
import { tenantPaths } from "../src/tenant/paths.js";
import type { ModelProvider } from "../src/core/provider.js";
import { startTestTenant } from "./support/tenant.js";

const APP = "artifact-test-application-key-aaaaaaaa";
const json = { authorization: `Bearer ${APP}`, "content-type": "application/json" };
const auth = { authorization: `Bearer ${APP}` };
const asAda = { ...auth, "nylorun-subject": "ada", "nylorun-scopes": "sessions:own" };
const asBob = { ...auth, "nylorun-subject": "bob", "nylorun-scopes": "sessions:own" };
/** A 1×1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(closers.splice(0).map((close) => close()));
});

type Runtime = Awaited<ReturnType<typeof startTestTenant>>;

async function boot(options: Parameters<typeof startTestTenant>[0] = {}): Promise<Runtime> {
  const runtime = await startTestTenant({
    applicationKey: APP,
    sandbox: { backend: "virtual" },
    ...options,
  });
  closers.push(() => runtime.close());
  return runtime;
}

async function openSession(
  runtime: Runtime,
  id: string,
  owner = "ada",
  extra: Record<string, unknown> = {},
): Promise<void> {
  const agent = Agent({ id: "bot", name: "Bot" }).instructions("Answer.").build();
  const put = await fetch(`${runtime.url}/v1/agents/bot`, {
    method: "PUT",
    headers: json,
    body: JSON.stringify({ requestId: "agent", manifest: agent.manifest, implementationVersion: "dev" }),
  });
  expect(put.ok, await put.clone().text()).toBe(true);
  const opened = await fetch(`${runtime.url}/v1/sessions/${id}`, {
    method: "PUT",
    headers: json,
    body: JSON.stringify({ requestId: `open-${id}`, agentId: "bot", ownerUserId: owner, ...extra }),
  });
  expect(opened.ok, await opened.clone().text()).toBe(true);
}

function upload(
  runtime: Runtime,
  query: string,
  body: BodyInit,
  headers: Record<string, string> = auth,
  contentType = "text/plain",
) {
  return fetch(`${runtime.url}/v1/artifacts?${query}`, {
    method: "POST",
    headers: { ...headers, "content-type": contentType },
    body,
    duplex: "half",
  } as RequestInit);
}

async function uploaded(response: Response) {
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as {
    artifact: { artifactId: string; latestVersion: number; sessionId?: string; name: string };
    version: { version: number; size: number; sha256: string; contentType: string };
  };
}

async function items(runtime: Runtime, sessionId: string) {
  const response = await fetch(`${runtime.url}/v1/sessions/${sessionId}/items`, { headers: auth });
  return ((await response.json()) as { items: { type: string; turnId: string | null; payload: any }[] })
    .items;
}

async function settle(runtime: Runtime, sessionId: string): Promise<string> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const view = (await (
      await fetch(`${runtime.url}/v1/sessions/${sessionId}`, { headers: auth })
    ).json()) as { status: string };
    if (["completed", "failed", "cancelled", "uncertain"].includes(view.status)) return view.status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("session did not settle");
}

/** A body that arrives in chunks, with no Content-Length. */
function streamOf(chunks: number, size: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent === chunks) return controller.close();
      sent += 1;
      controller.enqueue(new Uint8Array(size).fill(65 + sent));
    },
  });
}

it("uploads in one request, lists, downloads with Range, versions and deletes, with events", async () => {
  const runtime = await boot();
  await openSession(runtime, "s1");
  const text = "hello, artifacts: 0123456789";
  const first = await uploaded(await upload(runtime, "name=notes.txt&sessionId=s1&label=kind=notes", text));
  const id = first.artifact.artifactId;
  expect(id).toMatch(/^af_[0-9a-z]{26}$/);
  expect(first.version).toMatchObject({ version: 1, size: text.length, contentType: "text/plain" });

  // Listed by session and in all.
  const bySession = (await (
    await fetch(`${runtime.url}/v1/artifacts?sessionId=s1`, { headers: auth })
  ).json()) as { artifacts: { artifactId: string; labels?: Record<string, string> }[] };
  expect(bySession.artifacts.map((item) => item.artifactId)).toEqual([id]);
  expect(bySession.artifacts[0]!.labels).toEqual({ kind: "notes" });

  // Whole, ranged, suffix and unsatisfiable downloads.
  const content = `${runtime.url}/v1/artifacts/${id}/versions/latest/content`;
  const whole = await fetch(content, { headers: auth });
  expect(whole.status).toBe(200);
  expect(whole.headers.get("accept-ranges")).toBe("bytes");
  expect(whole.headers.get("etag")).toBe(`"${first.version.sha256}"`);
  expect(await whole.text()).toBe(text);
  const ranged = await fetch(content, { headers: { ...auth, range: "bytes=7-15" } });
  expect(ranged.status).toBe(206);
  expect(ranged.headers.get("content-range")).toBe(`bytes 7-15/${text.length}`);
  expect(ranged.headers.get("content-length")).toBe("9");
  expect(await ranged.text()).toBe(text.slice(7, 16));
  const suffix = await fetch(content, { headers: { ...auth, range: "bytes=-4" } });
  expect(suffix.status).toBe(206);
  expect(await suffix.text()).toBe("6789");
  const past = await fetch(content, { headers: { ...auth, range: `bytes=${text.length}-` } });
  expect(past.status).toBe(416);
  expect(past.headers.get("content-range")).toBe(`bytes */${text.length}`);

  // A second version.
  const second = await uploaded(
    await fetch(`${runtime.url}/v1/artifacts/${id}/versions`, {
      method: "POST",
      headers: { ...auth, "content-type": "text/markdown" },
      body: "# v2",
    }),
  );
  expect(second.version).toMatchObject({ version: 2, contentType: "text/markdown" });
  const view = (await (await fetch(`${runtime.url}/v1/artifacts/${id}`, { headers: auth })).json()) as {
    latestVersion: number;
    versions: { version: number }[];
  };
  expect(view.latestVersion).toBe(2);
  expect(view.versions.map((item) => item.version)).toEqual([1, 2]);
  expect(await (await fetch(`${runtime.url}/v1/artifacts/${id}/versions/1/content`, { headers: auth })).text()).toBe(text);

  // Delete: rows, bytes and links go; history keeps what happened.
  const deleted = await fetch(`${runtime.url}/v1/artifacts/${id}`, { method: "DELETE", headers: auth });
  expect(await deleted.json()).toEqual({ artifactId: id, deleted: true });
  expect((await fetch(`${runtime.url}/v1/artifacts/${id}`, { headers: auth })).status).toBe(404);
  const blobs = createFsBlobStore({ root: tenantPaths(runtime.root).blobs });
  const left: string[] = [];
  for await (const entry of blobs.list("artifacts/")) left.push(entry.key);
  expect(left).toEqual([]);

  const history = await items(runtime, "s1");
  const events = history.filter((item) => item.type.startsWith("artifact."));
  expect(events.map((item) => item.type)).toEqual([
    "artifact.created",
    "artifact.version.created",
    "artifact.deleted",
  ]);
  expect(events[0]!.payload).toMatchObject({
    artifactId: id,
    kind: "file",
    name: "notes.txt",
    version: 1,
    size: text.length,
    sha256: first.version.sha256,
    source: "upload",
  });
});

it("opens a capability link with no credential, with Range, until it expires; a tampered one is a 404", async () => {
  const runtime = await boot();
  await openSession(runtime, "s1");
  const { artifact } = await uploaded(await upload(runtime, "name=a.bin&sessionId=s1", "0123456789", auth, "application/octet-stream"));
  const minted = await fetch(`${runtime.url}/v1/artifacts/${artifact.artifactId}/links`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ expiresIn: 60 }),
  });
  expect(minted.status, await minted.clone().text()).toBe(200);
  const link = (await minted.json()) as { path: string; version: number; expiresAt: string };
  expect(link.path).toMatch(/^\/v1\/artifact-links\/[\w-]+\.[\w-]+\.[\w-]+$/);
  expect(link.version).toBe(1);

  const opened = await fetch(`${runtime.url}${link.path}`);
  expect(opened.status).toBe(200);
  expect(await opened.text()).toBe("0123456789");
  const part = await fetch(`${runtime.url}${link.path}`, { headers: { range: "bytes=2-4" } });
  expect(part.status).toBe(206);
  expect(await part.text()).toBe("234");

  // Tampered: another signature byte.
  const token = link.path.split("/").at(-1)!;
  const flipped = token.slice(0, -2) + (token.at(-2) === "A" ? "B" : "A") + token.at(-1);
  expect((await fetch(`${runtime.url}/v1/artifact-links/${flipped}`)).status).toBe(404);
  expect((await fetch(`${runtime.url}/v1/artifact-links/not-a-token`)).status).toBe(404);

  // Expired: well past its 60 s and the clock tolerance.
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 10 * 60_000 });
  const expired = await fetch(`${runtime.url}${link.path}`);
  expect(expired.status).toBe(401);
  expect(((await expired.json()) as { code: string }).code).toBe("token_expired");
  vi.useRealTimers();

  // Deleted: the link opens nothing.
  await fetch(`${runtime.url}/v1/artifacts/${artifact.artifactId}`, { method: "DELETE", headers: auth });
  expect((await fetch(`${runtime.url}${link.path}`)).status).toBe(404);
});

it("refuses a body past the per-file cap mid-stream and stores nothing; then the Tenant total", async () => {
  const runtime = await boot();
  await openSession(runtime, "s1");
  const limits = await fetch(`${runtime.url}/v1/tenant/artifacts`, {
    method: "PUT",
    headers: runtime.managementHeaders(),
    body: JSON.stringify({ limits: { fileBytes: 1024, totalBytes: 1500 } }),
  });
  expect(await limits.json()).toEqual({ limits: { fileBytes: 1024, totalBytes: 1500 }, usedBytes: 0 });

  // 4 KiB in 512-byte chunks, no Content-Length: refused once it passes 1 KiB.
  const tooBig = await upload(runtime, "name=big.bin&sessionId=s1", streamOf(8, 512));
  expect(tooBig.status).toBe(413);
  expect(((await tooBig.json()) as { code: string }).code).toBe("limit_exceeded");
  // A declared length past the cap is refused before a byte is read.
  const declared = await upload(runtime, "name=big.bin&sessionId=s1", new Uint8Array(2048));
  expect(declared.status).toBe(413);
  const blobs = createFsBlobStore({ root: tenantPaths(runtime.root).blobs });
  const keys: string[] = [];
  for await (const entry of blobs.list("artifacts/")) keys.push(entry.key);
  expect(keys).toEqual([]);
  const listed = (await (await fetch(`${runtime.url}/v1/artifacts`, { headers: auth })).json()) as {
    artifacts: unknown[];
  };
  expect(listed.artifacts).toEqual([]);

  // The Tenant total: 1000 fits, a second 1000 does not.
  await uploaded(await upload(runtime, "name=one.bin&sessionId=s1", new Uint8Array(1000)));
  const full = await upload(runtime, "name=two.bin&sessionId=s1", streamOf(2, 500));
  expect(full.status).toBe(413);
  const view = (await (await fetch(`${runtime.url}/v1/tenant/artifacts`, { headers: runtime.managementHeaders() })).json()) as {
    usedBytes: number;
  };
  expect(view.usedBytes).toBe(1000);
});

it("lets a person reach only the artifacts of their own sessions", async () => {
  const runtime = await boot();
  await openSession(runtime, "ada-1", "ada");
  await openSession(runtime, "bob-1", "bob");
  const mine = await uploaded(await upload(runtime, "name=a.txt&sessionId=ada-1", "ada's", asAda));
  // Not in another person's session, and not Tenant-wide.
  expect((await upload(runtime, "name=x.txt&sessionId=bob-1", "x", asAda)).status).toBe(404);
  expect((await upload(runtime, "name=x.txt", "x", asAda)).status).toBe(400);
  // A Tenant-wide artifact an application made.
  const shared = await uploaded(await upload(runtime, "name=t.txt", "tenant"));
  expect(shared.artifact.sessionId).toBeUndefined();

  const id = mine.artifact.artifactId;
  const content = `${runtime.url}/v1/artifacts/${id}/versions/1/content`;
  expect(await (await fetch(content, { headers: asAda })).text()).toBe("ada's");
  expect((await fetch(content, { headers: asBob })).status).toBe(404);
  expect((await fetch(`${runtime.url}/v1/artifacts/${id}`, { headers: asBob })).status).toBe(404);
  expect(
    (await fetch(`${runtime.url}/v1/artifacts/${shared.artifact.artifactId}`, { headers: asAda })).status,
  ).toBe(404);
  const adas = (await (await fetch(`${runtime.url}/v1/artifacts`, { headers: asAda })).json()) as {
    artifacts: { artifactId: string }[];
  };
  expect(adas.artifacts.map((item) => item.artifactId)).toEqual([id]);
  const bobs = (await (await fetch(`${runtime.url}/v1/artifacts`, { headers: asBob })).json()) as {
    artifacts: unknown[];
  };
  expect(bobs.artifacts).toEqual([]);
  expect((await fetch(`${runtime.url}/v1/artifacts/${id}`, { method: "DELETE", headers: asBob })).status).toBe(404);
});

const PROVIDER = "https://models.artifact-test.invalid/v1";
const realFetch = globalThis.fetch;

for (const gate of ["in-process", "http"] as const)
  it(`sends an image a message part names to the model (${gate} gate)`, async () => {
    if (gate === "http") vi.stubEnv("NYLORUN_TEST_MODEL_GATE", "http");
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (!url.startsWith(PROVIDER)) return realFetch(input, init);
        requests.push(String(init?.body));
        const chunk = (delta: unknown, finish: string | null) =>
          `data: ${JSON.stringify({ id: "r", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        return new Response(
          `${chunk({ role: "assistant", content: "A tiny image." }, null)}${chunk({}, "stop")}data: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const runtime = await boot({ useHostModel: true, modelCall: { retryBaseDelayMs: 1 } });
    const configured = await realFetch(`${runtime.url}/v1/tenant/model`, {
      method: "PUT",
      headers: runtime.managementHeaders(),
      body: JSON.stringify({
        requestId: "model-1",
        idempotencyKey: "model-1",
        provider: "custom",
        model: "vision-model",
        baseUrl: PROVIDER,
        auth: { type: "api_key", key: "artifact-test-provider-key" },
      }),
    });
    expect(configured.status, await configured.clone().text()).toBe(200);
    await openSession(runtime, "s1");
    const { artifact } = await uploaded(await upload(runtime, "name=room.png&sessionId=s1", PNG, auth, "image/png"));
    const sent = await realFetch(`${runtime.url}/v1/sessions/s1/commands`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        type: "message",
        requestId: "m1",
        idempotencyKey: "m1",
        parts: [
          { type: "text", text: "What is in this picture?" },
          { type: "file", artifactId: artifact.artifactId },
        ],
      }),
    });
    expect(sent.status, await sent.clone().text()).toBe(200);
    expect(await settle(runtime, "s1")).toBe("completed");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain(`data:image/png;base64,${PNG.toString("base64")}`);
    expect(requests[0]).toContain("What is in this picture?");
    // The record holds the reference, never the bytes.
    const history = await items(runtime, "s1");
    const message = history.find((item) => item.type === "command.message");
    expect(message?.payload.parts).toEqual([
      { type: "text", text: "What is in this picture?" },
      { type: "file", artifactId: artifact.artifactId },
    ]);
    expect(JSON.stringify(history)).not.toContain(PNG.toString("base64"));
  });

it("works through the @nylorun/agents client: upload, list, Range, link, delete", async () => {
  const runtime = await boot();
  await openSession(runtime, "s1");
  const client = createClient({ url: runtime.url, key: APP });
  const ada = client.as("ada");
  const { artifact } = await ada.artifacts.upload(new Blob(["from a client"], { type: "text/plain" }), {
    name: "client.txt",
    sessionId: "s1",
  });
  expect((await ada.artifacts.list({ sessionId: "s1" })).map((item) => item.name)).toEqual(["client.txt"]);
  const part = await ada.artifacts.download(artifact.artifactId, { range: { start: 5 } });
  expect(part.status).toBe(206);
  expect(await part.text()).toBe("a client");
  const link = await ada.artifacts.link(artifact.artifactId);
  expect(await (await fetch(link.url)).text()).toBe("from a client");
  await ada.artifacts.delete(artifact.artifactId);
  expect(await client.artifacts.list()).toEqual([]);
});

it("never skips the session check when model-gate reads a file", async () => {
  const runtime = await boot();
  await openSession(runtime, "s1");
  const { artifact } = await uploaded(await upload(runtime, "name=a.txt&sessionId=s1", "secret"));
  const files = (sessionId: string | undefined) =>
    artifactFiles({
      store: (runtime.handle as unknown as { ctx: { store: SessionStore } }).ctx.store,
      blobs: createFsBlobStore({ root: tenantPaths(runtime.root).blobs }),
      sessionId,
    })({ artifactId: artifact.artifactId, version: 1 });
  expect(new TextDecoder().decode((await files("s1")).bytes)).toBe("secret");
  await expect(files("s2")).rejects.toBeInstanceOf(FileUnavailableError);
  await expect(files(undefined)).rejects.toBeInstanceOf(FileUnavailableError);
  await expect(files("")).rejects.toBeInstanceOf(FileUnavailableError);
});

it("refuses a file part naming another session's artifact, or one that does not exist", async () => {
  const runtime = await boot();
  await openSession(runtime, "s1");
  await openSession(runtime, "s2");
  const { artifact } = await uploaded(await upload(runtime, "name=a.txt&sessionId=s2", "other"));
  const send = (artifactId: string) =>
    fetch(`${runtime.url}/v1/sessions/s1/commands`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        type: "message",
        requestId: artifactId,
        idempotencyKey: artifactId,
        parts: [{ type: "file", artifactId }],
      }),
    });
  expect((await send(artifact.artifactId)).status).toBe(400);
  expect((await send("af_00000000000000000000000000")).status).toBe(404);
});

/** A model that runs `steps` tool calls in turn, then answers. */
function scripted(steps: { name: string; args: Record<string, unknown> }[], seen: unknown[]): ModelProvider {
  return async (effect) => {
    const prompt = (effect.input as { prompt?: { kind?: string; content?: unknown }[] }).prompt ?? [];
    const results = prompt.filter((item) => item.kind === "tool-result");
    seen.push(results.at(-1));
    const step = steps[results.length];
    if (!step) return { output: [{ type: "text", text: "done" }] };
    return { output: [{ type: "tool-call", id: `call-${results.length}`, name: step.name, args: step.args }] };
  };
}

it("saves a sandbox file and inline text as artifacts from our engine", async () => {
  const seen: unknown[] = [];
  const runtime = await boot({
    modelProvider: scripted(
      [
        // The virtual shell writes text (UTF-8), so the bytes stay below 0x80.
        { name: "bash", args: { command: "printf 'PNG\\x00\\x01\\x7f' > /workspace/chart.png" } },
        { name: "save_artifact", args: { path: "chart.png" } },
        { name: "save_artifact", args: { content: "# Report", name: "report.md" } },
        { name: "save_artifact", args: { path: "missing.txt" } },
      ],
      seen,
    ),
  });
  await openSession(runtime, "s1", "ada", { sandbox: {} });
  const sent = await fetch(`${runtime.url}/v1/sessions/s1/commands`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ type: "message", requestId: "m1", idempotencyKey: "m1", content: "Make a chart" }),
  });
  expect(sent.status, await sent.clone().text()).toBe(200);
  expect(await settle(runtime, "s1")).toBe("completed");

  const listed = (await (await fetch(`${runtime.url}/v1/artifacts?sessionId=s1`, { headers: auth })).json()) as {
    artifacts: { artifactId: string; name: string; contentType: string }[];
  };
  expect(listed.artifacts.map((item) => [item.name, item.contentType])).toEqual([
    ["chart.png", "image/png"],
    ["report.md", "text/markdown"],
  ]);
  const chart = await fetch(
    `${runtime.url}/v1/artifacts/${listed.artifacts[0]!.artifactId}/versions/1/content`,
    { headers: auth },
  );
  expect([...new Uint8Array(await chart.arrayBuffer())]).toEqual([0x50, 0x4e, 0x47, 0x00, 0x01, 0x7f]);

  const history = await items(runtime, "s1");
  const created = history.filter((item) => item.type === "artifact.created");
  expect(created).toHaveLength(2);
  expect(created[0]!.payload).toMatchObject({ name: "chart.png", source: "engine", callId: expect.any(String) });
  expect(created[0]!.turnId).toEqual(expect.any(String));
  // The missing file is a failed outcome the model sees, not a failed turn.
  const outcomes = history.filter((item) => item.type === "tool.completed" && item.payload.toolName === "save_artifact");
  expect(outcomes.map((item) => (item.payload.error ? item.payload.error.code : "ok"))).toEqual([
    "ok",
    "ok",
    "artifact.not_found",
  ]);
});
