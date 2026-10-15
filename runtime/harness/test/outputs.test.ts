/**
 * Our engine's outputs folder (protocol 15, Q5): at a completed turn's end it saves the sandbox's
 * outputs directory as a version of the session's `outputs` folder over the artifact seam, and
 * claims why when it stores nothing. It never fails the turn.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RUNTIME_LIMIT_DEFAULTS, fromBase64, type HarnessChannel } from "@nylorun/core/harness-api";
import type { HarnessFiles, HarnessRun } from "../src/api/executors.js";
import { DEFAULT_OUTPUTS_CONFIG, outputsConfigOf, saveOutputs } from "../src/tools/outputs.js";

const text = (value: string) => new TextEncoder().encode(value);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

interface Seam {
  begin?: (params: Record<string, unknown>) => unknown;
  commit?: () => unknown;
}

function setup(
  tree: Record<string, string> | "missing" | { failed: string },
  options: {
    limits?: Partial<typeof RUNTIME_LIMIT_DEFAULTS>;
    seam?: Seam;
    truncated?: boolean;
  } = {},
) {
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const received = new Map<string, Uint8Array[]>();
  const channel = {
    async request(method: string, params: Record<string, unknown>) {
      requests.push({ method, params });
      if (method === "event") return {};
      if (method !== "artifact.write") throw new Error(`unexpected ${method}`);
      switch (params.op) {
        case "begin":
          return (
            options.seam?.begin?.(params) ?? {
              status: "open",
              uploadId: "u1",
              maxBytes: 1_000_000,
              maxFileBytes: 100_000,
              maxEntries: RUNTIME_LIMIT_DEFAULTS.folderEntries,
              received: 0,
            }
          );
        case "file":
          received.set(
            String(params.path),
            params.base64 ? [fromBase64(String(params.base64))] : [],
          );
          return { status: "open", uploadId: "u1", maxBytes: 1_000_000, received: 0 };
        case "chunk": {
          const path = [...received.keys()].at(-1)!;
          received.get(path)!.push(fromBase64(String(params.base64)));
          return { status: "open", uploadId: "u1", maxBytes: 1_000_000, received: 0 };
        }
        case "commit":
          return options.seam?.commit?.() ?? { status: "written", artifact: {}, created: true };
        case "abort":
          return { status: "aborted" };
      }
      throw new Error(`unexpected op ${String(params.op)}`);
    },
  } as unknown as HarnessChannel;
  const files: HarnessFiles = {
    async list(_run, dir, maxEntries) {
      expect(dir).toBe(DEFAULT_OUTPUTS_CONFIG.dir);
      expect(maxEntries).toBe(run.start.limits.folderEntries);
      if (tree === "missing") return { kind: "missing" };
      if ("failed" in tree)
        return { kind: "failed", code: "sandbox.error", message: String(tree.failed) };
      return {
        kind: "listed",
        entries: Object.entries(tree).map(([path, value]) => ({
          path,
          size: text(value).byteLength,
        })),
        truncated: options.truncated === true,
      };
    },
    async read(_run, path) {
      const name = path.slice(DEFAULT_OUTPUTS_CONFIG.dir.length + 1);
      const value = (tree as Record<string, string>)[name];
      return value === undefined
        ? { kind: "missing", path }
        : { kind: "read", path, bytes: text(value) };
    },
    write: async () => ({ kind: "failed", code: "unused", message: "unused" }),
    mount: async () => ({ kind: "present" }),
  };
  const run = {
    runId: "r1",
    grant: { sessionId: "s1", turnId: "t1" },
    start: { limits: { ...RUNTIME_LIMIT_DEFAULTS, ...options.limits } },
    signal: new AbortController().signal,
  } as unknown as HarnessRun;
  const save = (config = DEFAULT_OUTPUTS_CONFIG) =>
    saveOutputs({ channel, run, files, config, signal: run.signal });
  const ops = () => requests.filter((r) => r.method === "artifact.write").map((r) => r.params.op);
  const claims = () => requests.filter((r) => r.method === "event").map((r) => r.params);
  return { save, requests, received, ops, claims };
}

describe("the outputs folder", () => {
  it("saves each file with its hash under the turn's key, then commits", async () => {
    const h = setup({ "report.md": "# Report", "data/rows.csv": "a,b\n1,2\n" });
    await h.save();
    expect(h.ops()).toEqual(["begin", "file", "file", "commit"]);
    expect(h.requests[0]!.params).toMatchObject({
      op: "begin",
      kind: "folder",
      key: "outputs:t1",
      name: "outputs",
      sameName: true,
    });
    const file = h.requests.find((r) => r.params.path === "report.md")!.params;
    expect(file).toMatchObject({
      size: 8,
      sha256: sha(text("# Report")),
      contentType: "text/markdown",
    });
    expect(h.claims()).toEqual([]);
  });

  it("sends a file larger than a chunk in chunks naming it by hash", async () => {
    const h = setup({ "big.txt": "x".repeat(10) }, { limits: { chunkBytes: 4 } });
    await h.save();
    expect(h.ops()).toEqual(["begin", "file", "chunk", "chunk", "chunk", "commit"]);
    const chunks = h.requests.filter((r) => r.params.op === "chunk").map((r) => r.params);
    expect(chunks.map((c) => c.offset)).toEqual([0, 4, 8]);
    expect(chunks.every((c) => c.sha256 === sha(text("x".repeat(10))))).toBe(true);
    expect(Buffer.concat(h.received.get("big.txt")!).toString()).toBe("x".repeat(10));
  });

  it("saves nothing and claims nothing without the directory, or with it empty", async () => {
    for (const tree of ["missing", {}] as const) {
      const h = setup(tree);
      await h.save();
      expect(h.requests).toEqual([]);
    }
  });

  it("stores nothing when this turn's outputs were saved already", async () => {
    const h = setup(
      { "a.txt": "a" },
      { seam: { begin: () => ({ status: "written", artifact: {}, created: false }) } },
    );
    await h.save();
    expect(h.ops()).toEqual(["begin"]);
  });

  it("claims artifact.export.skipped past the folder's entries, a file's limit or its bytes", async () => {
    const many = setup({ "a.txt": "a" }, { truncated: true, limits: { folderEntries: 1 } });
    await many.save();
    expect(many.ops()).toEqual([]);
    expect(many.claims()).toEqual([
      expect.objectContaining({
        type: "artifact.export.skipped",
        sessionId: "s1",
        turnId: "t1",
        payload: expect.objectContaining({ name: "outputs", reason: "too_many_files", limit: 1 }),
      }),
    ]);

    const large = setup(
      { "big.bin": "x".repeat(20) },
      {
        seam: {
          begin: () => ({
            status: "open",
            uploadId: "u1",
            maxBytes: 1_000,
            maxFileBytes: 10,
            received: 0,
          }),
        },
      },
    );
    await large.save();
    expect(large.ops()).toEqual(["begin", "abort"]);
    expect(large.claims()[0]).toMatchObject({
      payload: { reason: "file_too_large", path: "big.bin", limit: 10 },
    });

    const total = setup({ "a.txt": "aaaa", "b.txt": "bbbb" });
    await total.save(outputsConfigOf({ maxBytes: 6 }));
    expect(total.ops()).toEqual(["begin", "abort"]);
    expect(total.claims()[0]).toMatchObject({ payload: { reason: "too_large", limit: 6 } });
  });

  it("claims the total a commit was refused for", async () => {
    const h = setup(
      { "a.txt": "a" },
      {
        seam: {
          commit: () => ({
            status: "refused",
            reason: "environment_total",
            message: "full",
            limit: 5,
          }),
        },
      },
    );
    await h.save();
    expect(h.claims()[0]).toMatchObject({
      type: "artifact.export.skipped",
      payload: { reason: "environment_total", message: "full", limit: 5 },
    });
  });

  it("claims artifact.export.failed when the sandbox fails, and never throws", async () => {
    const h = setup({ failed: "the sandbox is gone" });
    await expect(h.save()).resolves.toBeUndefined();
    expect(h.claims()).toEqual([
      expect.objectContaining({
        type: "artifact.export.failed",
        payload: { name: "outputs", message: "the sandbox is gone" },
      }),
    ]);
  });

  it("is harness configuration: another directory", async () => {
    const config = outputsConfigOf({ dir: "/workspace/out" });
    expect(config).toEqual({ dir: "/workspace/out", maxBytes: DEFAULT_OUTPUTS_CONFIG.maxBytes });
  });
});
