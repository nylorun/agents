import { readFileSync, existsSync } from "node:fs";
import { checkBoundaries } from "../../scripts/check-boundaries.mjs";
checkBoundaries("nylorun");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (pkg.bin?.nylorun !== "dist/cli.js")
  throw new Error("Missing nylorun binary");
const deps = Object.keys(pkg.dependencies ?? {}).sort();
const expected = ["@nylorun/core"];
if (JSON.stringify(deps) !== JSON.stringify(expected)) {
  throw new Error(
    `nylorun dependencies must be exactly ${expected.join(", ")}; got ${deps.join(", ")}`,
  );
}
for (const name of ["runtime", "studio"])
  if (typeof pkg.nylorun?.[name] !== "string")
    throw new Error(`Missing the pinned ${name} image version (nylorun.${name})`);
for (const path of [
  "dist/cli.js",
  "dist/stack/index.js",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
])
  if (!existsSync(path)) throw new Error(`Missing nylorun artifact: ${path}`);
