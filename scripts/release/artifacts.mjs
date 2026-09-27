import { mkdir, readFile, rm } from "node:fs/promises";
import { join, basename, resolve } from "node:path";
import { createHash } from "node:crypto";
import { root, packages, npm, readJson, writeJson } from "../lib/repo.mjs";
import { validatePlan } from "./model.mjs";
import { isImageOnly } from "./pins.mjs";

export const integrity = async (path) =>
  `sha512-${createHash("sha512")
    .update(await readFile(path))
    .digest("base64")}`;
/**
 * The version of `name` a release ships: the one it publishes, else its
 * creator pin, else (a kept package the creator does not pin, e.g. Studio)
 * the checkout's version, which the CLI's image pin was checked against.
 */
export async function shippedVersion(plan, name, repo = root) {
  return (
    plan.packages[name] ??
    plan.compatibility[name] ??
    (await readJson(join(repo, name, "package.json"))).version
  );
}
export async function packRelease(directory, plan, repo = root) {
  await validatePlan(plan, repo);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const artifacts = {};
  for (const name of packages) {
    const version = await shippedVersion(plan, name, repo);
    const candidate = Boolean(plan.packages[name]);
    // A private package ships only as its image; there is no tarball.
    if (await isImageOnly(repo, name)) {
      artifacts[name] = { image: true, version, candidate };
      continue;
    }
    const result = JSON.parse(
      await npm(
        [
          "pack",
          ...(candidate ? [] : [`@nylorun/${name}@${version}`]),
          "--json",
          "--ignore-scripts",
          "--pack-destination",
          directory,
        ],
        { cwd: candidate ? join(repo, name) : directory, capture: true },
      ),
    )[0];
    if (result.name !== `@nylorun/${name}` || result.version !== version)
      throw new Error(`Unexpected tarball identity for ${name}.`);
    const file = basename(result.filename);
    const hash = await integrity(join(directory, file));
    if (hash !== result.integrity)
      throw new Error(`Tarball integrity mismatch for ${name}.`);
    artifacts[name] = { file, integrity: hash, version, candidate };
  }
  await writeJson(join(directory, "artifacts.json"), { plan, artifacts });
  return artifacts;
}
export async function readArtifacts(directory, plan, repo = root) {
  const saved = await readJson(join(directory, "artifacts.json"));
  if (JSON.stringify(saved.plan) !== JSON.stringify(plan))
    throw new Error("Artifacts do not match the reviewed release plan.");
  const artifacts = {};
  for (const name of packages) {
    const artifact = saved.artifacts[name];
    const version = await shippedVersion(plan, name, repo);
    if (!artifact || artifact.version !== version)
      throw new Error(`Invalid artifact for ${name}.`);
    // The checkout, not the saved file, decides what skips npm.
    const imageOnly = await isImageOnly(repo, name);
    if (Boolean(artifact.image) !== imageOnly)
      throw new Error(`Invalid artifact for ${name}.`);
    if (imageOnly) {
      artifacts[name] = { image: true, version, candidate: artifact.candidate };
      continue;
    }
    if (artifact.file !== basename(artifact.file))
      throw new Error(`Invalid artifact for ${name}.`);
    const path = resolve(directory, artifact.file);
    if ((await integrity(path)) !== artifact.integrity)
      throw new Error(`Artifact was modified: ${name}.`);
    artifacts[name] = { ...artifact, path };
  }
  return artifacts;
}
