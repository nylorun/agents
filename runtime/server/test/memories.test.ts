/**
 * Agent memory (track T5, D72), storage and the Runtime API: memories are rows the Agent owns,
 * with a version per change. The memory service applies Anthropic's memory tool commands
 * (`create`, `str_replace`, `insert`, `delete`, `rename`) with their result strings, within the
 * Runtime limits; the routes list, read, write whole (with a `content_sha256` precondition),
 * delete, and page versions; a fork copies the memories with no history, and a delete removes
 * them. `harness.memory` is accepted by the manifest schema.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import { PROTOCOL_HEADER } from "@nylorun/core/compatibility";
import { RUNTIME_LIMIT_DEFAULTS, memoryDescriptionOf, memoryPathOf } from "@nylorun/core/contracts";
import { applyMemoryCommand, sha256, viewMemory, type MemoryCommand } from "../src/memory/service.js";
import { startTestTenant } from "./support/tenant.js";
import { deploy, manifestOf, writeManifest } from "./support/agents.js";
import { setLimits } from "./support/limits.js";
import { withTestSessionStore } from "./support/store.js";

const APP = "memories-app-key-aaaaaaaaaaaaaaaaaa";
const headers = { authorization: `Bearer ${APP}`, "content-type": "application/json", [PROTOCOL_HEADER]: "17" };
const bot = Agent({ id: "keeper", name: "Keeper" }).instructions("Remember things.").build();
const author = { actor: "agent:keeper@1", sessionId: "s1", turnId: "t1", triggerRunId: "run_1" };

let runtime: Awaited<ReturnType<typeof startTestTenant>>;

beforeAll(async () => {
  runtime = await startTestTenant({ applicationKey: APP, vaultKek: null });
  await deploy(runtime.url, headers, bot, { name: "keeper", memory: { access: "read_write", instructions: "Keep conventions." } });
});

afterAll(async () => {
  await runtime?.close();
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${runtime.url}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

const enc = (path: string) => encodeURIComponent(path);

/** Applies one command to Agent `agentId`'s memories as a turn would. */
async function apply(agentId: string, command: MemoryCommand) {
  return withTestSessionStore(runtime, (store) =>
    store.tx((t) => applyMemoryCommand(t, agentId, command, author, RUNTIME_LIMIT_DEFAULTS)),
  );
}

async function view(agentId: string, path: string, range?: [number, number]) {
  return withTestSessionStore(runtime, (store) => store.tx((t) => viewMemory(t, agentId, path, range)));
}

describe("memory paths", () => {
  it("are Markdown files under /memories with no empty, . or .. segment", () => {
    expect(memoryPathOf("/memories/a/b.md", "file")).toEqual({ path: "/memories/a/b.md" });
    expect(memoryPathOf("memories/a.md", "file")).toEqual({ path: "/memories/a.md" });
    expect(memoryPathOf("/memories/a/", "any")).toEqual({ path: "/memories/a" });
    expect(memoryPathOf("/memories", "any")).toEqual({ path: "/memories" });
    for (const bad of ["/etc/passwd", "/memories/../x.md", "/memories//x.md", "/memories/a.txt", "/memories", "/memories/a\\b.md"])
      expect(memoryPathOf(bad, "file")).toHaveProperty("error");
    expect(memoryPathOf(`/memories/${"a".repeat(600)}.md`, "file")).toHaveProperty("error");
  });

  it("show their frontmatter description in the index, when they have one", () => {
    expect(memoryDescriptionOf("---\ntype: Convention\ndescription: Release branches\n---\nbody")).toBe("Release branches");
    expect(memoryDescriptionOf('---\ndescription: "quoted"\n---\n')).toBe("quoted");
    expect(memoryDescriptionOf("no frontmatter\ndescription: nope")).toBeNull();
  });
});

