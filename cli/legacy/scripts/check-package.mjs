import { readFileSync, existsSync } from "node:fs";
import { checkBoundaries } from "../../../scripts/check-boundaries.mjs";
checkBoundaries("cli");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (pkg.bin?.nylo !== "dist/cli.js")
  throw new Error("Missing nylo binary");
// nylorun owns the `nylorun` command, the image pins and `nylo`'s code: this deprecated package
// only runs nylorun's `nylo`.
if (pkg.bin?.nylorun !== undefined || pkg.nylorun !== undefined)
  throw new Error("The CLI must not declare the nylorun binary or image pins");
const deps = Object.keys(pkg.dependencies ?? {});
if (JSON.stringify(deps) !== JSON.stringify(["nylorun"]))
  throw new Error(`The CLI must depend on nylorun only; got ${deps.join(", ")}`);
const nylorun = JSON.parse(readFileSync("../nylorun/package.json", "utf8"));
if (pkg.dependencies.nylorun !== nylorun.version)
  throw new Error(
    `The CLI must pin this release's nylorun (${nylorun.version}); got ${pkg.dependencies.nylorun}`,
  );
for (const path of ["dist/cli.js", "README.md", "LICENSE", "CHANGELOG.md"])
  if (!existsSync(path)) throw new Error(`Missing CLI artifact: ${path}`);
