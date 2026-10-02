import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Run the built `nylorun` in an empty directory, with an empty home directory (`HOME`, so
 * `~/.nylorun` is empty too) and without Docker on PATH.
 */
function nylorun(args: string[], env: Record<string, string> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "nylorun-cli-"));
  dirs.push(cwd);
  const result = spawnSync(process.execPath, [join(process.cwd(), "dist/cli.js"), ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: join(cwd, "user"),
      PATH: dirname(process.execPath),
      NYLORUN_HOME: "",
      NYLORUN_STACK: "",
      ...env,
    },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("nylorun (the setup command)", () => {
  it("lists up and down beside start and stop, and the stack commands", () => {
    const { code, stdout } = nylorun(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/up\|start/);
    expect(stdout).toMatch(/down\|stop/);
    expect(stdout).toMatch(/^ {2}ls \[--json\]/m);
    expect(stdout).toMatch(/^ {2}delete <stack> --yes/m);
    expect(stdout).toMatch(/^ {2}legacy stop\|delete/m);
    expect(stdout).not.toMatch(/\bdev\b|\btenant\b|configure/);
  });

  it.each([
    [["dev"], /npx nylorun start/],
    [["dev", "--ephemeral"], /npx nylorun start/],
    [["tenant", "list"], /Tenant commands were removed.*npx nylorun start.*npx @nylorun\/cli status\|reset\|endpoints/],
    [["tenant", "create"], /a stack serves one Tenant/],
    [["configure"], /npx @nylorun\/cli configure/],
    [["status", "--env"], /npx @nylorun\/cli env/],
    [["doctor", "sandbox"], /npx @nylorun\/cli doctor sandbox/],
  ])("%j names its replacement (exit 2)", (args, message) => {
    const { code, stderr } = nylorun(args);
    expect(code).toBe(2);
    expect(stderr).toMatch(message);
  });

  it("needs a stack outside a project, and lists none on an empty machine", () => {
    const status = nylorun(["status"]);
    expect(status.code).toBe(2);
    expect(status.stderr).toMatch(/No stack selected/);
    expect(nylorun(["start"]).stderr).toMatch(/--name <stack>/);
    const ls = nylorun(["ls"]);
    expect(ls.code).toBe(0);
    expect(ls.stdout).toMatch(/^No stacks under .*user\/\.nylorun\/stacks\./);
    const deleted = nylorun(["delete", "nothing", "--yes"]);
    expect(deleted.code).toBe(3);
  });
});
