/**
 * Sandbox conformance suite v1. Every backend must pass it; a backend that cannot meet a
 * requirement must say so through `unmet()` instead of weakening the behaviour.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveNetwork } from "../../src/sandbox/policy.js";
import { runSandboxTool, type SandboxToolOutcome } from "../../src/sandbox/tools.js";
import type { SandboxBackend, SandboxHandle, SandboxSpec } from "../../src/sandbox/types.js";
import type { SandboxManifest, SandboxToolName } from "@nylorun/core/define";

export interface ConformanceOptions {
  readonly backend: () => SandboxBackend;
  /** Shell command printing the HTTP status for a URL, or failing when the request is blocked. */
  readonly fetch: (url: string) => string;
  /** Run tests that need real internet access. */
  readonly network: boolean;
  /** Image for every sandbox; `null` means the backend's default. Default `python:3.13-slim`. */
  readonly image?: string | null;
}

const HOST_SECRET = "NYLORUN_CONFORMANCE_HOST_SECRET";

export function conformance(name: string, options: ConformanceOptions) {
  describe(`${name} sandbox conformance`, () => {
    const backend = options.backend();
    const created: string[] = [];
    const spec = (sandbox: SandboxManifest = {}): SandboxSpec => {
      const key = `nylorun-conformance-${randomUUID().slice(0, 12)}`;
      created.push(key);
      return {
        key,
        ...(options.image === null ? {} : { image: options.image ?? "python:3.13-slim" }),
        cpus: 1,
        memoryMiB: 512,
        network: resolveNetwork(sandbox),
      };
    };
    const tool = (
      handle: SandboxHandle,
      toolName: SandboxToolName,
      input: Record<string, unknown>,
      signal = new AbortController().signal
    ): Promise<SandboxToolOutcome> => runSandboxTool(handle, toolName, input, signal, () => {});
    const output = (outcome: SandboxToolOutcome): any => {
      expect(outcome.kind).toBe("completed");
      return (outcome as { output: unknown }).output;
    };
    let shared: SandboxHandle;
    /** The backend's workspace: `/workspace`, or `/sandbox` on OpenShell. */
    let ws = "/workspace";

    beforeAll(async () => {
      process.env[HOST_SECRET] = "host-secret-value";
      shared = await backend.open(spec({ network: { preset: "none" } }));
      ws = shared.workspace ?? "/workspace";
    }, 300_000);

    afterAll(async () => {
      delete process.env[HOST_SECRET];
      for (const key of created) await backend.remove(key).catch(() => undefined);
    }, 120_000);

    it("runs commands in the workspace and resolves relative paths there", async () => {
      expect(output(await tool(shared, "bash", { command: "pwd" })).stdout.trim()).toBe(ws);
      output(await tool(shared, "write", { path: "notes/today.txt", content: "alpha\nbeta\n" }));
      const cat = output(await tool(shared, "bash", { command: `cat ${ws}/notes/today.txt` }));
      expect(cat.stdout).toBe("alpha\nbeta\n");
      expect(output(await tool(shared, "read", { path: `${ws}/notes/today.txt` }))).toBe("1\talpha\n2\tbeta");
      // `/workspace/…` in a tool path names the workspace on every backend.
      expect(output(await tool(shared, "read", { path: "/workspace/notes/today.txt" }))).toBe("1\talpha\n2\tbeta");
    });

    it("returns a non-zero exit as a normal result", async () => {
      const result = output(await tool(shared, "bash", { command: "echo oops >&2; exit 3" }));
      expect(result).toMatchObject({ exitCode: 3, stderr: "oops\n" });
    });

    it("does not leak the host environment", async () => {
      const env = output(await tool(shared, "bash", { command: "env" })).stdout;
      expect(env).not.toContain(HOST_SECRET);
      expect(env).not.toContain("host-secret-value");
    });

    it("pages reads and reports missing files", async () => {
      output(await tool(shared, "write", { path: "lines.txt", content: "1\n2\n3\n4\n5\n" }));
      const page = output(await tool(shared, "read", { path: "lines.txt", offset: 2, limit: 2 }));
      expect(page).toContain("2\t2\n3\t3");
      expect(page).toContain("offset 4");
      expect(await tool(shared, "read", { path: "missing.txt" })).toMatchObject({
        kind: "failed",
        code: "sandbox.not_found",
      });
    });

    it("edits exact unique text and rejects ambiguous edits", async () => {
      output(await tool(shared, "write", { path: "edit.txt", content: "x = 1\ny = 1\n" }));
      expect(await tool(shared, "edit", { path: "edit.txt", old_string: "= 1", new_string: "= 2" })).toMatchObject({
        kind: "failed",
        code: "sandbox.edit_not_unique",
      });
      output(await tool(shared, "edit", { path: "edit.txt", old_string: "x = 1", new_string: "x = 2" }));
      output(await tool(shared, "edit", { path: "edit.txt", old_string: " = ", new_string: ": ", replace_all: true }));
      expect(output(await tool(shared, "bash", { command: "cat edit.txt" })).stdout).toBe("x: 2\ny: 1\n");
    });

    it("finds files with grep and glob", async () => {
      output(await tool(shared, "write", { path: "src/a.py", content: "def main():\n    return 42\n" }));
      output(await tool(shared, "write", { path: "src/b.txt", content: "main course\n" }));
      const grep = output(await tool(shared, "grep", { pattern: "def [a-z]+", glob: "*.py" }));
      expect(grep).toContain("src/a.py:1:def main():");
      expect(grep).not.toContain("b.txt");
      expect(output(await tool(shared, "grep", { pattern: "nothing-here" }))).toBe("No matches.");
      const glob = output(await tool(shared, "glob", { pattern: "**/*.py" }));
      expect(glob).toBe(`${ws}/src/a.py`);
      expect(output(await tool(shared, "glob", { pattern: "*.txt", path: "src" }))).toBe(`${ws}/src/b.txt`);
    });

    it("kills a command on timeout and on cancellation", async () => {
      const timed = output(await tool(shared, "bash", { command: "sleep 30", timeout: 1 }));
      expect(timed).toMatchObject({ exitCode: 124, timedOut: true });
      const controller = new AbortController();
      const started = Date.now();
      setTimeout(() => controller.abort(), 300);
      const cancelled = await shared.exec({ command: "sleep 30", cwd: ws, timeoutMs: 60_000 }, controller.signal);
      expect(cancelled.killed).toBe(true);
      expect(Date.now() - started).toBeLessThan(10_000);
    }, 30_000);

    it("blocks egress under the none preset", async () => {
      const result = output(await tool(shared, "bash", { command: options.fetch("https://example.com/"), timeout: 20 }));
      expect(result.exitCode).not.toBe(0);
    }, 30_000);

    it("blocks metadata and private ranges even under the open preset", async () => {
      const openSpec = spec({ network: { preset: "open" } });
      // A backend that cannot open all egress says so; the Runtime then refuses such a sandbox.
      if (backend.unmet(openSpec)) return;
      const open = await backend.open(openSpec);
      try {
        for (const url of ["http://169.254.169.254/", "http://10.0.0.1/", "http://127.0.0.1:9/"]) {
          const result = output(await tool(open, "bash", { command: options.fetch(url), timeout: 20 }));
          expect(result.exitCode, url).not.toBe(0);
        }
      } finally {
        await open.stop();
      }
    }, 120_000);

    it.skipIf(!options.network)("allows registry hosts under dev and denies others", async () => {
      const dev = await backend.open(spec());
      try {
        const pypi = output(await tool(dev, "bash", { command: options.fetch("https://pypi.org/pypi/pip/json"), timeout: 30 }));
        expect(pypi.stdout.trim()).toBe("200");
        const other = output(await tool(dev, "bash", { command: options.fetch("https://example.com/"), timeout: 30 }));
        expect(other.exitCode).not.toBe(0);
      } finally {
        await dev.stop();
      }
    }, 120_000);

    it("keeps files across stop and reopen, and remove deletes them", async () => {
      const persistent = spec({ network: { preset: "none" } });
      const first = await backend.open(persistent);
      output(await tool(first, "write", { path: "keep.txt", content: "kept" }));
      await first.stop();
      const second = await backend.open(persistent);
      expect(output(await tool(second, "read", { path: "keep.txt" }))).toBe("1\tkept");
      await second.stop();
      expect(await backend.list(persistent.key)).toEqual([persistent.key]);
      await backend.remove(persistent.key);
      expect(await backend.list(persistent.key)).toEqual([]);
    }, 180_000);
  });
}
