import { readFileSync, existsSync } from "node:fs";
import { checkBoundaries } from "../../../scripts/check-boundaries.mjs";
checkBoundaries("cli");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
// One binary, so `npx @nylorun/cli <command>` resolves it: nylorun's `nylorun` under this name.
if (JSON.stringify(pkg.bin) !== JSON.stringify({ nylorun: "dist/cli.js" }))
  throw new Error("The CLI must declare the nylorun binary only");
// nylorun owns the image pins and the command's code: this package only runs nylorun's `nylorun`.
if (pkg.nylorun !== undefined)
  throw new Error("The CLI must not declare image pins");
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
