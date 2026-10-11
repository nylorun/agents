import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkConformance } from "../../scripts/check-boundaries.mjs";

// The suite is a black box: no Nylorun package, no Runtime code.
checkConformance();
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (pkg.private === true || pkg.publishConfig?.access !== "public")
  throw new Error("@nylorun/harness-conformance is published to npm: public, not private");
const sdk = await import("@nylorun/harness-conformance");
for (const name of ["runConformance", "CHECKS", "RuntimeClient"])
  if (sdk[name] === undefined) throw new Error(`Missing harness-conformance export ${name}`);
// The bin runs under npx: a shebang, and a usage error (exit 2) without options.
const bin = fileURLToPath(new URL(`../${pkg.bin["nylorun-harness-conformance"]}`, import.meta.url));
if (!readFileSync(bin, "utf8").startsWith("#!/usr/bin/env node\n"))
  throw new Error(`${bin} must start with a node shebang`);
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("NYLORUN_")),
);
const usage = spawnSync(process.execPath, [bin], { env, encoding: "utf8" });
if (usage.status !== 2 || !usage.stderr.includes("Usage: nylorun-harness-conformance"))
  throw new Error(`The bin without options must exit 2 with its usage (got ${usage.status})`);
console.log("harness-conformance: entry point, bin and boundaries ok.");
