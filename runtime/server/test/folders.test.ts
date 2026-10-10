/**
 * F8.2 folder artifacts and the turn-end export: a turn that writes files into
 * `/workspace/outputs` of its (virtual) sandbox yields the session's `outputs` folder, whose tree
 * matches the workspace; later turns add versions only when something changed, unchanged files
 * are not stored again, and the folder reads as a tree, one file by path with Range, a diff
 * between versions, a zip and capability links. Every test runs on the `fs` BlobStore.
 *
 * Pod sandboxes (F7.2b) are read through the same `WorkspaceReader` seam; their half of the
 * F8.2 exit comes with them.
 */
import { createHash } from "node:crypto";
import { crc32, inflateRawSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import { createClient } from "@nylorun/agents";
import type { BlobStore } from "../src/blob/index.js";
import type { ModelProvider } from "../src/core/provider.js";
import { startTestTenant } from "./support/tenant.js";

const APP = "folders-test-application-key-aaaaaaaa";
const json = { authorization: `Bearer ${APP}`, "content-type": "application/json" };
const auth = { authorization: `Bearer ${APP}` };

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

type Runtime = Awaited<ReturnType<typeof startTestTenant>>;
type Item = { type: string; turnId: string | null; payload: any };

/** A model that plays `turns[k]`'s tool calls in the k-th turn it sees, one per step. */
function turns(script: readonly (readonly { name: string; args: Record<string, unknown> }[])[]): ModelProvider {
  const order = new Map<string, { index: number; baseline: number }>();
  return async (effect) => {
    const prompt = (effect.input as { prompt?: { kind?: string }[] }).prompt ?? [];
    const results = prompt.filter((item) => item.kind === "tool-result").length;
    if (!order.has(effect.turnId)) order.set(effect.turnId, { index: order.size, baseline: results });
    const { index, baseline } = order.get(effect.turnId)!;
    const call = script[index]?.[results - baseline];
    if (!call) return { output: [{ type: "text", text: "done" }] };
    return {
      output: [{ type: "tool-call", id: `call-${index}-${results - baseline}`, name: call.name, args: call.args }],
    };
  };
}

const bash = (command: string) => ({ name: "bash", args: { command } });

async function boot(
  modelProvider: ModelProvider,
  options: { wrapBlobs?: (blobs: BlobStore) => BlobStore; harness?: "memory" | "json" | "ws" } = {},
): Promise<Runtime> {
  const runtime = await startTestTenant({
    applicationKey: APP,
    sandbox: { backend: "virtual" },
    modelProvider,
    ...options,
  });
  closers.push(() => runtime.close());
  return runtime;
}

async function openSession(runtime: Runtime, id: string, extra: Record<string, unknown> = {}) {
  const agent = Agent({ id: "builder", name: "Builder" }).instructions("Build.").build();
  const put = await fetch(`${runtime.url}/v1/agents/builder`, {
    method: "PUT",
    headers: json,
    body: JSON.stringify({ requestId: "agent", manifest: agent.manifest, implementationVersion: "dev" }),
  });
  expect(put.ok, await put.clone().text()).toBe(true);
  const opened = await fetch(`${runtime.url}/v1/sessions/${id}`, {
    method: "PUT",
    headers: json,
    body: JSON.stringify({ requestId: `open-${id}`, agentId: "builder", ownerUserId: "ada", ...extra }),
  });
  expect(opened.ok, await opened.clone().text()).toBe(true);
}

async function items(runtime: Runtime, sessionId: string): Promise<Item[]> {
  const response = await fetch(`${runtime.url}/v1/sessions/${sessionId}/items`, { headers: auth });
  return ((await response.json()) as { items: Item[] }).items;
}

/** Sends a message and waits for its turn to complete. */
async function turn(runtime: Runtime, sessionId: string, key: string): Promise<void> {
  const sent = await fetch(`${runtime.url}/v1/sessions/${sessionId}/commands`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ type: "message", requestId: key, idempotencyKey: key, content: key }),
  });
  expect(sent.status, await sent.clone().text()).toBe(200);
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const history = await items(runtime, sessionId);
    const ended = history.filter((item) => item.type.startsWith("turn.") && item.type !== "turn.paused");
    const accepted = history.filter((item) => item.type === "command.message").length;
    if (ended.length === accepted) {
      expect(ended.at(-1)!.type).toBe("turn.completed");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the turn did not end");
}

