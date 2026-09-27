import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, cp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareVersions,
  validatePlan,
  publishCandidates,
  verifyReleaseCommit,
  releaseNotes,
} from "../release/model.mjs";
import { root, readJson, writeJson, run } from "../lib/repo.mjs";

test("a Runtime beta release advances creator and preserves unrelated compatibility pins", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nylorun-release-test-"));
  try {
    await writeJson(join(directory, "package.json"), {
      name: "fixture",
      private: true,
      workspaces: ["core", "harness", "agents", "admin", "runtime", "studio", "cli", "create-agent"],
    });
    // @manypkg/get-packages@3 NpmTool only treats a directory as an npm
    // workspace root when package-lock.json is present.
    await writeJson(join(directory, "package-lock.json"), {
      name: "fixture",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "fixture",
          workspaces: ["core", "harness", "agents", "admin", "runtime", "studio", "cli", "create-agent"],
        },
      },
    });
    await mkdir(join(directory, ".changeset"));
    await cp(
      join(root, ".changeset/config.json"),
      join(directory, ".changeset/config.json")
    );
    for (const [name, version] of Object.entries({
      core: "0.1.0-beta.1",
      cli: "0.1.0-beta.1",
      harness: "0.10.0-beta.1",
      agents: "0.1.0-beta.1",
      admin: "0.1.0-beta.1",
      runtime: "0.1.0-beta.1",
      studio: "0.3.0-beta.1",
      "create-agent": "0.1.0-beta.1",
    })) {
      await mkdir(join(directory, name));
      await writeJson(join(directory, name, "package.json"), {
        name: `@nylorun/${name}`,
        version,
      });
    }
    await mkdir(join(directory, "runtime/src"), { recursive: true });
    await writeFile(
      join(directory, "runtime/src/version.ts"),
      'export const RUNTIME_VERSION = "0.1.0-beta.1";\n',
    );
    await writeJson(join(directory, "create-agent/compatibility.json"), {
      core: "0.1.0-beta.1",
      cli: "0.1.0-beta.1",
      harness: "0.10.0-beta.1",
      agents: "0.1.0-beta.1",
      admin: "0.1.0-beta.1",
      runtime: "0.1.0-beta.1",
    });
    await writeFile(
      join(directory, ".changeset/runtime-fix.md"),
      '---\n"@nylorun/runtime": patch\n---\n\nFix runtime behavior.\n'
    );
    await writeFile(
      join(directory, ".changeset/already-released.md"),
      '---\n"@nylorun/runtime": major\n---\n\nAn already published change.\n'
    );
    await writeJson(join(directory, ".changeset/pre.json"), {
      mode: "pre",
      tag: "beta",
      initialVersions: {},
      changesets: ["already-released"],
    });
    await run("git", ["init", "-b", "main"], { cwd: directory, capture: true });
    await run("git", ["add", "."], { cwd: directory, capture: true });
    await run(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "Fixture",
      ],
      { cwd: directory, capture: true }
    );
    const plan = await prepareVersions(directory, "beta");
    assert.deepEqual(plan.packages, {
      runtime: "0.1.1-beta",
      cli: "0.1.1-beta",
      "create-agent": "0.1.1-beta",
    });
    assert.match(
      await readFile(join(directory, "runtime/src/version.ts"), "utf8"),
      /export const RUNTIME_VERSION = "0\.1\.1-beta";/,
    );
    assert.deepEqual(plan.compatibility, {
      core: "0.1.0-beta.1",
      cli: "0.1.1-beta",
      harness: "0.10.0-beta.1",
      agents: "0.1.0-beta.1",
      admin: "0.1.0-beta.1",
      runtime: "0.1.1-beta",
    });
    // The CLI's image pins: the released Runtime and the kept Studio.
    assert.deepEqual(
      JSON.parse(await readFile(join(directory, "cli/package.json"), "utf8"))
        .nylorun,
      { runtime: "0.1.1-beta", studio: "0.3.0-beta.1" },
    );
    assert.match(
      await import("node:fs/promises").then(({ readFile }) =>
        readFile(join(directory, "create-agent/CHANGELOG.md"), "utf8")
      ),
      /compatibility/i
    );
    await validatePlan(plan, directory);
    assert.match(
      await releaseNotes(directory, "runtime", plan.packages.runtime),
      /Fix runtime behavior/
    );
    await assert.rejects(
      validatePlan(
        { ...plan, packages: { runtime: plan.packages.runtime } },
        directory
      ),
      /must include create-agent/
    );
    // Pre-1.0 *-beta versions are valid on the latest channel (dist-tag promotion).
    await validatePlan({ ...plan, channel: "latest" }, directory);
    await assert.rejects(
      validatePlan(
        {
          ...plan,
          compatibility: { ...plan.compatibility, runtime: "0.1.0-beta.1" },
        },
        directory
      ),
      /Invalid compatibility pin/
    );
    // Studio ships as the image the CLI pins: not a creator pin.
    await assert.rejects(
      validatePlan(
        {
          ...plan,
          compatibility: { ...plan.compatibility, studio: "0.3.0-beta.1" },
        },
        directory
      ),
      /exactly the creator pins/
    );
    assert.equal(
      (
        await readFile(join(directory, "runtime/CHANGELOG.md"), "utf8")
      ).includes("## 0.1.1-beta"),
      true
    );
    await assert.rejects(readFile(join(directory, ".changeset/pre.json")), {
      code: "ENOENT",
    });
    await assert.rejects(
      readFile(join(directory, ".changeset/runtime-fix.md")),
      { code: "ENOENT" }
    );
    await assert.rejects(
      readFile(join(directory, ".changeset/already-released.md")),
      { code: "ENOENT" }
    );
    assert.doesNotMatch(
      await releaseNotes(directory, "runtime", plan.packages.runtime),
      /already published/
    );
    for (const version of [
      "0.1.1-beta.1",
      "0.1.1-rc",
      "0.1.1-beta+build",
      "v0.1.1-beta",
    ]) {
      await assert.rejects(
        validatePlan(
          { ...plan, packages: { ...plan.packages, runtime: version } },
          directory
        ),
        /Invalid release package/
      );
    }
    const promoted = await prepareVersions(directory, "latest");
    assert.equal(promoted.packages.runtime, "0.1.1-beta");
    assert.equal(promoted.packages["create-agent"], "0.1.1-beta");
    assert.equal(
      (await readJson(join(directory, "runtime/package.json"))).version,
      "0.1.1-beta"
    );
    assert.equal(promoted.channel, "latest");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publication retries retain completed packages and never publish creator before its pins exist", async () => {
  const plan = {
    packages: { runtime: "0.1.1-beta", "create-agent": "0.1.1-beta" },
    channel: "beta",
    compatibility: {
      core: "0.1.0-beta.1",
      cli: "0.1.0-beta.1",
      harness: "0.10.0-beta.1",
      agents: "0.1.0-beta.1",
      admin: "0.1.0-beta.1",
      runtime: "0.1.1-beta",
    },
  };
  const artifacts = {
    runtime: { integrity: "runtime-hash", path: "runtime.tgz" },
    "create-agent": { integrity: "creator-hash", path: "creator.tgz" },
  };
  const published = new Map([
    ["core", { integrity: "core-hash" }],
    ["cli", { integrity: "cli-hash" }],
    ["harness", { integrity: "harness-hash" }],
    ["agents", { integrity: "agents-hash" }],
    ["admin", { integrity: "admin-hash" }],
  ]);
  const calls = [];
  let failCreator = true;
  const registry = {
    lookup: async (name) => published.get(name),
    checkTag: async () => {},
    async publish(name) {
      calls.push(name);
      if (name === "create-agent" && failCreator)
        throw new Error("temporary registry failure");
      published.set(name, { integrity: artifacts[name].integrity });
    },
    waitFor: async (name) => published.get(name),
    ensureTag: async () => {},
  };
  await assert.rejects(
    publishCandidates(plan, artifacts, registry),
    /temporary registry failure/
  );
  assert.deepEqual(calls, ["runtime", "create-agent"]);
  failCreator = false;
  await publishCandidates(plan, artifacts, registry);
  assert.deepEqual(calls, ["runtime", "create-agent", "create-agent"]);
  published.set("runtime", { integrity: "different-hash" });
  await assert.rejects(
    publishCandidates(plan, artifacts, registry),
    /integrity conflict/
  );
  published.set("runtime", { integrity: "runtime-hash" });
  published.delete("create-agent");
  published.delete("agents");
  await assert.rejects(
    publishCandidates(plan, artifacts, registry),
    /pin is unavailable/
  );
});

