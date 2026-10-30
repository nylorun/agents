#!/usr/bin/env node
/**
 * Bundles the pod's engine (dist/host/harness-entry.js) into one ESM script for the Runtime image's
 * /engine (ADR-92 §5). Native addons and optional modules stay outside: the image copies the one
 * the engine loads (@mongodb-js/zstd) beside the script, and node-liblzma is loaded inside a try.
 *
 *   node scripts/bundle-harness.mjs <out dir>
 */
import { build } from "esbuild";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const out = process.argv[2];
if (!out) throw new Error("usage: bundle-harness.mjs <out dir>");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const result = await build({
  entryPoints: [join(root, "dist/host/harness-entry.js")],
  outfile: join(resolve(out), "harness.mjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  // CommonJS dependencies call require(); give the bundle one.
  banner: { js: "import { createRequire as __nylorunRequire } from 'node:module'; const require = __nylorunRequire(import.meta.url);" },
  external: ["*.node", "@mongodb-js/zstd", "node-liblzma"],
  logLevel: "warning",
  metafile: true,
});
const inputs = Object.keys(result.metafile.inputs).length;
const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
console.log(`Bundled the pod's engine: ${inputs} modules into ${(bytes / 2 ** 20).toFixed(1)} MiB`);
