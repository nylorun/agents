import { describe, expect, it } from "vitest";
import { commandShell, localExec } from "../../src/adapters/sandbox/local.js";

describe("the pod's command shell (ADR-92 §10)", () => {
  it("is bash where the image has it, else /bin/sh", () => {
    expect(commandShell((path) => path === "/bin/bash")).toBe("/bin/bash");
    expect(commandShell(() => false)).toBe("/bin/sh");
  });

  it("runs a command with bash syntax when bash is the shell", async () => {
    const exec = localExec({ env: { PATH: process.env.PATH }, workspace: process.cwd(), shell: "/bin/bash" });
    const result = await exec({ command: "[[ 1 == 1 ]] && echo ok", cwd: process.cwd(), timeoutMs: 10_000 }, new AbortController().signal);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  });
});
