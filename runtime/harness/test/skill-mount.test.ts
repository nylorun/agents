/**
 * Our engine decides where and when skills' files are in the sandbox (protocol 15): before each
 * `sandbox` call it mounts each skill version of the turn's tree at its folder, reading the bytes
 * over `definition.file`; the host only writes them. A folder the sandbox holds answers
 * `present`; one that cannot be put there is the call's failed outcome, and the call never runs.
 */
import { describe, expect, it } from "vitest";
import { skillFolderOf, type AgentManifest } from "@nylorun/core/define";
import {
  RUNTIME_LIMIT_DEFAULTS,
  fromBase64,
  toBase64,
  type HarnessChannel,
} from "@nylorun/core/harness-api";
import { engineConfig } from "./fixtures.js";
import { apiHost } from "../src/api/host.js";
import type { HarnessExecutors, HarnessFiles, HarnessRun } from "../src/api/executors.js";
import type { HostEffect } from "../src/run/durable.js";
import { definitionFileChunks, sandboxSkillsOf } from "../src/tools/skills.js";

const SKILL = `sha256:${"a".repeat(64)}`;
const SCRIPT = `sha256:${"b".repeat(64)}`;
const CHILD = `sha256:${"c".repeat(64)}`;
const BYTES: Record<string, string> = {
  [SKILL]: "# Notes\nUse it.",
  [SCRIPT]: "echo hi",
  [CHILD]: "# Child",
};

const notes = {
  name: "notes",
  description: "Notes.",
  files: { "SKILL.md": SKILL, "run.sh": SCRIPT },
};
const child = { name: "child", description: "Child.", files: { "SKILL.md": CHILD } };
const manifest = {
  manifestSchemaVersion: 7,
  id: "bot",
  skills: { notes },
  tools: [
    {
      name: "helper",
      agent: { manifestSchemaVersion: 7, id: "helper", skills: { child, notes } },
    },
  ],
} as unknown as AgentManifest;

const call = (name: string, target: HostEffect["target"]) =>
  ({
    kind: "tool",
    effectId: `t1:0:tool:${name}`,
    sessionId: "s1",
    turnId: "t1",
    agentId: "bot",
    manifestHash: "h",
    toolName: name,
    target,
    input: { command: "ls /skills" },
    context: { callId: name, invocationId: "inv-1" },
  }) as unknown as HostEffect;

function setup(options: { chunkBytes?: number; fail?: boolean } = {}) {
  const fetched: { sha256: string; offset: number; length: number }[] = [];
  const channel = {
    async request(method: string, params: Record<string, unknown>) {
      if (method === "effect.intent") return { status: "execute" };
      if (method === "effect.outcome")
        return { status: "completed", outcome: { value: params.value } };
      if (method === "definition.file") {
        const { sha256, offset, length } = params as {
          sha256: string;
          offset: number;
          length: number;
        };
        fetched.push({ sha256, offset, length });
        const bytes = new TextEncoder().encode(BYTES[sha256]!);
        return { base64: toBase64(bytes.subarray(offset, offset + length)) };
      }
      throw new Error(`unexpected ${method}`);
    },
  } as unknown as HarnessChannel;
  const held = new Set<string>();
  const mounts: { folder: string; files: Record<string, string>; bytes: Record<string, string> }[] =
    [];
  const order: string[] = [];
  const files: HarnessFiles = {
    read: async () => ({ kind: "failed", code: "unused", message: "unused" }),
    write: async () => ({ kind: "failed", code: "unused", message: "unused" }),
    list: async () => ({ kind: "missing" }),
    async mount(_run, folder, mounted, read) {
      order.push(`mount ${folder}`);
      if (options.fail)
        return {
          kind: "failed",
          code: "sandbox.skills_unavailable",
          message: `${folder} is read-only`,
        };
      if (held.has(folder)) return { kind: "present" };
      const bytes: Record<string, string> = {};
      for (const [path, sha256] of Object.entries(mounted)) {
        const chunks: Uint8Array[] = [];
        for await (const chunk of read(sha256)) chunks.push(chunk);
        bytes[path] = Buffer.concat(chunks).toString();
      }
      held.add(folder);
      mounts.push({ folder, files: { ...mounted }, bytes });
      return { kind: "mounted" };
    },
  };
  const executors: HarnessExecutors = {
    model: async () => ({}),
    async tool(effect) {
      order.push(`run ${effect.toolName}`);
      return { kind: "completed", output: "ok" };
    },
    recovers: { model: false, tool: () => false },
    files,
  };
  const run: HarnessRun = {
    runId: "r1",
    grant: {} as HarnessRun["grant"],
    start: {
      outcomes: [],
      manifest,
      limits: {
        ...RUNTIME_LIMIT_DEFAULTS,
        ...(options.chunkBytes ? { chunkBytes: options.chunkBytes } : {}),
      },
    } as unknown as HarnessRun["start"],
    signal: new AbortController().signal,
  };
  return {
    host: apiHost(channel, executors, run, engineConfig()),
    mounts,
    order,
    held,
    fetched,
    channel,
    run,
  };
}

