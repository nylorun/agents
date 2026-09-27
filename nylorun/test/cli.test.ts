import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Run the built `nylorun` in an empty directory with an empty Host root. */
function nylorun(...args: string[]) {
  const cwd = mkdtempSync(join(tmpdir(), "nylorun-cli-"));
  const result = spawnSync(process.execPath, [join(process.cwd(), "dist/cli.js"), ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NYLORUN_HOME: join(cwd, "home") },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("nylorun (the setup command)", () => {
  it("lists up and down beside start and stop", () => {
    const { code, stdout } = nylorun("--help");
    expect(code).toBe(0);
    expect(stdout).toMatch(/up\|start/);
    expect(stdout).toMatch(/down\|stop/);
    expect(stdout).not.toMatch(/\bdev\b|\btenant\b|configure/);
  });

  it.each([
    [["dev"], /npx @nylorun\/cli tenant create/],
    [["dev", "--ephemeral"], /npx @nylorun\/cli tenant create/],
    [["tenant", "list"], /npx @nylorun\/cli tenant/],
    [["configure"], /npx @nylorun\/cli configure/],
    [["status", "--env"], /npx @nylorun\/cli env/],
    [["doctor", "sandbox"], /npx @nylorun\/cli doctor sandbox/],
  ])("%j names its replacement in the Runtime client (exit 2)", (args, message) => {
    const { code, stderr } = nylorun(...args);
    expect(code).toBe(2);
    expect(stderr).toMatch(message);
  });
});