describe("the memory service", () => {
  it("creates a memory with a version naming who wrote it, and views it with line numbers", async () => {
    const created = await apply("keeper", { command: "create", path: "/memories/notes/a.md", fileText: "one\ntwo\nthree" });
    expect(created).toEqual({
      ok: true,
      text: "File created successfully at: /memories/notes/a.md",
      changes: [{ path: "/memories/notes/a.md", operation: "create", version: 1 }],
    });
    expect((await view("keeper", "/memories/notes/a.md")).text).toBe(
      "Here's the content of /memories/notes/a.md with line numbers:\n     1\tone\n     2\ttwo\n     3\tthree",
    );
    expect((await view("keeper", "/memories/notes/a.md", [2, -1])).text).toContain("     2\ttwo\n     3\tthree");
    const versions = (await call("GET", `/v1/agents/keeper/memory_versions?path=${enc("notes/a.md")}`)).body.versions;
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      operation: "create",
      actor: "agent:keeper@1",
      sessionId: "s1",
      turnId: "t1",
      triggerRunId: "run_1",
      contentSha256: sha256("one\ntwo\nthree"),
    });
  });

  it("makes no version for a create that changes nothing", async () => {
    const same = await apply("keeper", { command: "create", path: "/memories/notes/a.md", fileText: "one\ntwo\nthree" });
    expect(same).toMatchObject({ ok: true, changes: [] });
  });

  it("replaces text that appears exactly once, and refuses none or several", async () => {
    expect(await apply("keeper", { command: "str_replace", path: "/memories/notes/a.md", oldStr: "two", newStr: "TWO" })).toMatchObject({
      ok: true,
      changes: [{ operation: "str_replace", version: 2 }],
    });
    expect(await apply("keeper", { command: "str_replace", path: "/memories/notes/a.md", oldStr: "zzz" })).toEqual({
      ok: false,
      code: "memory.no_match",
      text: "No replacement was performed, old_str `zzz` did not appear verbatim in /memories/notes/a.md.",
    });
    await apply("keeper", { command: "create", path: "/memories/notes/dup.md", fileText: "x\nx" });
    expect(await apply("keeper", { command: "str_replace", path: "/memories/notes/dup.md", oldStr: "x" })).toEqual({
      ok: false,
      code: "memory.not_unique",
      text: "No replacement was performed. Multiple occurrences of old_str `x` in lines: 1, 2. Please ensure it is unique",
    });
    expect(await apply("keeper", { command: "str_replace", path: "/memories/notes/none.md", oldStr: "x" })).toMatchObject({
      ok: false,
      code: "memory.not_found",
    });
  });

  it("inserts after a line, within the file's lines", async () => {
    expect(await apply("keeper", { command: "insert", path: "/memories/notes/a.md", insertLine: 0, insertText: "zero" })).toMatchObject({
      ok: true,
      text: "The file /memories/notes/a.md has been edited.",
    });
    expect((await call("GET", `/v1/agents/keeper/memories/${enc("notes/a.md")}`)).body.content).toBe("zero\none\nTWO\nthree");
    expect(await apply("keeper", { command: "insert", path: "/memories/notes/a.md", insertLine: 99, insertText: "x" })).toMatchObject({
      ok: false,
      code: "memory.invalid_line",
    });
  });

  it("renames a memory, never onto an existing path, and keeps its content", async () => {
    await apply("keeper", { command: "create", path: "/memories/notes/b.md", fileText: "b" });
    expect(await apply("keeper", { command: "rename", oldPath: "/memories/notes/b.md", newPath: "/memories/notes/a.md" })).toEqual({
      ok: false,
      code: "memory.exists",
      text: "The destination /memories/notes/a.md already exists",
    });
    expect(await apply("keeper", { command: "rename", oldPath: "/memories/notes/b.md", newPath: "/memories/kept/b.md" })).toMatchObject({
      ok: true,
      text: "Successfully renamed /memories/notes/b.md to /memories/kept/b.md",
      changes: [{ path: "/memories/kept/b.md", operation: "rename", version: 1 }],
    });
    const renamed = (await call("GET", `/v1/agents/keeper/memory_versions?path=${enc("kept/b.md")}`)).body.versions[0];
    expect(renamed).toMatchObject({ operation: "rename", fromPath: "/memories/notes/b.md" });
    expect((await call("GET", `/v1/agents/keeper/memories/${enc("notes/b.md")}`)).status).toBe(404);
  });

  it("renames and deletes a folder of memories", async () => {
    await apply("keeper", { command: "create", path: "/memories/tmp/x.md", fileText: "x" });
    await apply("keeper", { command: "create", path: "/memories/tmp/deep/y.md", fileText: "y" });
    expect(await apply("keeper", { command: "rename", oldPath: "/memories/tmp", newPath: "/memories/moved" })).toMatchObject({
      ok: true,
      changes: [
        { path: "/memories/moved/deep/y.md", operation: "rename" },
        { path: "/memories/moved/x.md", operation: "rename" },
      ],
    });
    expect(await apply("keeper", { command: "delete", path: "/memories/moved" })).toMatchObject({
      ok: true,
      text: "Successfully deleted /memories/moved",
      changes: [{ operation: "delete" }, { operation: "delete" }],
    });
    expect(await apply("keeper", { command: "delete", path: "/memories/moved" })).toMatchObject({ ok: false, code: "memory.not_found" });
    expect(await apply("keeper", { command: "delete", path: "/memories" })).toMatchObject({ ok: false, code: "memory.path_invalid" });
  });

  it("lists folders two levels deep with their sizes", async () => {
    const listing = (await view("keeper", "/memories")).text;
    expect(listing.split("\n")[0]).toBe(
      "Here're the files and directories up to 2 levels deep in /memories, excluding hidden items and node_modules:",
    );
    expect(listing).toContain("\t/memories/notes\n");
    expect(listing).toContain("\t/memories/notes/a.md");
    expect((await view("keeper", "/memories/nothing")).ok).toBe(false);
  });

  it("refuses paths outside /memories, and holds the Runtime limits", async () => {
    expect(await apply("keeper", { command: "create", path: "/etc/x.md", fileText: "x" })).toMatchObject({ code: "memory.path_invalid" });
    expect(await apply("keeper", { command: "create", path: "/memories/x.txt", fileText: "x" })).toMatchObject({ code: "memory.path_invalid" });
    const limits = { ...RUNTIME_LIMIT_DEFAULTS, memoryBytes: 10, memoriesPerAgent: 1 };
    const big = await withTestSessionStore(runtime, (store) =>
      store.tx((t) => applyMemoryCommand(t, "keeper", { command: "create", path: "/memories/big.md", fileText: "0123456789A" }, author, limits)),
    );
    expect(big).toMatchObject({ ok: false, code: "memory.too_large" });
    const many = await withTestSessionStore(runtime, (store) =>
      store.tx((t) => applyMemoryCommand(t, "keeper", { command: "create", path: "/memories/new.md", fileText: "x" }, author, limits)),
    );
    expect(many).toMatchObject({ ok: false, code: "memory.limit" });
  });
});