/** Waits for the `count`-th event of `type`. */
async function eventually(runtime: Runtime, sessionId: string, type: string, count = 1): Promise<Item[]> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const found = (await items(runtime, sessionId)).filter((item) => item.type === type);
    if (found.length >= count) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`no ${count} ${type}`);
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** The files of a zip, read from its central directory, each checked against its CRC-32. */
function unzip(zip: Buffer): Map<string, string> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThan(0);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files = new Map<string, string>();
  for (let index = 0; index < count; index += 1) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const compressed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extra = zip.readUInt16LE(at + 30);
    const comment = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + compressed);
    const bytes = method === 8 ? inflateRawSync(data) : data;
    expect(bytes.length).toBe(size);
    expect(crc32(bytes)).toBe(crc);
    files.set(name, bytes.toString("utf8"));
    at += 46 + nameLength + extra + comment;
  }
  return files;
}

it("exports /workspace/outputs at turn end as a folder: tree, files with Range, diff, zip, links, dedupe", async () => {
  const puts: string[] = [];
  let store!: BlobStore;
  const runtime = await boot(
    turns([
      [
        bash(
          "mkdir -p outputs/app/src && printf '<h1>v1</h1>' > outputs/app/index.html && " +
            "printf 'body { color: red }' > outputs/app/src/style.css && printf '# Notes' > outputs/README.md && " +
            "printf 'scratch' > not-an-output.txt",
        ),
      ],
      [
        bash(
          "printf '<h1>v2</h1>' > outputs/app/index.html && printf 'run()' > outputs/app/new.js && rm outputs/README.md",
        ),
      ],
      [],
      [bash("printf 'more' > outputs/app/more.txt")],
    ]),
    {
      wrapBlobs: (blobs) => {
        store = blobs;
        return {
          ...blobs,
          kind: blobs.kind,
          put: (key, body, options) => {
            puts.push(key);
            return blobs.put(key, body, options);
          },
          get: (key, options) => blobs.get(key, options),
          head: (key) => blobs.head(key),
          delete: (key) => blobs.delete(key),
          list: (prefix) => blobs.list(prefix),
        };
      },
    },
  );
  await openSession(runtime, "s1", { sandbox: {} });

  await turn(runtime, "s1", "build");
  const [created] = await eventually(runtime, "s1", "artifact.created");
  expect(created!.payload).toMatchObject({
    kind: "folder",
    name: "outputs",
    version: 1,
    source: "export",
    claimed: true,
    fileCount: 3,
    size: "<h1>v1</h1>".length + "body { color: red }".length + "# Notes".length,
  });
  expect(created!.turnId).toEqual(expect.any(String));
  const id = created!.payload.artifactId as string;
  const base = `${runtime.url}/v1/artifacts/${id}/versions`;

  // The tree matches the workspace's outputs (and nothing outside them).
  const tree = (await (await fetch(`${base}/1/tree`, { headers: auth })).json()) as {
    entries: { path: string; size: number; sha256: string; contentType: string }[];
  };
  expect(tree.entries).toEqual([
    { path: "README.md", size: 7, sha256: sha("# Notes"), contentType: "text/markdown" },
    { path: "app/index.html", size: 11, sha256: sha("<h1>v1</h1>"), contentType: "text/html" },
    { path: "app/src/style.css", size: 19, sha256: sha("body { color: red }"), contentType: "text/css" },
  ]);
  const view = (await (await fetch(`${runtime.url}/v1/artifacts/${id}`, { headers: auth })).json()) as {
    kind: string;
    versions: { source: string }[];
  };
  expect(view).toMatchObject({ kind: "folder", versions: [{ source: "export" }] });

  // One file by path, whole and with Range; a folder has no content; a missing path is a 404.
  const style = `${base}/latest/files/${encodeURIComponent("app/src/style.css")}`;
  const whole = await fetch(style, { headers: auth });
  expect(whole.status).toBe(200);
  expect(whole.headers.get("content-type")).toBe("text/css");
  expect(await whole.text()).toBe("body { color: red }");
  const ranged = await fetch(style, { headers: { ...auth, range: "bytes=0-3" } });
  expect(ranged.status).toBe(206);
  expect(ranged.headers.get("content-range")).toBe("bytes 0-3/19");
  expect(await ranged.text()).toBe("body");
  expect((await fetch(`${base}/1/content`, { headers: auth })).status).toBe(400);
  expect((await fetch(`${base}/1/files/missing.txt`, { headers: auth })).status).toBe(404);

  // The zip holds every file.
  const zip = await fetch(`${base}/1/zip`, { headers: auth });
  expect(zip.status).toBe(200);
  expect(zip.headers.get("content-type")).toBe("application/zip");
  expect(unzip(Buffer.from(await zip.arrayBuffer()))).toEqual(
    new Map([
      ["README.md", "# Notes"],
      ["app/index.html", "<h1>v1</h1>"],
      ["app/src/style.css", "body { color: red }"],
    ]),
  );

  // A second turn changes, adds and removes files: version 2, and only new bytes are stored.
  const before = puts.length;
  await turn(runtime, "s1", "change");
  const [second] = await eventually(runtime, "s1", "artifact.version.created");
  expect(second!.payload).toMatchObject({ artifactId: id, version: 2, kind: "folder", fileCount: 3 });
  const contentPuts = puts.slice(before).filter((key) => key.startsWith("blobs/sha256/"));
  expect(contentPuts.sort()).toEqual(
    [`blobs/sha256/${sha("<h1>v2</h1>")}`, `blobs/sha256/${sha("run()")}`].sort(),
  );
  const diff = (await (await fetch(`${base}/2/diff?from=1`, { headers: auth })).json()) as {
    from: number;
    to: number;
    added: { path: string }[];
    removed: { path: string }[];
    changed: { path: string; from: { sha256: string }; to: { sha256: string } }[];
  };
  expect(diff).toMatchObject({ from: 1, to: 2 });
  expect(diff.added.map((entry) => entry.path)).toEqual(["app/new.js"]);
  expect(diff.removed.map((entry) => entry.path)).toEqual(["README.md"]);
  expect(diff.changed).toEqual([
    expect.objectContaining({
      path: "app/index.html",
      from: expect.objectContaining({ sha256: sha("<h1>v1</h1>") }),
      to: expect.objectContaining({ sha256: sha("<h1>v2</h1>") }),
    }),
  ]);
  // The default `from` is the version before.
  expect(((await (await fetch(`${base}/latest/diff`, { headers: auth })).json()) as { from: number }).from).toBe(1);

  // A turn that changes nothing adds no version; the next one that does is version 3.
  await turn(runtime, "s1", "idle");
  await turn(runtime, "s1", "more");
  const versions = await eventually(runtime, "s1", "artifact.version.created", 2);
  expect(versions.map((item) => item.payload.version)).toEqual([2, 3]);

  // Capability links: one file of the folder by path, or the whole folder as a zip.
  const client = createClient({ url: runtime.url, key: APP });
  const fileLink = await client.artifacts.link(id, { version: 2, file: "app/new.js" });
  expect(fileLink.file).toBe("app/new.js");
  const opened = await fetch(fileLink.url);
  expect(opened.status).toBe(200);
  expect(await opened.text()).toBe("run()");
  const zipLink = await client.artifacts.link(id, { version: 1 });
  expect(unzip(Buffer.from(await (await fetch(zipLink.url)).arrayBuffer())).get("README.md")).toBe("# Notes");
  await expect(client.artifacts.link(id, { file: "nope.txt" })).rejects.toMatchObject({ status: 404 });

  // Through the client: tree, file with Range, diff and zip.
  expect((await client.artifacts.tree(id, { version: 3 })).entries.map((entry) => entry.path)).toEqual([
    "app/index.html",
    "app/more.txt",
    "app/new.js",
    "app/src/style.css",
  ]);
  expect(await (await client.artifacts.file(id, "app/index.html", { range: { start: 4, end: 5 } })).text()).toBe(
    "v2",
  );
  expect((await client.artifacts.diff(id, { version: 3, from: 2 })).added.map((entry) => entry.path)).toEqual([
    "app/more.txt",
  ]);
  expect(unzip(Buffer.from(await (await client.artifacts.zip(id)).arrayBuffer())).size).toBe(4);

  // The Tenant total counts each stored file once.
  const usage = (await (await fetch(`${runtime.url}/v1/tenant/artifacts`, { headers: runtime.managementHeaders() })).json()) as {
    usedBytes: number;
  };
  expect(usage.usedBytes).toBe(
    ["# Notes", "<h1>v1</h1>", "body { color: red }", "<h1>v2</h1>", "run()", "more"].reduce(
      (sum, text) => sum + text.length,
      0,
    ),
  );

  // Deleting the folder removes its manifests and the files nothing else names.
  expect((await fetch(`${runtime.url}/v1/artifacts/${id}`, { method: "DELETE", headers: auth })).status).toBe(200);
  expect(await store.head(`blobs/sha256/${sha("body { color: red }")}`)).toBeUndefined();
  const left: string[] = [];
  for await (const entry of store.list("")) left.push(entry.key);
  expect(left).toEqual([]);
});

