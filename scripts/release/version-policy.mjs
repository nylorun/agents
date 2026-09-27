import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import semver from "semver";
import { packageName, packages, root } from "../lib/repo.mjs";

const impact = { none: 0, patch: 1, minor: 2, major: 3 };

/**
 * The packages the creator pins in create-agent/compatibility.json: what a
 * generated project or the examples install (core, agents, cli, admin) and
 * the versions those depend on (harness, runtime). Neither nylorun nor Studio
 * is one: developers run nylorun with npx, and Studio ships only as
 * `ghcr.io/nylorun/studio`, pinned by nylorun (`nylorun/package.json`
 * `nylorun.studio`), so a Studio release reaches developers through nylorun.
 */
export const CREATOR_PINS = Object.freeze([
  "core",
  "harness",
  "agents",
  "admin",
  "runtime",
  "cli",
]);
const fullName = packageName;
const core = (version) => {
  const parsed = semver.parse(version);
  if (!parsed) throw new Error(`Invalid current version: ${version}`);
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
};

/** Breaking bump for D1: minor while 0.x, major after 1.0. */
export function isBreakingBump(type, version) {
  if (!type) return false;
  if (semver.major(core(version)) === 0)
    return type === "minor" || type === "major";
  return type === "major";
}

/**
 * Parse PROTOCOL_VERSION and HOST_PROTOCOL from core compatibility source.
 * Returns undefined when the source does not declare a protocol range yet.
 */
export function parseProtocolConstants(source) {
  const versionMatch = source.match(
    /export\s+const\s+PROTOCOL_VERSION\s*=\s*(\d+)\s*;/,
  );
  if (!versionMatch) return undefined;
  const version = Number(versionMatch[1]);
  const rangeMatch = source.match(
    /export\s+const\s+HOST_PROTOCOL\s*:\s*ProtocolRange\s*=\s*(\{[\s\S]*?\})\s*;/,
  );
  let protocol;
  if (rangeMatch) {
    const block = rangeMatch[1];
    const min = Number(block.match(/\bmin\s*:\s*(\d+)/)?.[1]);
    const max = Number(block.match(/\bmax\s*:\s*(\d+)/)?.[1]);
    const featuresMatch = block.match(/features\s*:\s*(\[[\s\S]*?\]|PROTOCOL_FEATURES)/);
    let features = [];
    if (featuresMatch?.[1] === "PROTOCOL_FEATURES") {
      const list = source.match(
        /export\s+const\s+PROTOCOL_FEATURES\s*=\s*\[([\s\S]*?)\]\s*as\s+const/,
      );
      features = list
        ? [...list[1].matchAll(/"([^"]+)"/g)].map((match) => match[1])
        : [];
    } else if (featuresMatch) {
      features = [...featuresMatch[1].matchAll(/"([^"]+)"/g)].map(
        (match) => match[1],
      );
    }
    if (Number.isInteger(min) && Number.isInteger(max))
      protocol = { min, max, features };
  }
  return {
    version,
    protocol: protocol ?? { min: version, max: version, features: [] },
  };
}

export function protocolEquals(a, b) {
  if (!a || !b) return false;
  return (
    a.version === b.version &&
    a.protocol.min === b.protocol.min &&
    a.protocol.max === b.protocol.max &&
    JSON.stringify([...(a.protocol.features ?? [])].sort()) ===
      JSON.stringify([...(b.protocol.features ?? [])].sort())
  );
}

export function readCurrentProtocol(repo = root) {
  try {
    return parseProtocolConstants(
      readFileSync(join(repo, "core/src/compatibility.ts"), "utf8"),
    );
  } catch {
    return undefined;
  }
}

