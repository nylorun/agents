import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertRuntimeImagePin,
  assertStudioImagePin,
  assertRuntimePins,
  assertStudioImageOnly,
  syncImagePins,
} from "../release/pins.mjs";
import { imageRelease, registryHas } from "../release/images.mjs";
import { readJson, writeJson } from "../lib/repo.mjs";

async function fixtureRepo({
  runtimeVersion = "0.9.0-beta",
  studioVersion = "0.4.0-beta",
  pins,
  studioPrivate = false,
}) {
  const root = await mkdtemp(join(tmpdir(), "nylorun-pins-"));
  for (const name of ["runtime", "studio", "nylorun"])
    await mkdir(join(root, name), { recursive: true });
  await writeJson(join(root, "runtime/package.json"), {
    name: "@nylorun/runtime",
    version: runtimeVersion,
  });
  await writeJson(join(root, "studio/package.json"), {
    name: "@nylorun/studio",
    version: studioVersion,
    ...(studioPrivate ? { private: true } : {}),
  });
  const manifest = { name: "nylorun", version: "0.1.0-beta" };
  if (pins) manifest.nylorun = pins;
  await writeJson(join(root, "nylorun/package.json"), manifest);
  return root;
}

async function withRepo(options, body) {
  const root = await fixtureRepo(options);
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("assertRuntimeImagePin fails when nylorun.runtime differs from runtime version", () =>
  withRepo({ pins: { runtime: "0.8.0-beta", studio: "0.4.0-beta" } }, (root) =>
    assert.rejects(
      () => assertRuntimeImagePin(root),
      /nylorun\.runtime \(0\.8\.0-beta\) must equal runtime version \(0\.9\.0-beta\)/,
    ),
  ));

test("assertStudioImagePin fails when nylorun.studio is missing or differs", async () => {
  await withRepo({ pins: { runtime: "0.9.0-beta" } }, (root) =>
    assert.rejects(
      () => assertStudioImagePin(root),
      /nylorun\.studio \(missing\) must equal studio version \(0\.4\.0-beta\)/,
    ),
  );
  await withRepo(
    { pins: { runtime: "0.9.0-beta", studio: "0.3.0-beta" } },
    (root) =>
      assert.rejects(() => assertRuntimePins(root), /nylorun\.studio \(0\.3\.0-beta\)/),
  );
});

test("assertRuntimePins passes when both pins match, and returns them", () =>
  withRepo({ pins: { runtime: "0.9.0-beta", studio: "0.4.0-beta" } }, async (root) =>
    assert.deepEqual(await assertRuntimePins(root), {
      runtime: "0.9.0-beta",
      studio: "0.4.0-beta",
    }),
  ));

test("assertRuntimePins checks the pins against the plan's published or kept versions", () =>
  withRepo({ pins: { runtime: "0.9.0-beta", studio: "0.4.0-beta" } }, async (root) => {
    // Studio is not in this release: its compatibility pin is what ships.
    await assertRuntimePins(root, {
      packages: { runtime: "0.9.0-beta" },
      compatibility: { runtime: "0.9.0-beta", studio: "0.4.0-beta" },
    });
    await assert.rejects(
      () =>
        assertRuntimePins(root, {
          packages: { runtime: "0.9.0-beta", studio: "0.5.0-beta" },
          compatibility: { runtime: "0.9.0-beta", studio: "0.5.0-beta" },
        }),
      /release pins studio 0\.5\.0-beta, but studio\/package\.json is 0\.4\.0-beta/,
    );
  }));

test("syncImagePins writes nylorun.runtime and nylorun.studio and keeps other fields", () =>
  withRepo({ pins: { runtime: "0.8.0-beta", other: "x" } }, async (root) => {
    await syncImagePins(root, { runtime: "0.9.1-beta", studio: "0.4.1-beta" });
    const cli = await readJson(join(root, "nylorun/package.json"));
    assert.deepEqual(cli.nylorun, {
      runtime: "0.9.1-beta",
      other: "x",
      studio: "0.4.1-beta",
    });
    await assert.rejects(
      () => syncImagePins(root, { runtime: "0.9.1-beta" }),
      /requires runtime and studio/,
    );
  }));

test("assertStudioImageOnly tolerates a public Studio unless strict", async () => {
  await withRepo({ studioPrivate: false }, async (root) => {
    assert.equal(await assertStudioImageOnly(root), false);
    await assert.rejects(
      () => assertStudioImageOnly(root, { strict: true }),
      /"private": true/,
    );
  });
  await withRepo({ studioPrivate: true }, async (root) => {
    assert.equal(await assertStudioImageOnly(root, { strict: true }), true);
  });
});

const pins = { runtime: "0.9.0-beta", studio: "0.4.0-beta" };
const plan = (packages) => ({
  packages,
  compatibility: { runtime: "0.9.0-beta", studio: "0.4.0-beta" },
});

test("imageRelease pushes a released version's missing image and skips an existing one", () =>
  withRepo({ pins }, async (root) => {
    const released = plan({ runtime: "0.9.0-beta", studio: "0.4.0-beta" });
    assert.deepEqual(await imageRelease(root, released, "runtime", async () => false), {
      image: "ghcr.io/nylorun/runtime",
      version: "0.9.0-beta",
      tag: "ghcr.io/nylorun/runtime:0.9.0-beta",
      candidate: true,
      push: true,
    });
    const seen = [];
    const existing = await imageRelease(root, released, "studio", async (tag) => {
      seen.push(tag);
      return true;
    });
    assert.deepEqual(seen, ["ghcr.io/nylorun/studio:0.4.0-beta"]);
    assert.equal(existing.push, false);
  }));

test("imageRelease requires the image of a version the release keeps", () =>
  withRepo({ pins }, async (root) => {
    const kept = plan({ runtime: "0.9.0-beta" });
    assert.equal(
      (await imageRelease(root, kept, "studio", async () => true)).push,
      false,
    );
    await assert.rejects(
      () => imageRelease(root, kept, "studio", async () => false),
      /ghcr\.io\/nylorun\/studio:0\.4\.0-beta does not exist, and this release keeps studio/,
    );
    await assert.rejects(
      () => imageRelease(root, kept, "cli", async () => false),
      /No image for cli/,
    );
  }));

test("imageRelease refuses pins that disagree with the plan", () =>
  withRepo({ pins: { runtime: "0.8.0-beta", studio: "0.4.0-beta" } }, (root) =>
    assert.rejects(
      () => imageRelease(root, plan({ runtime: "0.9.0-beta" }), "runtime", async () => false),
      /nylorun\.runtime \(0\.8\.0-beta\)/,
    ),
  ));

test("registryHas treats only a missing or unreadable tag as absent", async () => {
  const failing = (stderr) => async () => {
    throw Object.assign(new Error("docker failed (1)."), { stderr });
  };
  assert.equal(await registryHas("t", async () => ""), true);
  assert.equal(await registryHas("t", failing("ERROR: t: not found")), false);
  assert.equal(await registryHas("t", failing("MANIFEST_UNKNOWN: manifest unknown")), false);
  assert.equal(await registryHas("t", failing("denied: requested access to the resource is denied")), false);
  await assert.rejects(
    () => registryHas("t", failing("dial tcp: i/o timeout")),
    /docker failed/,
  );
});