it("exports nothing without a sandbox, or with no outputs in it", async () => {
  const runtime = await boot(turns([[bash("printf 'x' > notes.txt")], [], [], []]));
  await openSession(runtime, "boxed", { sandbox: {} });
  await openSession(runtime, "plain");
  // The second turn of each starts only once the first's advance (and its export) has ended.
  await turn(runtime, "boxed", "one");
  await turn(runtime, "boxed", "two");
  await turn(runtime, "plain", "one");
  await turn(runtime, "plain", "two");
  for (const id of ["boxed", "plain"]) {
    const listed = (await (
      await fetch(`${runtime.url}/v1/artifacts?sessionId=${id}`, { headers: auth })
    ).json()) as { artifacts: unknown[] };
    expect(listed.artifacts).toEqual([]);
    expect((await items(runtime, id)).filter((item) => item.type.startsWith("artifact."))).toEqual([]);
  }
});

it("skips an export past the per-file limit with artifact.export.skipped, and the turn still completes", async () => {
  const runtime = await boot(turns([[bash("mkdir -p outputs && printf '0123456789abcdef' > outputs/big.bin")]]));
  const limits = await fetch(`${runtime.url}/v1/tenant/artifacts`, {
    method: "PUT",
    headers: runtime.managementHeaders(),
    body: JSON.stringify({ limits: { fileBytes: 8 } }),
  });
  expect(limits.status, await limits.clone().text()).toBe(200);
  await openSession(runtime, "s1", { sandbox: {} });
  await turn(runtime, "s1", "build");
  const [skipped] = await eventually(runtime, "s1", "artifact.export.skipped");
  expect(skipped!.payload).toMatchObject({ name: "outputs", reason: "file_too_large", limit: 8, path: "big.bin" });
  const listed = (await (await fetch(`${runtime.url}/v1/artifacts?sessionId=s1`, { headers: auth })).json()) as {
    artifacts: unknown[];
  };
  expect(listed.artifacts).toEqual([]);
});

