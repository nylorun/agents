import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const nylorunManifest = require.resolve("nylorun/package.json");
const nylorunCli = join(
  dirname(nylorunManifest),
  (require(nylorunManifest) as { bin: { nylorun: string } }).bin.nylorun,
);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Run `entry` with `args` in a temporary Project directory with no Runtime configured. */
function run(entry: string, args: string[]) {
  const root = mkdtempSync(join(tmpdir(), "nylorun-cli-mirror-"));
  dirs.push(root);
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NYLORUN_RUNTIME_URL: "", NYLORUN_SERVER_KEY: "", NYLORUN_MANAGEMENT_KEY: "" },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const mirror = (args: string[]) => run(join(process.cwd(), "dist/cli.js"), args);

it("is nylorun's nylorun: the same help, on stdout, exit 0", () => {
  const help = mirror(["--help"]);
  expect(help).toEqual(run(nylorunCli, ["--help"]));
  expect(help.code).toBe(0);
  expect(help.stdout).toMatch(/^nylorun <command>/);
  expect(help.stderr).toBe("");
});

it("passes every argument through, a subcommand's help and a usage error alike", () => {
  for (const args of [["agents", "--help"], ["no-such-command"]])
    expect(mirror(args)).toEqual(run(nylorunCli, args));
});
