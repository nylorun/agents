import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const DEPRECATION =
  "@nylorun/cli is deprecated: nylo is part of nylorun, and nylorun 0.18 removes both. Run npx nylorun --help.\n";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Run the deprecated package's `nylo` in a temporary Project directory. */
function nylo(args: string[]) {
  const root = mkdtempSync(join(tmpdir(), "nylorun-cli-stub-"));
  dirs.push(root);
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  const result = spawnSync(process.execPath, [join(process.cwd(), "dist/cli.js"), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NYLORUN_RUNTIME_URL: "", NYLORUN_SERVER_KEY: "", NYLORUN_MANAGEMENT_KEY: "" },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

it("runs nylorun's nylo, after one deprecation line on stderr: it names the nylorun command", () => {
  const { code, stdout, stderr } = nylo(["status"]);
  expect(code).toBe(2);
  expect(stdout).toBe("");
  expect(stderr).toBe(
    `${DEPRECATION}nylo is part of nylorun now: nylo status is nylorun status. nylorun 0.18 removes nylo.\n`,
  );
});

it("names nothing for env: the SDKs read the Project link", () => {
  const { code, stderr } = nylo(["env"]);
  expect(code).toBe(2);
  expect(stderr).toMatch(/^@nylorun\/cli is deprecated[^\n]*\nnylo is part of nylorun now: nylo env is nothing/);
});
