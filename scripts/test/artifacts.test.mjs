import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageName, packages, writeJson } from "../lib/repo.mjs";
import { packRelease, readArtifacts } from "../release/artifacts.mjs";
import { CREATOR_PINS } from "../release/version-policy.mjs";

test(
  "release artifacts are repeatable and modified bytes are rejected before publication",
  { timeout: 60_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), "nylorun-artifact-test-"));
    try {
      const repo = join(temporary, "repo");
      const versions = Object.fromEntries(
        packages.map((name) => [name, "1.0.0-beta"]),
      );
      const compatibility = {
        core: "1.0.0-beta",
        harness: "1.0.0-beta", agents: "1.0.0-beta",
        admin: "1.0.0-beta",
        runtime: "1.0.0-beta",
      };
      for (const name of packages) {
        await mkdir(join(repo, name), { recursive: true });
        await writeJson(join(repo, name, "package.json"), {
          name: packageName(name),
          version: versions[name],
          files: ["index.js"],
        });
        await writeFile(
          join(repo, name, "index.js"),
          "export const fixture = true;",
        );
      }
      await writeJson(
        join(repo, "create-agent/compatibility.json"),
        compatibility,
      );
      const plan = {
        version: 1,
        channel: "beta",
        packages: versions,
        compatibility,
      };
      const first = await packRelease(join(temporary, "first"), plan, repo);
      const second = await packRelease(join(temporary, "second"), plan, repo);
      assert.deepEqual(first, second);
      const verified = await readArtifacts(join(temporary, "first"), plan, repo);
      await appendFile(verified.runtime.path, "tampered");
      await assert.rejects(
        readArtifacts(join(temporary, "first"), plan, repo),
        /Artifact was modified: runtime/,
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);

test(
  "a private package is an image-only artifact with no tarball, decided by the checkout",
  { timeout: 60_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), "nylorun-artifact-test-"));
    try {
      const repo = join(temporary, "repo");
      const version = "1.0.0-beta";
      const compatibility = Object.fromEntries(
        CREATOR_PINS.map((name) => [name, version]),
      );
      for (const name of packages) {
        await mkdir(join(repo, name), { recursive: true });
        await writeJson(join(repo, name, "package.json"), {
          name: packageName(name),
          version,
          files: ["index.js"],
          ...(name === "studio" ? { private: true } : {}),
        });
        await writeFile(join(repo, name, "index.js"), "export {};");
      }
      await writeJson(
        join(repo, "create-agent/compatibility.json"),
        compatibility,
      );
      const plan = {
        version: 1,
        channel: "beta",
        packages: Object.fromEntries(packages.map((name) => [name, version])),
        compatibility,
      };
      const directory = join(temporary, "artifacts");
      const packed = await packRelease(directory, plan, repo);
      assert.deepEqual(packed.studio, {
        image: true,
        version,
        candidate: true,
      });
      assert.ok(packed.runtime.file);
      const read = await readArtifacts(directory, plan, repo);
      assert.equal(read.studio.image, true);
      assert.equal(read.studio.path, undefined);
      // A checkout where Studio is public refuses the image-only artifact.
      await writeJson(join(repo, "studio/package.json"), {
        name: "@nylorun/studio",
        version,
      });
      await assert.rejects(
        readArtifacts(directory, plan, repo),
        /Invalid artifact for studio/,
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
