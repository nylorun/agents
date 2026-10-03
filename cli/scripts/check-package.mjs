import { readFileSync, existsSync } from "node:fs";
import { checkBoundaries } from "../../scripts/check-boundaries.mjs";
checkBoundaries("cli");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (pkg.bin?.nylo !== "dist/cli.js")
  throw new Error("Missing nylo binary");
// nylorun (the local Tenants' package) owns the `nylorun` command and the image pins.
if (pkg.bin?.nylorun !== undefined || pkg.nylorun !== undefined)
  throw new Error("The CLI must not declare the nylorun binary or image pins");
const deps = Object.keys(pkg.dependencies ?? {}).sort();
const expected = [
  "@earendil-works/pi-ai",
  "@nylorun/admin",
  "@nylorun/agents",
].sort();
if (JSON.stringify(deps) !== JSON.stringify(expected)) {
  throw new Error(
    `CLI dependencies must be exactly ${expected.join(", ")}; got ${deps.join(", ")}`,
  );
}
for (const path of [
  "dist/cli.js",
  "dist/model/configure.js",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
])
  if (!existsSync(path)) throw new Error(`Missing CLI artifact: ${path}`);
