import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RELEASE_ASSETS,
  extractAssets,
  missingAssets,
  uploadReleaseAssets,
} from "../release/assets.mjs";

/** A runner that answers `gh release view` with `assets` and records every call. */
function fakeGh(assets) {
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "gh" && args[1] === "view")
      return JSON.stringify({ assets: assets.map((name) => ({ name })) });
    return "";
  };
  return { calls, runner };
}

test("the Runtime's release carries its OpenAPI documents; other packages carry nothing", () => {
  assert.deepEqual(RELEASE_ASSETS.runtime, ["openapi.json", "admin-openapi.json"]);
  assert.deepEqual(missingAssets("runtime", []), ["openapi.json", "admin-openapi.json"]);
  assert.deepEqual(missingAssets("runtime", ["openapi.json"]), ["admin-openapi.json"]);
  assert.deepEqual(missingAssets("runtime", ["openapi.json", "admin-openapi.json"]), []);
  assert.deepEqual(missingAssets("core", []), []);
});

test("uploads only the assets a release lacks, and never replaces one", async () => {
  const release = { name: "runtime", tag: "@nylorun/runtime@1.0.0-beta", tarball: "/t.tgz", directory: "/d" };

  const fresh = fakeGh([]);
  assert.deepEqual(await uploadReleaseAssets({ ...release, runner: fresh.runner }), [
    "openapi.json",
    "admin-openapi.json",
  ]);
  assert.deepEqual(fresh.calls.at(-1), [
    "gh",
    "release",
    "upload",
    release.tag,
    "/d/package/dist/openapi.json",
    "/d/package/dist/admin-openapi.json",
  ]);
  assert.ok(fresh.calls.every((call) => !call.includes("--clobber")));

  const partial = fakeGh(["openapi.json"]);
  assert.deepEqual(await uploadReleaseAssets({ ...release, runner: partial.runner }), [
    "admin-openapi.json",
  ]);

  const complete = fakeGh(["openapi.json", "admin-openapi.json"]);
  assert.deepEqual(await uploadReleaseAssets({ ...release, runner: complete.runner }), []);
  assert.ok(complete.calls.every((call) => call[2] !== "upload"));

  const other = fakeGh([]);
  assert.deepEqual(
    await uploadReleaseAssets({ ...release, name: "core", runner: other.runner }),
    [],
  );
  assert.deepEqual(other.calls, []);
});

test("extracts assets from the package tarball, byte for byte", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "nylorun-assets-test-"));
  try {
    const packed = join(temporary, "packed");
    await mkdir(join(packed, "package", "dist"), { recursive: true });
    await writeFile(join(packed, "package", "dist", "openapi.json"), '{"openapi":"3.2.0"}\n');
    await writeFile(join(packed, "package", "dist", "admin-openapi.json"), '{"openapi":"3.2.0","a":1}\n');
    const tarball = join(temporary, "runtime.tgz");
    execFileSync("tar", ["-czf", tarball, "-C", packed, "package"]);
    const out = join(temporary, "out");
    await mkdir(out);
    const [tenant, admin] = await extractAssets(tarball, RELEASE_ASSETS.runtime, out);
    assert.equal(await readFile(tenant, "utf8"), '{"openapi":"3.2.0"}\n');
    assert.equal(await readFile(admin, "utf8"), '{"openapi":"3.2.0","a":1}\n');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