describe("the memory routes", () => {
  it("list memories by path with their description and version", async () => {
    await call("PUT", `/v1/agents/keeper/memories/${enc("conventions/release.md")}`, {
      content: "---\ntype: Convention\ndescription: Release branches\n---\nCut from release/x.y.",
    });
    const list = (await call("GET", "/v1/agents/keeper/memories?pathPrefix=conventions")).body;
    expect(list).toEqual({
      memories: [
        {
          path: "/memories/conventions/release.md",
          bytes: expect.any(Number),
          contentSha256: expect.any(String),
          description: "Release branches",
          version: 1,
          updatedAt: expect.any(String),
        },
      ],
      nextCursor: null,
    });
    const page = (await call("GET", "/v1/agents/keeper/memories?limit=1")).body;
    expect(page.memories).toHaveLength(1);
    expect(page.nextCursor).toBe(page.memories[0].path);
  });

  it("write a memory whole with the caller as actor, and hold a content_sha256 precondition", async () => {
    const path = `/v1/agents/keeper/memories/${enc("prefs/tone.md")}`;
    expect((await call("PUT", path, { content: "short", contentSha256: "" })).status).toBe(200);
    const conflict = await call("PUT", path, { content: "long", contentSha256: "" });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("memory_conflict");
    expect(conflict.body.details.current.content).toBe("short");
    const ok = await call("PUT", path, { content: "direct", contentSha256: sha256("short") });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ path: "/memories/prefs/tone.md", content: "direct", version: 2 });
    const [latest] = (await call("GET", `/v1/agents/keeper/memory_versions?path=${enc("prefs/tone.md")}`)).body.versions;
    expect(latest).toMatchObject({ operation: "create", actor: "application", sessionId: null });
    const detail = await call("GET", `/v1/agents/keeper/memory_versions/${latest.id}`);
    expect(detail.body.content).toBe("direct");
  });

  it("refuse a path that is not a Markdown file, and a memory over memoryBytes", async () => {
    expect((await call("PUT", `/v1/agents/keeper/memories/${enc("x.txt")}`, { content: "x" })).status).toBe(400);
    await withTestSessionStore(runtime, (store) => setLimits(store, { memoryBytes: 16 }));
    try {
      expect((await call("PUT", `/v1/agents/keeper/memories/${enc("big.md")}`, { content: "x".repeat(17) })).status).toBe(413);
    } finally {
      await withTestSessionStore(runtime, (store) => setLimits(store, { memoryBytes: RUNTIME_LIMIT_DEFAULTS.memoryBytes }));
    }
  });

  it("delete a memory, and answer 404 for one that is not there", async () => {
    const path = `/v1/agents/keeper/memories/${enc("prefs/tone.md")}`;
    expect((await call("DELETE", path)).body).toEqual({ path: "/memories/prefs/tone.md", deleted: 1 });
    expect((await call("GET", path)).status).toBe(404);
    expect((await call("DELETE", path)).status).toBe(404);
    const versions = (await call("GET", `/v1/agents/keeper/memory_versions?path=${enc("prefs/tone.md")}`)).body.versions;
    expect(versions[0]).toMatchObject({ operation: "delete", contentSha256: null });
  });

  it("answer 404 for an Agent that does not exist", async () => {
    expect((await call("GET", "/v1/agents/nobody/memories")).status).toBe(404);
  });
});

