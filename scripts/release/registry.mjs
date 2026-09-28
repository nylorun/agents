import semver from "semver";
import { setTimeout as sleep } from "node:timers/promises";
import { npm, packageName } from "../lib/repo.mjs";

const REGISTRY = "https://registry.npmjs.org/";
const INSTALL_ACCEPT =
  "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*";

/**
 * The package document, bypassing the registry CDN (`?write=true`, as npm's own
 * write commands read it). `npm view` can serve a copy cached before this run
 * published, which hid each new version for minutes. With `install`, the
 * abbreviated document `npm install` reads, through the CDN.
 */
async function document(name, { install = false } = {}) {
  const url = new URL(
    `${encodeURIComponent(packageName(name))}${install ? "" : "?write=true"}`,
    REGISTRY,
  );
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { accept: install ? INSTALL_ACCEPT : "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 404) return undefined;
      if (!response.ok)
        throw new Error(`GET ${url} returned ${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt === 3) throw error;
      await sleep(2000);
    }
  }
}

export const registry = {
  async checkTag(name, version, channel) {
    const tags = (await document(name))?.["dist-tags"] ?? {};
    if (tags[channel] && semver.gt(tags[channel], version))
      throw new Error(
        `Refusing to move ${name}'s ${channel} tag backward from ${tags[channel]} to ${version}.`,
      );
  },
  async lookup(name, version) {
    const dist = (await document(name))?.versions?.[version]?.dist;
    return dist ? { integrity: dist.integrity } : undefined;
  },
  async installable(name, version) {
    return Boolean(
      (await document(name, { install: true }))?.versions?.[version],
    );
  },
  async publish(_name, path, channel) {
    await npm([
      "publish",
      path,
      "--access",
      "public",
      "--tag",
      channel,
      "--provenance",
      "--ignore-scripts",
    ]);
  },
  async waitFor(name, version, { sleep: pause = sleep } = {}) {
    // The registry usually lists an accepted publish within seconds; allow minutes.
    for (let attempt = 0; attempt < 120; attempt++) {
      const value = await this.lookup(name, version);
      if (value) return value;
      await pause(5000);
    }
    throw new Error(
      `Registry has not exposed ${name}@${version}; retry this release later.`,
    );
  },
  // `npm install` from a clean cache can miss a version waitFor already saw:
  // the CDN served create-agent's older document a minute after publication.
  async waitForInstall(name, version, { sleep: pause = sleep } = {}) {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (await this.installable(name, version)) return;
      await pause(5000);
    }
    throw new Error(
      `npm install does not see ${name}@${version} yet; rerun this workflow for the same commit.`,
    );
  },
  async ensureTag(name, version, channel, { sleep: pause = sleep } = {}) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const tags = (await document(name))?.["dist-tags"] ?? {};
      if (tags[channel] === version) return;
      if (tags[channel] && semver.gt(tags[channel], version))
        throw new Error(
          `Refusing to move ${name}'s ${channel} tag backward from ${tags[channel]} to ${version}.`,
        );
      // First publish sets the tag via `npm publish --tag`. Retagging an already
      // published version (e.g. promote beta → latest) needs dist-tag add, which
      // requires a classic npm token (OIDC covers publish, not tag edits).
      if (attempt === 0 || attempt === 4) {
        try {
          await npm(
            ["dist-tag", "add", `${packageName(name)}@${version}`, channel],
            { capture: true },
          );
          continue;
        } catch {
          // Keep polling; publish --tag may still be propagating, or an admin
          // token may be required for standalone tag edits.
        }
      }
      await pause(2000);
    }
    const command = `npm dist-tag add ${packageName(name)}@${version} ${channel}`;
    throw Object.assign(
      new Error(
        `Published ${name}@${version}, but its ${channel} tag differs. An npm administrator must run: ${command}`,
      ),
      { distTagCommand: command },
    );
  },
};
