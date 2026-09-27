const { checkBoundaries } = await import("../../scripts/check-boundaries.mjs");
checkBoundaries("studio");
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
if (manifest.license !== "Apache-2.0")
  throw new Error("Studio must publish under Apache-2.0.");
if (
  manifest.repository?.url !== "git+https://github.com/nylorun/harness.git" ||
  manifest.repository?.directory !== "studio"
)
  throw new Error("Studio must reference its public source directory.");
if (manifest.bugs !== "https://github.com/nylorun/harness/issues")
  throw new Error("Studio must reference the public issue tracker.");
if (manifest.homepage !== "https://docs.nylorun.com")
  throw new Error("Studio homepage must point to Nylorun documentation.");
if (
  manifest.dependencies?.["@nylorun/create-agent"] !== undefined ||
  manifest.dependencies?.["@nylorun/create-harness"] !== undefined
)
  throw new Error("Studio must not depend on a project creator.");
if (
  !manifest.bin ||
  Object.keys(manifest.bin).length !== 1 ||
  manifest.bin["nylorun-studio"] !== "dist/cli.js"
)
  throw new Error('Studio bin must be { "nylorun-studio": "dist/cli.js" }.');
for (const field of [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
])
  for (const name of [
    "@nylorun/harness",
    "@nylorun/runtime",
    "@nylorun/cli",
    "@nylorun/core",
  ])
    if (manifest[field]?.[name])
      throw new Error(`Studio must not depend on ${name}`);
const nylorunDeps = Object.keys(manifest.dependencies ?? {})
  .filter((name) => name.startsWith("@nylorun/"))
  .sort();
if (nylorunDeps.join(",") !== "@nylorun/admin,@nylorun/agents")
  throw new Error(
    "Studio must depend only on @nylorun/admin and @nylorun/agents among Nylorun packages.",
  );

/** Design §15: UI packages are build-time only; proxy runtime dep is agents alone. */
const UI_DEV_DEPS = [
  "react",
  "react-dom",
  "radix-ui",
  "lucide-react",
  "react-router-dom",
  "react-resizable-panels",
  "class-variance-authority",
  "clsx",
  "tailwind-merge",
  "tw-animate-css",
  "dayjs",
];
for (const name of UI_DEV_DEPS) {
  if (manifest.dependencies?.[name])
    throw new Error(`Studio UI package ${name} must be a devDependency (design §15).`);
  if (!manifest.devDependencies?.[name])
    throw new Error(`Studio UI package ${name} must be listed in devDependencies.`);
}
const runtimeDeps = Object.keys(manifest.dependencies ?? {}).sort();
if (runtimeDeps.join(",") !== "@nylorun/admin,@nylorun/agents")
  throw new Error(
    "Studio runtime dependencies must be only @nylorun/admin and @nylorun/agents (plus Node built-ins).",
  );

/** SD-I5: browser sources must not pull engine, host or executor. */
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}
for (const path of walk("web/src")) {
  if (!/\.(?:ts|tsx)$/.test(path)) continue;
  const source = readFileSync(path, "utf8");
  for (const pattern of [
    /@nylorun\/harness/,
    /@nylorun\/runtime/,
    /@nylorun\/core/,
    /@nylorun\/admin/,
    /@nylorun\/agents\/executor/,
    /execute-action/,
  ])
    if (pattern.test(source))
      throw new Error(`SD-I5: ${path} must not import engine/host/executor (${pattern})`);
}

const digest = JSON.parse(readFileSync("dist/ui-digest.json", "utf8"));
if (typeof digest.version !== "string" || !digest.version)
  throw new Error("dist/ui-digest.json must include version.");
if (typeof digest.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(digest.sha256))
  throw new Error("dist/ui-digest.json must include a 64-char hex sha256.");
if (digest.version !== manifest.version)
  throw new Error(
    `dist/ui-digest.json version (${digest.version}) must match package.json (${manifest.version}).`,
  );

const cache = mkdtempSync(join(tmpdir(), "nylo-studio-pack-"));
const output = execFileSync(
  "npm",
  ["pack", "--json", "--dry-run", "--ignore-scripts"],
  { encoding: "utf8", env: { ...process.env, npm_config_cache: cache } }
);
rmSync(cache, { recursive: true, force: true });
const files = JSON.parse(output)[0].files.map((entry) => entry.path);
for (const required of [
  "package.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "dist/cli.js",
  "dist/host.js",
  "dist/server.js",
  "dist/server-main.js",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/ui-digest.json",
])
  if (!files.includes(required))
    throw new Error(`Missing tarball file: ${required}`);
if (files.includes("dist/ui.js"))
  throw new Error("Legacy inline Studio UI must not be packaged.");
if (files.includes("dist/bundle.tar"))
  throw new Error("dist/bundle.tar must not be published in the npm tarball.");
for (const path of files)
  if (path === "dist/web" || path.startsWith("dist/web/"))
    throw new Error(`dist/web must not be published in the npm tarball: ${path}`);
console.log(`Studio tarball allowlist passed (${files.length} files).`);
