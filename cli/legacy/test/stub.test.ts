import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const DEPRECATION =
  "@nylorun/cli is deprecated: nylo ships in nylorun. Use npx -p nylorun nylo, or install nylorun.\n";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Run the deprecated package's `nylo` in a temporary Project directory. */
function nylo(args: string[], setup?: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "nylorun-cli-stub-"));
  dirs.push(root);
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  setup?.(root);
  const result = spawnSync(process.execPath, [join(process.cwd(), "dist/cli.js"), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NYLORUN_RUNTIME_URL: "", NYLORUN_SERVER_KEY: "", NYLORUN_MANAGEMENT_KEY: "" },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

it("runs nylorun's nylo, after one deprecation line on stderr", () => {
  const { code, stdout, stderr } = nylo(["--help"]);
  expect(code).toBe(0);
  expect(stdout).toMatch(/^nylo <status\|reset\|access\|configure\|env\|doctor>/);
  expect(stderr).toBe(DEPRECATION);
});

it("keeps env's stdout to the export lines, so eval works", () => {
  const key = "ab".repeat(32);
  const { code, stdout, stderr } = nylo(["env"], (root) => {
    mkdirSync(join(root, ".nylorun"), { mode: 0o700 });
    writeFileSync(
      join(root, ".nylorun/link.json"),
      JSON.stringify({
        format: 3,
        tenant: "demo",
        hostUrl: "http://127.0.0.1:8787",
        hostId: "host_01habcdefghijklmnopqrstuvw",
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      join(root, ".nylorun/credentials.json"),
      JSON.stringify({ format: 1, applicationKey: key, principalId: "project" }),
      { mode: 0o600 },
    );
  });
  expect(code).toBe(0);
  expect(stdout).toBe(
    `export NYLORUN_RUNTIME_URL=http://127.0.0.1:8787\nexport NYLORUN_SERVER_KEY=${key}\n`,
  );
  expect(stderr).toBe(DEPRECATION);
});

it("exits with nylo's code", () => {
  const { code, stderr } = nylo(["tenant", "list"]);
  expect(code).toBe(2);
  expect(stderr).toMatch(/^@nylorun\/cli is deprecated[^\n]*\nnylo tenant was removed/);
});