it("exports the outputs of a sandbox a harness holds over WebSocket (F6.2)", async () => {
  const runtime = await boot(
    turns([[bash("mkdir -p outputs/site && printf '<p>hi</p>' > outputs/site/index.html && printf 'x' > scratch.txt")]]),
    { harness: "ws" },
  );
  await openSession(runtime, "s1", { sandbox: {} });
  await turn(runtime, "s1", "build");
  const [created] = await eventually(runtime, "s1", "artifact.created");
  expect(created!.payload).toMatchObject({ kind: "folder", name: "outputs", version: 1, source: "export", fileCount: 1 });
  const tree = (await (
    await fetch(`${runtime.url}/v1/artifacts/${created!.payload.artifactId}/versions/1/tree`, { headers: auth })
  ).json()) as { entries: { path: string; sha256: string }[] };
  expect(tree.entries.map(({ path, sha256 }) => ({ path, sha256 }))).toEqual([
    { path: "site/index.html", sha256: sha("<p>hi</p>") },
  ]);
  // The workspace is the harness's: its compute record is in the harness's file, mirrored by core.
  const status = (await (await fetch(`${runtime.url}/v1/tenant`, { headers: runtime.managementHeaders() })).json()) as {
    harness: { mode: string; workspace: boolean };
  };
  expect(status.harness).toMatchObject({ mode: "remote", workspace: true });
});
