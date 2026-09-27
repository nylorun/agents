const { checkBoundaries } = await import("../../scripts/check-boundaries.mjs");
checkBoundaries("studio");
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
if (manifest.license !== "Apache-2.0")
  throw new Error("Studio must be licensed under Apache-2.0.");
if (
  manifest.repository?.url !== "git+https://github.com/nylorun/agents.git" ||
  manifest.repository?.directory !== "studio"
)
  throw new Error("Studio must reference its public source directory.");

// Studio ships only as the ghcr.io/nylorun/studio image (studio/Dockerfile).
if (manifest.private !== true)
  throw new Error("Studio must be private: it ships only as the ghcr.io/nylorun/studio image.");
for (const field of ["bin", "publishConfig", "files"])
  if (manifest[field] !== undefined)
    throw new Error(`Studio is not published to npm; remove "${field}" from package.json.`);
if (
  manifest.dependencies?.["@nylorun/create-agent"] !== undefined ||
  manifest.dependencies?.["@nylorun/create-harness"] !== undefined
)
  throw new Error("Studio must not depend on a project creator.");
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

/** Design §15: UI packages are build-time only; the server needs admin and agents alone. */
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

// What the image copies: the server entry and the built dashboard.
for (const required of [
  "dist/server-main.js",
  "dist/server.js",
  "dist/proxy.js",
  "dist/static.js",
  "dist/index.js",
  "dist/web/index.html",
])
  if (!existsSync(required)) throw new Error(`Missing Studio build output: ${required}`);
for (const removed of [
  "dist/cli.js",
  "dist/host.js",
  "dist/local-ui.js",
  "dist/access.js",
  "dist/ui-digest.json",
  "dist/bundle.tar",
])
  if (existsSync(removed))
    throw new Error(`${removed} belongs to the removed hosted/local Studio modes.`);
console.log("Studio package checks passed (private; image build output present).");