describe("memory and the Agent's lifecycle", () => {
  it("a fork copies the memories at version 1 with no history; a delete removes them", async () => {
    const fork = await call("POST", "/v1/agents/keeper/fork", { id: "keeper-copy" });
    expect(fork.status, JSON.stringify(fork.body)).toBe(201);
    const source = (await call("GET", "/v1/agents/keeper/memories")).body.memories;
    expect(fork.body.plan.memories).toBe(source.length);
    const copied = (await call("GET", "/v1/agents/keeper-copy/memories")).body.memories;
    expect(copied.map((m: any) => [m.path, m.version])).toEqual(source.map((m: any) => [m.path, 1]));
    expect((await call("GET", "/v1/agents/keeper-copy/memory_versions")).body.versions).toEqual([]);
    expect((await call("DELETE", "/v1/agents/keeper-copy")).status).toBe(200);
    const rows = await withTestSessionStore(runtime, (store) =>
      store.tx(async (t) => [await t.countMemories("keeper-copy"), (await t.memoryVersions("keeper-copy", { limit: 1 })).length]),
    );
    expect(rows).toEqual([0, 0]);
  });
});

describe("harness.memory", () => {
  it("is part of the agent manifest; a bad access or long instructions is refused", async () => {
    const good = manifestOf(bot, { name: "mem-ok", memory: { access: "read_only" } });
    expect((await writeManifest(runtime.url, headers, good)).status).toBe(200);
    const bad = manifestOf(bot, { name: "mem-bad", memory: { access: "write" as never } });
    expect((await writeManifest(runtime.url, headers, bad)).status).toBe(400);
    const long = manifestOf(bot, { name: "mem-long", memory: { instructions: "x".repeat(4097) } });
    expect((await writeManifest(runtime.url, headers, long)).status).toBe(400);
  });
});
