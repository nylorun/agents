import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkAmbient, formatAmbientReport } from "../check-ambient.mjs";

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "check-ambient-"));
  for (const [rel, source] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, source);
  }
  return root;
}

test("passes when runtime/server/src has no ambient reads or tenant console", () => {
  const runtimeSrc = fixture({
    "host/main.ts": `import { homedir } from "node:os";\nprocess.env.NYLORUN_HOME;\nprocess.cwd();\nhomedir();\ntmpdir();\nconsole.log("ok");\n`,
    "host/config.ts": `export const hostId = "host_01";\n`,
    "tenant/logger.ts": `export function info(message: string) {\n  return message;\n}\n`,
    "core/runtime.ts": `export function open() {\n  return { ready: true };\n}\n`,
  });
  try {
    const result = checkAmbient({ runtimeSrc });
    assert.equal(result.ok, true);
    assert.match(formatAmbientReport(result), /no forbidden/);
  } finally {
    rmSync(runtimeSrc, { recursive: true, force: true });
  }
});

test("fails on process.env outside host/main.ts", () => {
  const runtimeSrc = fixture({
    "vault/kek.ts": `export function read() {\n  return process.env.NYLORUN_VAULT_KEK;\n}\n`,
  });
  try {
    const result = checkAmbient({ runtimeSrc });
    assert.equal(result.ok, false);
    assert.ok(
      result.violations.some((line) =>
        line.includes("vault/kek.ts") && line.includes("process.env"),
      ),
    );
  } finally {
    rmSync(runtimeSrc, { recursive: true, force: true });
  }
});

test("fails on process.cwd, homedir, and tmpdir outside host/main.ts", () => {
  const runtimeSrc = fixture({
    "model/settings.ts": `import { homedir, tmpdir } from "node:os";\nexport const root = process.cwd();\nexport const home = homedir();\nexport const tmp = tmpdir();\n`,
  });
  try {
    const result = checkAmbient({ runtimeSrc });
    assert.equal(result.ok, false);
    const text = result.violations.join("\n");
    assert.match(text, /process\.cwd\(\)/);
    assert.match(text, /homedir\(\)/);
    assert.match(text, /tmpdir\(\)/);
  } finally {
    rmSync(runtimeSrc, { recursive: true, force: true });
  }
});

test("allows ambient reads only in host/main.ts", () => {
  const runtimeSrc = fixture({
    "host/main.ts": `process.env.NYLORUN_HOME;\nprocess.cwd();\n`,
    "host/environment.ts": `export const bad = process.env.PATH;\n`,
  });
  try {
    const result = checkAmbient({ runtimeSrc });
    assert.equal(result.ok, false);
    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0], /^host\/environment\.ts:/);
    assert.ok(
      !result.violations.some((line) => line.startsWith("host/main.ts:")),
    );
  } finally {
    rmSync(runtimeSrc, { recursive: true, force: true });
  }
});

test("fails on console. under runtime/server/src/tenant", () => {
  const runtimeSrc = fixture({
    "tenant/runtime.ts": `export function log(msg: string) {\n  console.warn(msg);\n}\n`,
    "core/runtime.ts": `console.log("host path may still use console until D12 elsewhere");\n`,
  });
  try {
    const result = checkAmbient({ runtimeSrc });
    assert.equal(result.ok, false);
    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0], /tenant\/runtime\.ts:2: console\./);
  } finally {
    rmSync(runtimeSrc, { recursive: true, force: true });
  }
});

test("formatAmbientReport lists every violation", () => {
  const result = {
    ok: false,
    violations: ["a.ts:1: ambient process.env", "tenant/b.ts:2: console."],
  };
  const report = formatAmbientReport(result);
  assert.match(report, /forbidden ambient/);
  assert.match(report, /a\.ts:1/);
  assert.match(report, /tenant\/b\.ts:2/);
});

test("launcher/main.ts is no longer allowlisted", () => {
  const runtimeSrc = fixture({
    "host/main.ts": `process.env.NYLORUN_HOME;\nprocess.cwd();\n`,
    "launcher/main.ts": `export const bad = process.env.PATH;\n`,
  });
  try {
    const result = checkAmbient({ runtimeSrc });
    assert.equal(result.ok, false);
    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0], /^launcher\/main\.ts:/);
  } finally {
    rmSync(runtimeSrc, { recursive: true, force: true });
  }
});
