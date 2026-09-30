/**
 * Writes the Runtime's OpenAPI documents into `dist/` after `tsc` (`dist/openapi.json`, the
 * Tenant API; `dist/admin-openapi.json`, the Admin API), from the routes as built
 * (`dist/api/openapi.js`).
 *
 *   node scripts/build-openapi.mjs            write dist/
 *   node scripts/build-openapi.mjs --write    and update the snapshots in openapi/
 *   node scripts/build-openapi.mjs --check    and fail if they differ from the snapshots
 *
 * The snapshots are committed, so a change to the API shows as a diff of them. Their
 * `info.version` is `0.0.0`: a release's version bump is not an API change.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const mode = process.argv[2];
if (mode !== undefined && mode !== "--write" && mode !== "--check")
  throw new Error("Usage: build-openapi.mjs [--write|--check]");

const { tenantDocument, adminDocument } = await import(new URL("dist/api/openapi.js", root).href);
const documents = { "openapi.json": tenantDocument(), "admin-openapi.json": adminDocument() };
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

const stale = [];
for (const [name, document] of Object.entries(documents)) {
  writeFileSync(new URL(`dist/${name}`, root), json(document));
  const snapshot = json({ ...document, info: { ...document.info, version: "0.0.0" } });
  const path = new URL(`openapi/${name}`, root);
  if (mode === "--write") {
    mkdirSync(new URL("openapi/", root), { recursive: true });
    writeFileSync(path, snapshot);
  } else if (mode === "--check") {
    let committed;
    try {
      committed = readFileSync(path, "utf8");
    } catch {
      committed = undefined;
    }
    if (committed !== snapshot) stale.push(`openapi/${name}`);
  }
}
if (stale.length > 0) {
  console.error(
    `The API changed: ${stale.join(", ")} differ from the routes. Run node scripts/build-openapi.mjs --write in runtime/ and commit the result.`,
  );
  process.exitCode = 1;
} else if (mode === "--check") console.log("OpenAPI documents match openapi/.");