/** Last released core protocol from the `@nylorun/core@<version>` git tag. */
export function readReleasedProtocol(coreVersion, repo = root) {
  if (!coreVersion || !semver.valid(coreVersion)) return undefined;
  try {
    const source = execFileSync(
      "git",
      ["show", `@nylorun/core@${coreVersion}:core/src/compatibility.ts`],
      { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return parseProtocolConstants(source);
  } catch {
    return undefined;
  }
}

function enforceProtocolReleaseRule(bumps, before, options = {}) {
  const current =
    options.currentProtocol === undefined
      ? readCurrentProtocol(options.repo)
      : options.currentProtocol;
  const released =
    options.releasedProtocol === undefined
      ? readReleasedProtocol(before.core, options.repo)
      : options.releasedProtocol;
  if (!current || !released) return;
  if (protocolEquals(current, released)) return;
  const required = ["core", "runtime", "agents", "cli"];
  const missing = required.filter(
    (name) => !isBreakingBump(bumps.get(name), before[name]),
  );
  if (missing.length === 0) return;
  throw new Error(
    `PROTOCOL_VERSION or HOST_PROTOCOL changed since the last released core (${before.core}); ${missing.join(", ")} must each receive a breaking bump (minor while 0.x, major after 1.0).`,
  );
}

/**
 * Pre-1.0 product branding always uses a `-beta` version suffix.
 * After 1.0, only the npm `beta` channel uses `-beta` (staging before latest).
 * npm channels (`beta` vs `latest`) are independent of that branding.
 */
const suffixFor = (nextCore, channel) => {
  if (semver.major(nextCore) === 0) return "-beta";
  return channel === "beta" ? "-beta" : "";
};

/**
 * Compute final versions once; Changesets applies this exact plan and writes notes.
 * options.currentProtocol / options.releasedProtocol override filesystem/git reads
 * used by the D1 protocol release rule (WS-H 11).
 */
export function planVersions(
  before,
  compatibility,
  pending,
  channel,
  options = {},
) {
  if (!["beta", "latest"].includes(channel))
    throw new Error("Choose --channel beta or --channel latest.");
  for (const name of packages) core(before[name]);
  if (
    !compatibility ||
    Object.keys(compatibility).length !== CREATOR_PINS.length ||
    CREATOR_PINS.some((name) => !semver.valid(compatibility[name]))
  )
    throw new Error(
      `Compatibility must contain exactly the valid creator pins: ${CREATOR_PINS.join(", ")}.`,
    );
  const changesets = [...pending];
  const bumps = new Map();
  for (const changeset of pending) {
    for (const release of changeset.releases) {
      const name = packages.find((name) => fullName(name) === release.name);
      if (!name || !Object.hasOwn(impact, release.type))
        throw new Error(
          `Unsupported changeset release: ${release.name} ${release.type}`,
        );
      // Before 1.0, breaking changes start the next minor series.
      const type =
        release.type === "major" && semver.major(before[name]) === 0
          ? "minor"
          : release.type;
      if (impact[type] > (impact[bumps.get(name)] ?? 0)) bumps.set(name, type);
    }
  }
  enforceProtocolReleaseRule(bumps, before, options);
  const versions = {};
  const bump = (name, type) => {
    const next = semver.inc(core(before[name]), type);
    return next + suffixFor(next, channel);
  };
  for (const name of packages) {
    const type = bumps.get(name);
    if (type) versions[name] = bump(name, type);
    else if (
      channel === "latest" &&
      bumps.size === 0 &&
      semver.prerelease(before[name])
    ) {
      if (semver.major(before[name]) === 0) {
        // Pre-1.0: promote by pointing `latest` at the same x.y.z-beta version.
        // Ignore legacy numbered betas (0.1.0-beta.1); those are not the modern line.
        if (/^\d+\.\d+\.\d+-beta$/.test(before[name]))
          versions[name] = before[name];
      } else {
        // Post-1.0: classic promote strips the prerelease.
        versions[name] = core(before[name]);
      }
    }
  }
  // Release consumers whenever a pinned production dependency changes.
  for (const [dependency, consumers] of [
    ["core", ["harness", "agents", "admin", "runtime", "nylorun"]],
    ["harness", ["runtime"]],
    ["agents", ["studio", "cli"]],
    ["admin", ["cli"]],
    // nylorun pins the Runtime and Studio images (nylorun.runtime, nylorun.studio).
    ["runtime", ["nylorun"]],
    ["studio", ["nylorun"]],
  ]) {
    if (versions[dependency] && versions[dependency] !== before[dependency])
      for (const name of consumers) {
        if (!versions[name]) {
          bumps.set(name, "patch");
          versions[name] = bump(name, "patch");
        }
        changesets.push({
          id: `release-${name}-${dependency}`,
          summary: `Pin ${dependency} to the tested release.`,
          releases: [{ name: fullName(name), type: "patch" }],
        });
      }
  }
  if (!Object.keys(versions).length)
    throw new Error(
      "No pending changesets or beta versions to promote. Add release intent with npm run changeset first.",
    );

  if (packages.some((name) => name !== "create-agent" && versions[name])) {
    if (!versions["create-agent"]) {
      bumps.set("create-agent", "patch");
      versions["create-agent"] = bump("create-agent", "patch");
    }
    changesets.push({
      id: "release-creator-compatibility",
      summary:
        "Update the tested Harness, SDK, Runtime, and CLI compatibility combination.",
      releases: [{ name: fullName("create-agent"), type: "patch" }],
    });
  }
  for (const name of packages) {
    if (versions[name] && !bumps.has(name)) {
      const tagOnly =
        channel === "latest" &&
        versions[name] === before[name] &&
        semver.major(before[name]) === 0;
      changesets.push({
        id: `release-stable-${name}`,
        summary: tagOnly
          ? `Publish the tested ${before[name]} release on the latest dist-tag.`
          : `Promote the tested ${before[name]} release to stable.`,
        releases: [{ name: fullName(name), type: "patch" }],
      });
    }
  }
  const pinned = { ...compatibility };
  const releases = packages
    .filter((name) => versions[name])
    .map((name) => {
      if (semver.lt(versions[name], before[name]))
        throw new Error(
          `Version must not go backward: ${name} ${before[name]} → ${versions[name]}`,
        );
      if (
        versions[name] === before[name] &&
        !(channel === "latest" && semver.major(before[name]) === 0)
      )
        throw new Error(
          `Version must advance: ${name} ${before[name]} → ${versions[name]}`,
        );
      if (
        versions[name] !== before[name] &&
        !semver.gt(versions[name], before[name])
      )
        throw new Error(
          `Version must advance: ${name} ${before[name]} → ${versions[name]}`,
        );
      if (CREATOR_PINS.includes(name)) pinned[name] = versions[name];
      return {
        name: fullName(name),
        type: bumps.get(name) ?? "patch",
        oldVersion: before[name],
        newVersion: versions[name],
        changesets: changesets
          .filter((item) =>
            item.releases.some((release) => release.name === fullName(name)),
          )
          .map((item) => item.id),
      };
    });
  return {
    plan: {
      version: 1,
      channel,
      packages: Object.fromEntries(
        packages
          .filter((name) => versions[name])
          .map((name) => [name, versions[name]]),
      ),
      compatibility: pinned,
    },
    changesets,
    releases,
  };
}
