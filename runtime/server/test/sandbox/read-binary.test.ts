/**
 * The sandbox's `read` of a binary file (ADR-139): it fails in words instead of numbering decoded
 * bytes, which a model can't tell from text.
 */
import { describe, expect, it } from "vitest";
import { looksBinary, runSandboxTool } from "../../src/sandbox/tools.js";
import { DEFAULT_SANDBOX_TOOL_LIMITS } from "@nylorun/harness";
import type { SandboxHandle } from "../../src/sandbox/types.js";

const handleWith = (files: Record<string, string>) =>
  ({
    readFile: async (path: string) => files[path],
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
  }) as unknown as SandboxHandle;

const read = (files: Record<string, string>, path: string) =>
  runSandboxTool(handleWith(files), "read", { path }, new AbortController().signal, () => undefined, DEFAULT_SANDBOX_TOOL_LIMITS);

describe("the sandbox's read", () => {
  it("tells binary content from text", () => {
    expect(looksBinary("plain text\nwith lines\n")).toBe(false);
    expect(looksBinary("naïve café: ünïcödé ✓")).toBe(false);
    expect(looksBinary("")).toBe(false);
    expect(looksBinary("\u0089PNG\r\n\u001a\n\u0000\u0000\u0000\rIHDR")).toBe(true);
    expect(looksBinary("����ab")).toBe(true);
  });

  it("fails on a binary file, and reads text as before", async () => {
    const files = { "/workspace/data.bin": "PAR1\u0000\u0015\u0004�", "/workspace/notes.md": "# Notes\nhello\n" };
    expect(await read(files, "data.bin")).toMatchObject({
      kind: "failed",
      code: "sandbox.binary_file",
      message: expect.stringContaining("/workspace/data.bin is a binary file, not text"),
    });
    expect(await read(files, "notes.md")).toEqual({ kind: "completed", output: "1\t# Notes\n2\thello" });
  });
});
