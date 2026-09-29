#!/usr/bin/env node
// Regenerates the vendored OpenShell gRPC client in
// runtime/src/adapters/sandbox/openshell/gen/ from a tagged OpenShell release
// (Apache-2.0), with OpenShell's own buf template (protoc-gen-es, target=ts):
//
//   node scripts/openshell-client.mjs            # the pinned tag below
//   node scripts/openshell-client.mjs v0.1.3     # an upgrade, in its own pull request
//
// After an upgrade: pin the same tag in runtime/test/openshell/ (images and config)
// and run the OpenShell conformance suite (see runtime/test/openshell/up.mjs).
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const tag = process.argv[2] ?? "v0.1.2";
const target = fileURLToPath(new URL("../runtime/src/adapters/sandbox/openshell/gen", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "openshell-client-"));

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
}

try {
  run("git", ["clone", "--depth", "1", "--branch", tag, "https://github.com/NVIDIA/OpenShell.git", "src"], work);
  const sdk = join(work, "src", "sdk", "typescript");
  run("npm", ["ci", "--no-audit", "--no-fund"], sdk);
  run("npx", ["buf", "generate"], sdk);
  rmSync(target, { recursive: true, force: true });
  cpSync(join(sdk, "src", "gen"), target, { recursive: true });
  console.log(`OpenShell ${tag} client written to ${target}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
