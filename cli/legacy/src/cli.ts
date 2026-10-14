#!/usr/bin/env node
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// @nylorun/cli is deprecated: `nylo` is part of nylorun. This runs nylorun's `nylo` with the same
// arguments, after one line on stderr; it names the nylorun command that replaced each of its own.
process.stderr.write("@nylorun/cli is deprecated: nylo is part of nylorun. Run npx nylorun --help.\n");
const require = createRequire(import.meta.url);
const manifest = require.resolve("nylorun/package.json");
const { bin } = require(manifest) as { bin: { nylo: string } };
await import(pathToFileURL(join(dirname(manifest), bin.nylo)).href);