test("publication waits for the engines together, then publishes the creator", async () => {
  const versions = {
    core: "0.2.0-beta",
    harness: "0.11.0-beta",
    runtime: "0.2.0-beta",
    "create-agent": "0.2.0-beta",
  };
  const plan = {
    packages: versions,
    channel: "beta",
    compatibility: {
      core: "0.2.0-beta",
      harness: "0.11.0-beta",
      agents: "0.1.0-beta.1",
      admin: "0.1.0-beta.1",
      runtime: "0.2.0-beta",
      cli: "0.1.0-beta.1",
    },
  };
  const artifacts = Object.fromEntries(
    Object.keys(versions).map((name) => [
      name,
      { integrity: `${name}-hash`, path: `${name}.tgz` },
    ]),
  );
  const published = new Map(
    ["agents", "admin", "cli"].map((name) => [
      name,
      { integrity: `${name}-hash` },
    ]),
  );
  const events = [];
  const registry = {
    lookup: async (name) => published.get(name),
    checkTag: async () => {},
    async publish(name) {
      events.push(`publish ${name}`);
      published.set(name, { integrity: artifacts[name].integrity });
    },
    async waitFor(name) {
      events.push(`wait ${name}`);
      return published.get(name);
    },
    ensureTag: async () => {},
  };
  await publishCandidates(plan, artifacts, registry);
  assert.deepEqual(events, [
    "publish core",
    "publish harness",
    "publish runtime",
    "wait core",
    "wait harness",
    "wait runtime",
    "publish create-agent",
    "wait create-agent",
  ]);
});

