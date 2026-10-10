#!/usr/bin/env node
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// @nylorun/cli is deprecated: `nylo` ships in nylorun. This runs nylorun's `nylo` with the same
// arguments, after one line on stderr, so `eval "$(npx @nylorun/cli env)"` keeps a clean stdout.
process.stderr.write(
  "@nylorun/cli is deprecated: nylo ships in nylorun. Use npx -p nylorun nylo, or install nylorun.\n",
);
const require = createRequire(import.meta.url);
const manifest = require.resolve("nylorun/package.json");
const { bin } = require(manifest) as { bin: { nylo: string } };
await import(pathToFileURL(join(dirname(manifest), bin.nylo)).href);
