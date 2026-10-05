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
      NYLORUN_TENANT: "",
      ...env,
    },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("nylorun (the setup command)", () => {
  it("lists up and down beside start and stop, and the Tenant commands", () => {
    const { code, stdout } = nylorun(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/up\|start \[--tenant <name>\]/);
    expect(stdout).toMatch(/down\|stop/);
    expect(stdout).toMatch(/^ {2}ls \[--json\]/m);
    expect(stdout).toMatch(/^ {2}delete <tenant> --yes/m);
    expect(stdout).toMatch(/^Local Tenants \(Docker Compose\), one per project:$/m);
    expect(stdout).toMatch(/^ {2}key put <id> \[--management\] \[--tenant <name>\]/m);
    expect(stdout).toMatch(/^ {2}key rm <id>/m);
    expect(stdout).not.toMatch(/stack|legacy|--name|\bdev\b|configure/i);
  });

  it.each([
    [["dev"], /npx nylorun start/],
    [["dev", "--ephemeral"], /npx nylorun start/],
    [["tenant", "list"], /^nylorun <up\|down\|start/],
    [["legacy", "stop"], /^nylorun <up\|down\|start/],
    [["stack", "start"], /^nylorun <up\|down\|start/],
    [["doctor", "stack"], /Usage: nylorun doctor \[--json\]/],
    [["configure"], /npx @nylorun\/cli configure/],
    [["status", "--env"], /npx @nylorun\/cli env/],
    [["doctor", "sandbox"], /npx @nylorun\/cli doctor sandbox/],
    [["key"], /key put <id>/],
    [["key", "put"], /Usage: nylorun key put <id>/],
  ])("%j names its replacement (exit 2)", (args, message) => {
    const { code, stderr } = nylorun(args);
    expect(code).toBe(2);
    expect(stderr).toMatch(message);
  });

  it("acts on the default Tenant outside a project, and lists none on an empty machine", () => {
    const status = nylorun(["status"]);
    expect(status.code).toBe(3);
    expect(status.stdout).toMatch(/^Tenant {6}default absent \(nothing under .*user\/\.nylorun\/tenants\/default; run "nylorun start"\)/);
    expect(nylorun(["start"]).stderr).toMatch(/docker command was not found/);
    expect(nylorun(["status", "--tenant", "tn_x"]).stderr).toMatch(/not a Tenant id/);
    const ls = nylorun(["ls"]);
    expect(ls.code).toBe(0);
    expect(ls.stdout).toMatch(/^No Tenants on this machine\./);
    const deleted = nylorun(["delete", "nothing", "--yes"]);
    expect(deleted.code).toBe(3);
  });
});
