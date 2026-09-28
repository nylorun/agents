import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import semver from "semver";
import applyReleasePlan from "@changesets/apply-release-plan";
import readChangesets from "@changesets/read";
import { readConfig } from "@changesets/config";
import { getPackages } from "@manypkg/get-packages";
import { root, packages, readJson, writeJson, run } from "../lib/repo.mjs";
import { syncImagePins } from "./pins.mjs";
import { CREATOR_PINS, planVersions } from "./version-policy.mjs";

export async function prepareVersions(repo, channel) {
  const workspace = await getPackages(repo);
  // @changesets/config v4 and apply-release-plan@8 both use manypkg v3 graphs (rootDir).
  const { config, errors } = await readConfig(repo);
  if (config == null) {
    throw new Error(
      errors?.length ? errors.join("\n") : "Invalid @changesets/config",
    );
  }
  if (config.fixed.length || config.linked.length || config.ignore.length)
    throw new Error(
      "Release policy requires independently versioned, non-ignored packages.",
    );
  const before = Object.fromEntries(
    await Promise.all(
      packages.map(async (name) => [
        name,
        (await readJson(join(repo, name, "package.json"))).version,
      ]),
    ),
  );
  const compatibility = await readJson(
    join(repo, "create-agent/compatibility.json"),
  );
  let legacy;
  try {
    legacy = await readJson(join(repo, ".changeset/pre.json"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (legacy && (legacy.tag !== "beta" || !Array.isArray(legacy.changesets)))
    throw new Error("Unsupported legacy prerelease state.");
  const allChangesets = await readChangesets(repo);
  const consumed = new Set(legacy?.changesets ?? []);
  const pending = allChangesets.filter((item) => !consumed.has(item.id));
  const calculated = planVersions(before, compatibility, pending, channel);
  const tagOnly = calculated.releases.every(
    (release) => release.oldVersion === release.newVersion,
  );
  if (!tagOnly) {
    await applyReleasePlan(
      {
        changesets: calculated.changesets,
        releases: calculated.releases,
        preState: undefined,
      },
      workspace,
      config,
      undefined,
      // Resolve @changesets/cli/changelog from the repo root when needed.
      root,
    );
    const runtimeManifestPath = join(repo, "runtime/package.json");
    const runtimeManifest = await readJson(runtimeManifestPath);
    if (runtimeManifest.dependencies?.["@nylorun/harness"]) {
      runtimeManifest.dependencies["@nylorun/harness"] =
        calculated.plan.compatibility.harness;
      await writeJson(runtimeManifestPath, runtimeManifest);
    }
    for (const name of packages) {
      const path = join(repo, name, "package.json");
      const manifest = await readJson(path);
      for (const dependency of ["core", "harness", "agents", "runtime"]) {
        if (manifest.dependencies?.[`@nylorun/${dependency}`])
          manifest.dependencies[`@nylorun/${dependency}`] =
            calculated.plan.compatibility[dependency];
      }
      await writeJson(path, manifest);
    }
    // Numbered prerelease state is retired; already-applied changes must not replay.
    if (legacy) {
      for (const item of allChangesets.filter((item) => consumed.has(item.id)))
        await rm(join(repo, ".changeset", `${item.id}.md`));
      await rm(join(repo, ".changeset/pre.json"));
    }
    await writeJson(
      join(repo, "create-agent/compatibility.json"),
      calculated.plan.compatibility,
    );
    // Runtime advertises its package version via RUNTIME_VERSION; CLI refuses mismatched hosts.
    const runtimeVersion = calculated.plan.packages.runtime;
    if (runtimeVersion) {
      const versionPath = join(repo, "runtime/src/version.ts");
      const current = await readFile(versionPath, "utf8");
      const next = current.replace(
        /export const RUNTIME_VERSION = "[^"]+";/,
        `export const RUNTIME_VERSION = "${runtimeVersion}";`,
      );
      if (next === current)
        throw new Error(
          `Could not update RUNTIME_VERSION to ${runtimeVersion} in runtime/src/version.ts`,
        );
      await writeFile(versionPath, next);
    }
  } else if (legacy) {
    throw new Error(
      "Clear legacy prerelease state before a latest dist-tag promotion.",
    );
  }
  // D7: nylorun's image pins (nylorun.runtime, nylorun.studio) equal the
  // tested Runtime and Studio: the version this plan publishes, or keeps.
  const pin = (name) => calculated.plan.packages[name] ?? before[name];
  await syncImagePins(repo, { runtime: pin("runtime"), studio: pin("studio") });
  await validatePlan(calculated.plan, repo);
  for (const [name, version] of Object.entries(calculated.plan.packages))
    await releaseNotes(repo, name, version);
  return calculated.plan;
}

export async function validatePlan(plan, repo) {
  if (
    plan?.version !== 1 ||
    !["beta", "latest"].includes(plan.channel) ||
    !plan.packages ||
    !Object.keys(plan.packages).length
  )
    throw new Error("Invalid release plan.");
  if (!plan.packages["create-agent"])
    throw new Error("Every release must include create-agent.");
  for (const [name, version] of Object.entries(plan.packages)) {
    if (
      !packages.includes(name) ||
      typeof version !== "string" ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-beta)?$/.test(version) ||
      !semver.valid(version)
    )
      throw new Error(`Invalid release package/version: ${name}`);
    const prerelease = semver.prerelease(version);
    if (plan.channel === "beta") {
      if (prerelease?.length !== 1 || prerelease[0] !== "beta")
        throw new Error(
          `Version ${version} does not match channel ${plan.channel}.`,
        );
    } else if (plan.channel === "latest") {
      // Pre-1.0 latest keeps *-beta product branding; post-1.0 latest is stable.
      if (semver.major(version) === 0) {
        if (prerelease?.length !== 1 || prerelease[0] !== "beta")
          throw new Error(
            `Pre-1.0 latest versions must use the -beta product suffix: ${version}`,
          );
      } else if (prerelease) {
        throw new Error(
          `Version ${version} does not match channel ${plan.channel}.`,
        );
      }
    }
    if ((await readJson(join(repo, name, "package.json"))).version !== version)
      throw new Error(`Release version differs from ${name}/package.json.`);
  }
  const actual = await readJson(join(repo, "create-agent/compatibility.json"));
  for (const name of CREATOR_PINS) {
    const version = plan.compatibility?.[name];
    if (
      !semver.valid(version) ||
      actual[name] !== version ||
      (plan.packages[name] && plan.packages[name] !== version)
    )
      throw new Error(`Invalid compatibility pin for ${name}.`);
  }
  for (const name of packages) {
    const manifest = await readJson(join(repo, name, "package.json"));
    for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
      if (dependency.startsWith("@nylorun/") && version !== plan.compatibility[dependency.slice(9)])
        throw new Error(`${name}'s ${dependency} dependency must match its compatibility pin.`);
    }
  }
  if (Object.keys(plan.compatibility).length !== CREATOR_PINS.length)
    throw new Error(
      `Compatibility must contain exactly the creator pins: ${CREATOR_PINS.join(", ")}.`,
    );
}

