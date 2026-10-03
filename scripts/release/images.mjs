/**
 * Decide whether the release workflow pushes one image:
 *
 *   node scripts/release/images.mjs runtime|studio|sandboxes
 *
 * Writes `image`, `version`, `tag` and `push` to $GITHUB_OUTPUT. An image tag
 * is never replaced: when `ghcr.io/nylorun/<name>:<version>` exists, `push` is
 * false and the job skips the build, so reruns are idempotent. A missing image
 * for a version this release keeps (not in the plan's packages) fails: this
 * commit did not produce that version, so it must not build its image.
 *
 * Uses only Node built-ins and `docker`; the job runs it before `npm ci`.
 */
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readJson, root, run } from "../lib/repo.mjs";
import { IMAGES, VERSIONED_WITH, assertRuntimePins } from "./pins.mjs";

/**
 * The image this release needs for package `name`, and whether to push it.
 * `exists(tag)` reports whether the registry already has that tag.
 */
export async function imageRelease(repo, plan, name, exists) {
  const image = IMAGES[name];
  if (!image)
    throw new Error(
      `No image for ${name}; expected one of ${Object.keys(IMAGES).join(", ")}.`,
    );
  // Both pins name the versions this plan ships (as release:check verified).
  const pins = await assertRuntimePins(repo, plan);
  // sandboxes takes the Runtime's version, and is built when the Runtime is.
  const source = VERSIONED_WITH[name] ?? name;
  const version = pins[source];
  const tag = `${image}:${version}`;
  const candidate = Boolean(plan.packages?.[source]);
  if (await exists(tag))
    return { image, version, tag, candidate, push: false };
  if (!candidate)
    throw new Error(
      `${tag} does not exist, and this release keeps ${name} at ${version} without building it. Release a new ${name} version so this release builds its image.`,
    );
  return { image, version, tag, candidate, push: true };
}

/** Whether the registry has `tag`. Uses the job's `docker login` credentials. */
export async function registryHas(tag, runCommand = run) {
  try {
    await runCommand("docker", ["buildx", "imagetools", "inspect", tag], {
      capture: true,
    });
    return true;
  } catch (error) {
    // GHCR answers "denied" for a package that does not exist yet. A denied
    // package that does exist fails the push instead, so no tag is replaced.
    const output = `${error.stderr ?? ""}\n${error.message ?? ""}`;
    if (/not found|manifest unknown|name unknown|denied/i.test(output))
      return false;
    throw error;
  }
}

async function main() {
  const [name, ...extra] = process.argv.slice(2);
  if (!name || extra.length)
    throw new Error("Usage: node scripts/release/images.mjs runtime|studio|sandboxes");
  const plan = await readJson(join(root, ".release/plan.json"));
  const result = await imageRelease(root, plan, name, (tag) => registryHas(tag));
  const message = result.push
    ? `${result.tag}: building and pushing`
    : `${result.tag}: already published; skipping the build`;
  console.log(message);
  if (process.env.GITHUB_OUTPUT)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `image=${result.image}\nversion=${result.version}\ntag=${result.tag}\npush=${result.push}\n`,
    );
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `- ${message}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
