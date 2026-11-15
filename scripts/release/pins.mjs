/**
 * Image pins (D7, G3). `nylorun start` runs `ghcr.io/nylorun/runtime:<nylorun.runtime>`
 * and `ghcr.io/nylorun/studio:<nylorun.studio>` from cli/nylorun/package.json, so
 * each pin must equal the version of the package that the image is built from.
 * The release publishes both images before it publishes nylorun.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { packagePath, readJson, root, writeJson } from "../lib/repo.mjs";

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
  return (await readJson(join(repo, packagePath(name), "package.json"))).version;
}

/**
 * Fail when a cli/nylorun/package.json `nylorun.<name>` pin is missing or disagrees
 * with that package's version. `expected` overrides the version to compare
 * against (the release plan's), which must itself equal the package version.
 */
async function assertImagePin(repo, name, expected) {
  const version = await versionOf(repo, name);
  if (expected !== undefined && expected !== version)
    throw new Error(
      `The release pins ${name} ${expected}, but ${name}/package.json is ${version}.`,
    );
  const manifest = await readJson(join(repo, "cli/nylorun/package.json"));
  const actual = manifest.nylorun?.[name];
  if (actual !== version)
    throw new Error(
      `cli/nylorun/package.json nylorun.${name} (${actual ?? "missing"}) must equal ${name} version (${version}).`,
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
  const pins = {
    runtime: await assertRuntimeImagePin(repo, pinned("runtime")),
    studio: await assertStudioImagePin(repo, pinned("studio")),
  };
  await assertChartPins(repo, pins);
  return pins;
}

/**
 * The Runtime's Helm chart (charts/nylorun-runtime) runs the same images: its version and
 * appVersion are the Runtime's (the runtime and sandboxes tags), and its annotation
 * `nylorun.com/studio-version` is Studio's tag.
 */
export const CHART = "charts/nylorun-runtime/Chart.yaml";
const STUDIO_ANNOTATION = "nylorun.com/studio-version";

async function readChart(repo) {
  try {
    return await readFile(join(repo, CHART), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function chartPins(text) {
  const field = (re) => text.match(re)?.[1].replace(/^"|"$/g, "");
  return {
    version: field(/^version:\s*(\S+)\s*$/m),
    appVersion: field(/^appVersion:\s*(\S+)\s*$/m),
    studio: field(new RegExp(`^\\s+${STUDIO_ANNOTATION.replace(".", "\\.")}:\\s*(\\S+)\\s*$`, "m")),
  };
}

/** Fail when the chart's versions disagree with the Runtime and Studio pins. */
export async function assertChartPins(repo, { runtime, studio }) {
  const text = await readChart(repo);
  if (text === undefined) return;
  const actual = chartPins(text);
  const expected = { version: runtime, appVersion: runtime, studio };
  for (const key of Object.keys(expected))
    if (actual[key] !== expected[key])
      throw new Error(
        `${CHART} ${key === "studio" ? STUDIO_ANNOTATION : key} (${actual[key] ?? "missing"}) must equal ${expected[key]}.`,
      );
}

/** Write the chart's version, appVersion and Studio annotation (release:prepare). */
export async function syncChartPins(repo, { runtime, studio }) {
  let text = await readChart(repo);
  if (text === undefined) return;
  text = text
    .replace(/^version:.*$/m, `version: ${runtime}`)
    .replace(/^appVersion:.*$/m, `appVersion: ${runtime}`);
  const line = `  ${STUDIO_ANNOTATION}: "${studio}"`;
  const existing = new RegExp(`^\\s+${STUDIO_ANNOTATION.replace(".", "\\.")}:.*$`, "m");
  if (existing.test(text)) text = text.replace(existing, line);
  else if (/^annotations:\s*$/m.test(text)) text = text.replace(/^annotations:\s*$/m, `annotations:\n${line}`);
  else text = `${text.trimEnd()}\nannotations:\n${line}\n`;
  await writeFile(join(repo, CHART), text);
}

/**
 * Write cli/nylorun/package.json `nylorun.runtime` and `nylorun.studio` (D7), and the
 * chart's versions (`syncChartPins`). Called
 * from release:prepare with the versions the release publishes or keeps.
 */
export async function syncImagePins(repo, { runtime, studio }) {
  if (!runtime || !studio)
    throw new Error("syncImagePins requires runtime and studio versions.");
  const path = join(repo, "cli/nylorun/package.json");
  const manifest = await readJson(path);
  manifest.nylorun = { ...manifest.nylorun, runtime, studio };
  await writeJson(path, manifest);
  await syncChartPins(repo, { runtime, studio });
  return { runtime, studio };
}

/** A package marked `private` ships only as its image, never to npm. */
export async function isImageOnly(repo, name) {
  return (await readJson(join(repo, packagePath(name), "package.json"))).private === true;
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