export async function releaseNotes(repo, name, version) {
  const lines = (
    await readFile(join(repo, name, "CHANGELOG.md"), "utf8")
  ).split("\n");
  const start = lines.findIndex(
    (line) => line === `## ${version}` || line.startsWith(`## [${version}]`),
  );
  if (start === -1)
    throw new Error(`Missing changelog entry for ${name}@${version}.`);
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith("## ")) end++;
  return lines.slice(start, end).join("\n").trim();
}

/**
 * Registry boundary: retries may skip only byte-identical completed publications.
 *
 * Publish the engines back to back and wait for them together, then the
 * creator, which is never published before its pins exist. Image-only
 * packages (artifact `image: true`, e.g. a private Studio) are never
 * published to npm; the release workflow pushed their images before this.
 *
 * A channel tag the registry client cannot move (an error carrying
 * `distTagCommand`: npm trusted publishing publishes versions but cannot edit
 * tags, so every promotion of published versions hits this) does not stop the
 * release: every package is tried, then one error names the single command an
 * npm administrator runs for all of them.
 */
export async function publishCandidates(
  plan,
  artifacts,
  registry,
  report = () => {},
) {
  const imageOnly = (name) => artifacts[name]?.image === true;
  for (const name of packages.filter((name) => plan.packages[name] && imageOnly(name)))
    report(`${name}@${plan.packages[name]}: image only, not published to npm`);
  const names = packages.filter(
    (name) => plan.packages[name] && !imageOnly(name),
  );
  await Promise.all(
    names.map((name) =>
      registry.checkTag(name, plan.packages[name], plan.channel),
    ),
  );
  for (const name of names)
    if (!artifacts[name]?.integrity)
      throw new Error(`Missing verified artifact for ${name}.`);
  const engines = names.filter((name) => name !== "create-agent");
  const untagged = await publishWave(engines, plan, artifacts, registry, report);
  if (names.includes("create-agent")) {
    for (const engine of CREATOR_PINS) {
      if (imageOnly(engine)) continue;
      if (!(await registry.lookup(engine, plan.compatibility[engine])))
        throw new Error(
          `Creator pin is unavailable: ${engine}@${plan.compatibility[engine]}`,
        );
    }
    untagged.push(
      ...(await publishWave(["create-agent"], plan, artifacts, registry, report)),
    );
  }
  if (untagged.length)
    throw new Error(
      `Published, but the ${plan.channel} tag of ${untagged.length} package(s) could not be moved ` +
        `(npm trusted publishing cannot edit tags of published versions). An npm administrator runs, ` +
        `after npm login:\n  ${untagged.join(" && ")}\nthen reruns this job, which skips the tags ` +
        `and finishes the release.`,
    );
}

