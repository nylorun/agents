/**
 * Image pins (D7, G3). The CLI runs `ghcr.io/nylorun/runtime:<nylorun.runtime>`
 * and `ghcr.io/nylorun/studio:<nylorun.studio>` from cli/package.json, so each
 * pin must equal the version of the package that the image is built from.
 * The release publishes both images before it publishes the CLI.
 */
import { join } from "node:path";
import { readJson, root, writeJson } from "../lib/repo.mjs";

/** Packages the CLI pins as images, and the image each one is built into. */
export const IMAGES = {
  runtime: "ghcr.io/nylorun/runtime",
  studio: "ghcr.io/nylorun/studio",
};

async function versionOf(repo, name) {
  return (await readJson(join(repo, name, "package.json"))).version;
}

/**
 * Fail when a cli/package.json `nylorun.<name>` pin is missing or disagrees
 * with that package's version. `expected` overrides the version to compare
 * against (the release plan's), which must itself equal the package version.
 */
async function assertCliPin(repo, name, expected) {
  const version = await versionOf(repo, name);
  if (expected !== undefined && expected !== version)
    throw new Error(
      `The release pins ${name} ${expected}, but ${name}/package.json is ${version}.`,
    );
  const cli = await readJson(join(repo, "cli/package.json"));
  const actual = cli.nylorun?.[name];
  if (actual !== version)
    throw new Error(
      `cli/package.json nylorun.${name} (${actual ?? "missing"}) must equal ${name} version (${version}).`,
    );
  return version;
}

export const assertCliRuntimePin = (repo = root, expected) =>
  assertCliPin(repo, "runtime", expected);

export const assertCliStudioPin = (repo = root, expected) =>
  assertCliPin(repo, "studio", expected);

/**
 * Fail when either image pin is missing or disagrees with its package version,
 * or, given a release plan, with the version that plan publishes or keeps.
 */
export async function assertRuntimePins(repo = root, plan) {
  const pinned = (name) =>
    plan ? (plan.packages?.[name] ?? plan.compatibility?.[name]) : undefined;
  return {
    runtime: await assertCliRuntimePin(repo, pinned("runtime")),
    studio: await assertCliStudioPin(repo, pinned("studio")),
  };
}

/**
 * Write cli/package.json `nylorun.runtime` and `nylorun.studio` (D7). Called
 * from release:prepare with the versions the release publishes or keeps.
 */
export async function syncCliPins(repo, { runtime, studio }) {
  if (!runtime || !studio)
    throw new Error("syncCliPins requires runtime and studio versions.");
  const path = join(repo, "cli/package.json");
  const manifest = await readJson(path);
  manifest.nylorun = { ...manifest.nylorun, runtime, studio };
  await writeJson(path, manifest);
  return { runtime, studio };
}

/** A package marked `private` ships only as its image, never to npm. */
export async function isImageOnly(repo, name) {
  return (await readJson(join(repo, name, "package.json"))).private === true;
}

/**
 * Studio ships only as `ghcr.io/nylorun/studio` (Studio §9). Returns whether
 * `@nylorun/studio` is private. With `strict`, a public Studio fails; without
 * it the caller warns, until the Studio package change lands.
 */
export async function assertStudioImageOnly(repo = root, { strict = false } = {}) {
  const imageOnly = await isImageOnly(repo, "studio");
  if (!imageOnly && strict)
    throw new Error(
      'studio/package.json must be "private": true; Studio ships only as the ghcr.io/nylorun/studio image.',
    );
  return imageOnly;
}
