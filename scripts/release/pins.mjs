/**
 * Image pins (D7, G3). `nylorun start` runs `ghcr.io/nylorun/runtime:<nylorun.runtime>`
 * and `ghcr.io/nylorun/studio:<nylorun.studio>` from nylorun/package.json, so
 * each pin must equal the version of the package that the image is built from.
 * The release publishes both images before it publishes nylorun.
 */
import { join } from "node:path";
import { readJson, root, writeJson } from "../lib/repo.mjs";

/**
 * Images the release publishes: one per package nylorun pins (runtime, studio), and
 * images versioned with one of them (`VERSIONED_WITH`).
 */
export const IMAGES = {
  runtime: "ghcr.io/nylorun/runtime",
  studio: "ghcr.io/nylorun/studio",
  sandboxes: "ghcr.io/nylorun/sandboxes",
};

/**
 * The sandboxes service (`sandboxes/`, Go) has no package of its own: its image takes the
 * Runtime's version, is built when the release ships a new Runtime, and nylorun runs
 * `ghcr.io/nylorun/sandboxes:<nylorun.runtime>`.
 */
export const VERSIONED_WITH = { sandboxes: "runtime" };

async function versionOf(repo, name) {
  return (await readJson(join(repo, name, "package.json"))).version;
}

/**
 * Fail when a nylorun/package.json `nylorun.<name>` pin is missing or disagrees
 * with that package's version. `expected` overrides the version to compare
 * against (the release plan's), which must itself equal the package version.
 */
async function assertImagePin(repo, name, expected) {
  const version = await versionOf(repo, name);
  if (expected !== undefined && expected !== version)
    throw new Error(
      `The release pins ${name} ${expected}, but ${name}/package.json is ${version}.`,
    );
  const manifest = await readJson(join(repo, "nylorun/package.json"));
  const actual = manifest.nylorun?.[name];
  if (actual !== version)
    throw new Error(
      `nylorun/package.json nylorun.${name} (${actual ?? "missing"}) must equal ${name} version (${version}).`,
    );
  return version;
}

export const assertRuntimeImagePin = (repo = root, expected) =>
  assertImagePin(repo, "runtime", expected);

export const assertStudioImagePin = (repo = root, expected) =>
  assertImagePin(repo, "studio", expected);

/**
 * Fail when either image pin is missing or disagrees with its package version,
 * or, given a release plan, with the version that plan publishes or keeps.
 */
export async function assertRuntimePins(repo = root, plan) {
  const pinned = (name) =>
    plan ? (plan.packages?.[name] ?? plan.compatibility?.[name]) : undefined;
  return {
    runtime: await assertRuntimeImagePin(repo, pinned("runtime")),
    studio: await assertStudioImagePin(repo, pinned("studio")),
  };
}

/**
 * Write nylorun/package.json `nylorun.runtime` and `nylorun.studio` (D7). Called
 * from release:prepare with the versions the release publishes or keeps.
 */
export async function syncImagePins(repo, { runtime, studio }) {
  if (!runtime || !studio)
    throw new Error("syncImagePins requires runtime and studio versions.");
  const path = join(repo, "nylorun/package.json");
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
 * Studio ships only as `ghcr.io/nylorun/studio` (Studio §9), so a public
 * `@nylorun/studio` fails: it would publish Studio to npm again.
 */
export async function assertStudioImageOnly(repo = root) {
  if (!(await isImageOnly(repo, "studio")))
    throw new Error(
      'studio/package.json must be "private": true; Studio ships only as the ghcr.io/nylorun/studio image.',
    );
}
