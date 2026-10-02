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
// The Session Store's migrations, read next to the built runner (`store/postgres/migrate.ts`).
const migrations = "dist/store/postgres/drizzle";
const journal = JSON.parse(readFileSync(`${migrations}/meta/_journal.json`, "utf8"));
if (journal.entries.length === 0) throw new Error("The migration journal is empty");
for (const path of [
  `${migrations}/meta/_journal.json`,
  ...journal.entries.map(({ tag }) => `${migrations}/${tag}.sql`),
])
  if (!files.includes(path)) throw new Error(`Missing ${path}: the build copies the migrations`);
for (const path of files)
  if (path.startsWith(`${migrations}/`) && !path.endsWith(".sql") && path !== `${migrations}/meta/_journal.json`)
    throw new Error(`${path} must not be packed: only the migrations and their journal ship`);
if (files.includes("drizzle.config.ts") || pkg.dependencies?.["drizzle-kit"])
  throw new Error("drizzle-kit and its configuration are for development only");
if (!pkg.dependencies?.["drizzle-orm"])
  throw new Error("The Session Store runs on drizzle-orm: it must be a dependency");
// The packed OpenAPI documents are the routes' (`openapi/` is their committed snapshot).
execFileSync(process.execPath, ["scripts/build-openapi.mjs", "--check"], { stdio: "inherit" });
console.log("Runtime Node host package checks passed.");