describe("skill folders", () => {
  it("are each skill version of the tree, once", () => {
    expect([...sandboxSkillsOf(manifest).keys()]).toEqual([
      skillFolderOf(notes),
      skillFolderOf(child),
    ]);
  });

  it("are mounted before each sandbox call, then present", async () => {
    const h = setup();
    expect(await h.host.resolveEffect(call("bash", { kind: "sandbox" }))).toMatchObject({
      status: "completed",
    });
    expect(h.order).toEqual([
      `mount ${skillFolderOf(notes)}`,
      `mount ${skillFolderOf(child)}`,
      "run bash",
    ]);
    expect(h.mounts.map((m) => m.folder)).toEqual([skillFolderOf(notes), skillFolderOf(child)]);
    expect(h.mounts[0]!.bytes).toEqual({ "SKILL.md": BYTES[SKILL], "run.sh": BYTES[SCRIPT] });
    h.order.length = 0;
    await h.host.resolveEffect({
      ...call("read", { kind: "sandbox" }),
      effectId: "t1:0:tool:read2",
    });
    // The host answers present: nothing is written again.
    expect(h.order).toEqual([
      `mount ${skillFolderOf(notes)}`,
      `mount ${skillFolderOf(child)}`,
      "run read",
    ]);
    expect(h.mounts).toHaveLength(2);
  });

  it("are mounted again once the sandbox no longer holds them (a reopen)", async () => {
    const h = setup();
    await h.host.resolveEffect(call("bash", { kind: "sandbox" }));
    h.held.clear();
    await h.host.resolveEffect({
      ...call("bash", { kind: "sandbox" }),
      effectId: "t1:0:tool:bash2",
    });
    expect(h.mounts).toHaveLength(4);
  });

  it("are not mounted for a call that is not a sandbox call", async () => {
    const h = setup();
    await h.host.resolveEffect(call("lookup", { kind: "http", tool: "lookup" }));
    expect(h.order).toEqual(["run lookup"]);
  });

  it("fail the sandbox call when one cannot be mounted, and the call never runs", async () => {
    const h = setup({ fail: true });
    expect(await h.host.resolveEffect(call("bash", { kind: "sandbox" }))).toEqual({
      status: "completed",
      outcome: {
        value: {
          kind: "failed",
          code: "sandbox.skills_unavailable",
          message: `${skillFolderOf(notes)} is read-only`,
        },
      },
    });
    expect(h.order).toEqual([`mount ${skillFolderOf(notes)}`]);
  });

  it("read their bytes over definition.file a chunk at a time", async () => {
    const h = setup({ chunkBytes: 4 });
    const chunks: Uint8Array[] = [];
    for await (const chunk of definitionFileChunks(h.channel, h.run, SKILL, h.run.signal))
      chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe(BYTES[SKILL]);
    expect(h.fetched.map((f) => f.offset)).toEqual([0, 4, 8, 12]);
    expect(h.fetched.every((f) => f.length === 4)).toBe(true);
    expect(fromBase64(toBase64(new Uint8Array()))).toHaveLength(0);
  });
});