test("an image-only Studio is never published to npm and is not a creator registry pin", async () => {
  const plan = {
    packages: {
      studio: "0.4.0-beta",
      cli: "0.2.0-beta",
      "create-agent": "0.2.0-beta",
    },
    channel: "beta",
    compatibility: {
      core: "0.2.0-beta",
      harness: "0.11.0-beta",
      agents: "0.1.0-beta",
      admin: "0.1.0-beta",
      runtime: "0.2.0-beta",
      cli: "0.2.0-beta",
    },
  };
  const artifacts = {
    studio: { image: true, version: "0.4.0-beta", candidate: true },
    cli: { integrity: "cli-hash", path: "cli.tgz" },
    "create-agent": { integrity: "creator-hash", path: "creator.tgz" },
  };
  const published = new Map(
    ["core", "harness", "agents", "admin", "runtime"].map((name) => [
      name,
      { integrity: `${name}-hash` },
    ]),
  );
  const events = [];
  const registry = {
    async lookup(name) {
      if (name === "studio") throw new Error("looked up studio on npm");
      return published.get(name);
    },
    async checkTag(name) {
      events.push(`check ${name}`);
    },
    async publish(name) {
      events.push(`publish ${name}`);
      published.set(name, { integrity: artifacts[name].integrity });
    },
    waitFor: async (name) => published.get(name),
    ensureTag: async () => {},
  };
  const reports = [];
  await publishCandidates(plan, artifacts, registry, (line) =>
    reports.push(line),
  );
  assert.deepEqual(events, [
    "check cli",
    "check create-agent",
    "publish cli",
    "publish create-agent",
  ]);
  assert.equal(reports[0], "studio@0.4.0-beta: image only, not published to npm");
});

test("release commit validation accepts prepare commits and tips with an unchanged plan", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nylorun-release-git-"));
  const git = (args) => run("git", args, { cwd: directory, capture: true });
  try {
    await git(["init", "-b", "main"]);
    const commit = async (message) => {
      await git(["add", "."]);
      await git([
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        message,
      ]);
      return git(["rev-parse", "HEAD"]);
    };
    await writeFile(join(directory, "README.md"), "fixture");
    await commit("Initial");
    await mkdir(join(directory, ".release"));
    await writeJson(join(directory, ".release/plan.json"), { version: 1 });
    const sha = await commit("Release");
    await git(["update-ref", "refs/remotes/origin/main", sha]);
    await verifyReleaseCommit(directory, sha);
    await assert.rejects(
      verifyReleaseCommit(directory, "main"),
      /full lowercase commit SHA/
    );
    await writeFile(join(directory, "README.md"), "later");
    const later = await commit("Unmerged");
    await assert.rejects(verifyReleaseCommit(directory, later));
    await git(["update-ref", "refs/remotes/origin/main", later]);
    // Tip that only changes scripts may finish publish when the plan is unchanged.
    await verifyReleaseCommit(directory, later);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
