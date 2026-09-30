import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (!pkg.dependencies?.["@nylorun/harness"])
  throw new Error("Runtime must use canonical Harness contracts through a direct dependency.");
if (pkg.bin !== undefined)
  throw new Error("Runtime is a library with no bin: it runs as the ghcr.io/nylorun/runtime image.");
const cache = mkdtempSync(join(tmpdir(), "nylorun-runtime-pack-"));
const output = execFileSync(
  "npm",
  ["pack", "--dry-run", "--json", "--ignore-scripts"],
  { encoding: "utf8", env: { ...process.env, npm_config_cache: cache } },
);
rmSync(cache, { recursive: true, force: true });
const files = JSON.parse(output)[0].files.map((entry) => entry.path);
const version = readFileSync("dist/version.js", "utf8");
const declared = /RUNTIME_VERSION = "([^"]+)"/.exec(version)?.[1];
if (declared !== pkg.version)
  throw new Error(
    `RUNTIME_VERSION is ${declared} but package.json is ${pkg.version}; update runtime/src/version.ts.`,
  );
if (files.some((path) => path.startsWith("dist/launcher/")))
  throw new Error("dist/launcher/ must not be packed: the launcher was removed.");
for (const path of [
  "dist/configuration.js",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/node/index.js",
  "dist/core/runtime.js",
  "dist/host/main.js",
  "dist/version.js",
  "dist/openapi.json",
  "dist/admin-openapi.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
])
  if (!files.includes(path)) throw new Error(`Missing ${path}`);
// The packed OpenAPI documents are the routes' (`openapi/` is their committed snapshot).
execFileSync(process.execPath, ["scripts/build-openapi.mjs", "--check"], { stdio: "inherit" });
console.log("Runtime Node host package checks passed.");
