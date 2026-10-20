import { readFileSync } from "node:fs";
import { checkBoundaries } from "../../scripts/check-boundaries.mjs";
checkBoundaries("core");
const definition = await import("@nylorun/core/define");
const root = await import("@nylorun/core");
if ("Agent" in root || "run" in root)
  throw new Error("Core root only exposes contracts and types");
const agent = definition
  .Agent({ id: "package-check", name: "Package check" })
  .build();
if (Object.keys(agent).includes("getBinding"))
  throw new Error("Binding must not serialize");
if (agent.getBinding().manifest !== agent.manifest)
  throw new Error("Binding identity differs");
// Each ./schemas/*.json export is built, and names its $id on docs.nylorun.com, where the docs
// site publishes it (nylorun/web, docs-site/scripts/sync-schemas.mjs).
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
for (const [name, file] of Object.entries(pkg.exports)) {
  if (!/^\.\/schemas\/[^/]+\.json$/.test(name)) continue;
  const schema = JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
  if (typeof schema.$id !== "string" || !schema.$id.startsWith("https://docs.nylorun.com/schemas/"))
    throw new Error(`${name}: $id ${schema.$id} is not under https://docs.nylorun.com/schemas/`);
}
