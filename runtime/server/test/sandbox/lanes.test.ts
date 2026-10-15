/**
 * Calls of several sessions on one workspace (D66): each session's calls run in the order it sends
 * them, different sessions' calls run at the same time, a cancel ends only its own call, a stop or
 * removal waits for the calls running, and each version of a skill gets its own folder.
 */
import { expect, it } from "vitest";
import { runtimeManifestFor, skillFolderOf, type AgentManifest } from "@nylorun/core/define";
import { SandboxManager, sandboxToolSpec, type SandboxSessionRef } from "../../src/sandbox/manager.js";
import { storeSandboxRecords } from "../../src/sandbox/records.js";
import { wholeBytes, type SandboxBackend, type SandboxHandle } from "../../src/sandbox/types.js";
import { createTestSessionStore } from "../support/store.js";

const SKILL_V1 = `sha256:${"1".repeat(64)}`;
const SKILL_V2 = `sha256:${"2".repeat(64)}`;

function manifestWith(files?: Record<string, string>): AgentManifest {
  const skills = files ? { notes: { name: "notes", description: "Notes.", files } } : undefined;
  return {
    manifestSchemaVersion: 7,
    id: "bot",
    ...(skills ? { skills } : {}),
    runtime: runtimeManifestFor(skills ? { skills } : {}, { sandbox: { idle: "1m" } }),
  };
}

/** A backend whose `wait <name>` commands run until `release(name)`, or until cancelled. */
function gatedBackend() {
  const files = new Map<string, string | Uint8Array>();
  const writes: string[] = [];
  const gates = new Map<string, () => void>();
  const started: string[] = [];
  const finished: string[] = [];
  let opens = 0;
  let stops = 0;
  const handle: SandboxHandle = {
    async exec(request, signal) {
      started.push(request.command);
      const waiting = /^wait (\S+)$/.exec(request.command);
      if (waiting)
        await new Promise<void>((resolve, reject) => {
          gates.set(waiting[1]!, resolve);
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        });
      finished.push(request.command);
      return { exitCode: 0, stdout: request.command, stderr: "", killed: false, timedOut: false };
    },
    readFile: async (path) => {
      const value = files.get(path);
      return typeof value === "string" ? value : undefined;
    },
    writeFile: async (path, content) => {
      writes.push(path);
      files.set(path, typeof content === "string" ? content : await wholeBytes(content));
    },
    stop: async () => {
      stops += 1;
    },
  };
  const backend = {
    name: "virtual",
    isolation: "process",
    probe: async () => ({ name: "virtual", isolation: "process", available: true, reason: "test" }),
    unmet: () => undefined,
    open: async () => {
      opens += 1;
      return handle;
    },
    remove: async () => {},
    list: async () => [],
  } as unknown as SandboxBackend;
  return {
    backend,
    files,
    writes,
    started,
    finished,
    release: (name: string) => gates.get(name)?.(),
    opens: () => opens,
    stops: () => stops,
  };
}

async function setup() {
  const fake = gatedBackend();
  const store = await createTestSessionStore();
  const manager = new SandboxManager({
    scope: "tn_lanes",
    records: storeSandboxRecords(store),
    backends: [fake.backend],
    preference: "virtual",
    ephemeral: false,
    emit: () => undefined,
    definitionFile: async (sha256) => new TextEncoder().encode(`# ${sha256}\n`),
  });
  const session = (id: string, manifest = manifestWith()): SandboxSessionRef => ({
    id,
    activeTurnId: `${id}-turn`,
    manifest,
    environmentId: "team/ws",
  });
  const bash = (ref: SandboxSessionRef, command: string, signal = new AbortController().signal) =>
    manager.run(ref, sandboxToolSpec(ref.manifest!, "bash"), "bash", { command }, signal);
  return { ...fake, store, manager, session, bash };
}

