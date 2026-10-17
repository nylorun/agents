#!/usr/bin/env node
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// @nylorun/cli is nylorun under another name: this runs nylorun's `nylorun` command with the
// same arguments, so `npx @nylorun/cli <command>` is `npx nylorun <command>`.
const require = createRequire(import.meta.url);
const manifest = require.resolve("nylorun/package.json");
const { bin } = require(manifest) as { bin: { nylorun: string } };
await import(pathToFileURL(join(dirname(manifest), bin.nylorun)).href);
