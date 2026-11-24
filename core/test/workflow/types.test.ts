import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

/** This file lives at core/test/workflow/types.test.ts */
const coreRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = join(coreRoot, "..");

function tscBin(): string {
  const candidates = [
    join(repoRoot, "node_modules/.bin/tsc"),
    join(coreRoot, "node_modules/.bin/tsc"),
  ];
  for (const path of candidates) if (existsSync(path)) return path;
  return "tsc";
}

it("type inference checks", () => {
  try {
    execFileSync(tscBin(), ["-p", join(coreRoot, "test/workflow/types/tsconfig.json")], {
      cwd: coreRoot,
      stdio: "pipe",
      env: process.env,
    });
  } catch (error) {
    const err = error as { stdout?: Buffer; stderr?: Buffer; message?: string };
    const out = `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}${err.message ?? ""}`;
    throw new Error(`workflow typecheck failed:\n${out}`);
  }
  expect(true).toBe(true);
});
