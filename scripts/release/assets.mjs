import { join } from "node:path";
import { run } from "../lib/repo.mjs";

/**
 * Files a package's GitHub Release carries beside its notes, from the package's `dist/`: the
 * Runtime's OpenAPI document, for tools that read an API description from a release (API
 * reference renderers such as Scalar).
 */
export const RELEASE_ASSETS = {
  runtime: ["openapi.json"],
};

/** The assets `name`'s release should carry that `existing` (their names) lacks. */
export function missingAssets(name, existing) {
  return (RELEASE_ASSETS[name] ?? []).filter((asset) => !existing.includes(asset));
}

/**
 * Extracts `assets` from the package tarball npm published (`package/dist/<asset>`) into
 * `directory`, so a release carries exactly what the package ships. Returns their paths.
 */
export async function extractAssets(tarball, assets, directory, runner = run) {
  await runner("tar", [
    "-xzf",
    tarball,
    "-C",
    directory,
    ...assets.map((asset) => `package/dist/${asset}`),
  ]);
  return assets.map((asset) => join(directory, "package", "dist", asset));
}

/**
 * Uploads the assets `tag`'s release lacks, from `tarball`. Never replaces one: a release is
 * as immutable as its tag, so a rerun, or a promotion of the same version to another npm
 * channel, uploads only what is missing. Returns what it uploaded.
 */
export async function uploadReleaseAssets({ name, tag, tarball, directory, runner = run }) {
  if (!RELEASE_ASSETS[name]) return [];
  const release = JSON.parse(
    await runner("gh", ["release", "view", tag, "--json", "assets"], { capture: true }),
  );
  const missing = missingAssets(
    name,
    release.assets.map((asset) => asset.name),
  );
  if (missing.length === 0) return [];
  const paths = await extractAssets(tarball, missing, directory, runner);
  await runner("gh", ["release", "upload", tag, ...paths]);
  return missing;
}
