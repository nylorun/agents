import { readFileSync, existsSync } from "node:fs";
import { checkBoundaries } from "../../scripts/check-boundaries.mjs";
import { PI_AI_VERSION } from "../dist/client/model/pi-ai.js";
checkBoundaries("nylorun");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (pkg.bin?.nylorun !== "dist/cli.js")
  throw new Error("Missing nylorun binary");
if (pkg.bin?.nylo !== "dist/nylo.js")
  throw new Error("Missing nylo binary");
const deps = Object.keys(pkg.dependencies ?? {}).sort();
const expected = ["@nylorun/admin", "@nylorun/core"];
if (JSON.stringify(deps) !== JSON.stringify(expected)) {
  throw new Error(
    `nylorun dependencies must be exactly ${expected.join(", ")}; got ${deps.join(", ")}`,
  );
}
// `nylo configure` installs pi-ai on first use (client/model/pi-ai.ts), at the version the
// build and the tests used.
if (pkg.devDependencies?.["@earendil-works/pi-ai"] !== PI_AI_VERSION)
  throw new Error(
    `nylorun's @earendil-works/pi-ai devDependency must equal PI_AI_VERSION (${PI_AI_VERSION})`,
  );
for (const name of ["runtime", "studio"])
  if (typeof pkg.nylorun?.[name] !== "string")
    throw new Error(`Missing the pinned ${name} image version (nylorun.${name})`);
for (const path of [
  "dist/cli.js",
  "dist/nylo.js",
  "dist/stack/index.js",
  "dist/client/cli.js",
  "dist/client/model/configure.js",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
])
  if (!existsSync(path)) throw new Error(`Missing nylorun artifact: ${path}`);