async function until(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 250 && !done(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(done()).toBe(true);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

it("runs two sessions' calls on one workspace at once, and each session's in order", async () => {
  const { manager, session, bash, started, finished, release, opens } = await setup();
  const a = session("a");
  const b = session("b");
  const first = bash(a, "wait a");
  await until(() => started.includes("wait a"));
  // Another session's call runs while a's is still running.
  expect(await bash(b, "echo b")).toMatchObject({ kind: "completed" });
  // a's next call waits for its first.
  const second = bash(a, "echo a2");
  await tick();
  expect(started).not.toContain("echo a2");
  release("a");
  expect(await first).toMatchObject({ kind: "completed" });
  expect(await second).toMatchObject({ kind: "completed" });
  expect(finished.filter((command) => command.startsWith("echo") || command.startsWith("wait"))).toEqual([
    "echo b",
    "wait a",
    "echo a2",
  ]);
  // One open, shared.
  expect(opens()).toBe(1);
  await manager.close();
});

it("ends only the cancelled session's call", async () => {
  const { manager, session, bash, started, release } = await setup();
  const cancel = new AbortController();
  const a = bash(session("a"), "wait a", cancel.signal);
  const b = bash(session("b"), "wait b");
  await until(() => started.includes("wait a") && started.includes("wait b"));
  cancel.abort();
  await expect(a).rejects.toThrow();
  let done = false;
  void b.then(() => (done = true));
  await tick();
  expect(done).toBe(false);
  release("b");
  expect(await b).toMatchObject({ kind: "completed" });
  await manager.close();
});

it("stops or removes a workspace only after the calls running end", async () => {
  const { manager, session, bash, started, release, stops, opens } = await setup();
  const a = session("a");
  const running = bash(a, "wait a");
  await until(() => started.includes("wait a"));
  // Idle is never true with a call running.
  await manager.stopIdle(Date.now() + 3_600_000);
  expect(stops()).toBe(0);
  release("a");
  await running;
  await manager.stopIdle(Date.now() + 3_600_000);
  expect(stops()).toBe(1);
  // The next call opens it again.
  expect(await bash(a, "echo again")).toMatchObject({ kind: "completed" });
  expect(opens()).toBe(2);

  const held = bash(session("b"), "wait b");
  await until(() => started.includes("wait b"));
  let removed = false;
  const removing = manager.remove(manager.sandboxKeyOf("team/ws")).then(() => (removed = true));
  await tick();
  expect(removed).toBe(false);
  release("b");
  await held;
  await removing;
  expect(removed).toBe(true);
  await manager.close();
});

it("mounts each version of a skill in its own folder, once", async () => {
  const { manager, session, bash, writes } = await setup();
  const v1 = manifestWith({ "SKILL.md": SKILL_V1 });
  const v2 = manifestWith({ "SKILL.md": SKILL_V2 });
  const folder1 = skillFolderOf(v1.skills!.notes!);
  const folder2 = skillFolderOf(v2.skills!.notes!);
  expect(folder1).not.toBe(folder2);
  await Promise.all([bash(session("a", v1), "echo a"), bash(session("b", v2), "echo b")]);
  expect(writes.filter((path) => path === `${folder1}/SKILL.md`)).toHaveLength(1);
  expect(writes.filter((path) => path === `${folder2}/SKILL.md`)).toHaveLength(1);
  // A third session with the first version finds it mounted.
  await bash(session("c", v1), "echo c");
  expect(writes.filter((path) => path.startsWith("/skills/"))).toHaveLength(2);
  await manager.close();
});

it("writes a file's bytes as they come, in its session's lane, making its folder first", async () => {
  const { manager, session, bash, files, started, release } = await setup();
  const a = session("a");
  const running = bash(a, "wait a");
  await until(() => started.includes("wait a"));
  async function* chunks() {
    yield new Uint8Array([1, 2]);
    yield new Uint8Array([3]);
  }
  const spec = sandboxToolSpec(a.manifest!, "bash");
  const written = manager.writeBytes(a, spec, "in/data.bin", chunks(), new AbortController().signal);
  await tick();
  // After the session's call before it (protocol 15: our engine's read_artifact with path).
  expect(started.some((command) => command.startsWith("mkdir -p"))).toBe(false);
  release("a");
  await running;
  expect(await written).toEqual({ kind: "written", path: "/workspace/in/data.bin", size: 3 });
  expect(started).toContain("mkdir -p '/workspace/in'");
  expect([...(files.get("/workspace/in/data.bin") as Uint8Array)]).toEqual([1, 2, 3]);
  await manager.close();
});