async function publishWave(names, plan, artifacts, registry, report) {
  const pending = [];
  for (const name of names) {
    const artifact = artifacts[name];
    const version = plan.packages[name];
    const published = await registry.lookup(name, version);
    if (published) {
      if (published.integrity !== artifact.integrity)
        throw new Error(`Published integrity conflict for ${name}@${version}.`);
      report(`${name}@${version}: already published with matching integrity`);
    } else {
      await registry.publish(name, artifact.path, plan.channel);
      pending.push(name);
    }
  }
  await Promise.all(
    pending.map(async (name) => {
      const version = plan.packages[name];
      const verified = await registry.waitFor(name, version);
      if (verified?.integrity !== artifacts[name].integrity)
        throw new Error(`Registry verification failed for ${name}@${version}.`);
      report(`${name}@${version}: published and verified`);
    }),
  );
  const tagged = await Promise.allSettled(
    names.map((name) =>
      registry.ensureTag(name, plan.packages[name], plan.channel),
    ),
  );
  const untagged = [];
  for (const result of tagged) {
    if (result.status === "fulfilled") continue;
    if (!result.reason?.distTagCommand) throw result.reason;
    untagged.push(result.reason.distTagCommand);
  }
  return untagged;
}

export async function verifyReleaseCommit(repo, sha) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? ""))
    throw new Error("Release requires a full lowercase commit SHA.");
  await run("git", ["merge-base", "--is-ancestor", sha, "origin/main"], {
    cwd: repo,
    capture: true,
  });
  const head = await run("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    capture: true,
  });
  if (head !== sha)
    throw new Error("Checkout does not match the requested release commit.");
  const planPath = ".release/plan.json";
  const diff = await run(
    "git",
    ["diff", "--name-only", `${sha}^`, sha, "--", planPath],
    { cwd: repo, capture: true },
  );
  if (!diff) {
    // Allow a main tip that still carries the prepared plan unchanged so a
    // smoke/script fix can finish publish without bumping package versions.
    const prior = await run(
      "git",
      ["log", "-1", "--format=%H", `${sha}^`, "--", planPath],
      { cwd: repo, capture: true },
    );
    if (!prior)
      throw new Error(
        "The selected commit must introduce or update the release plan.",
      );
    const [current, prepared] = await Promise.all([
      run("git", ["show", `${sha}:${planPath}`], {
        cwd: repo,
        capture: true,
      }),
      run("git", ["show", `${prior}:${planPath}`], {
        cwd: repo,
        capture: true,
      }),
    ]);
    if (current !== prepared)
      throw new Error(
        "The selected commit must introduce or update the release plan.",
      );
  }
  await readFile(join(repo, planPath));
}
