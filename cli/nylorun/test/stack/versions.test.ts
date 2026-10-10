import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stackImages } from "../../src/stack/images.js";
import { pinnedVersion } from "../../src/stack/versions.js";

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8"),
) as { nylorun?: { runtime?: string; studio?: string } };

describe("image pins", () => {
  it("reads nylorun.runtime and nylorun.studio from its package.json", () => {
    expect(pkg.nylorun?.runtime).toBeTruthy();
    expect(pkg.nylorun?.studio).toBeTruthy();
    expect(pinnedVersion("runtime")).toBe(pkg.nylorun!.runtime);
    expect(pinnedVersion("studio")).toBe(pkg.nylorun!.studio);
  });

  it("stackImages defaults to the pinned tags", () => {
    expect(stackImages({})).toMatchObject({
      runtime: `ghcr.io/nylorun/runtime:${pkg.nylorun!.runtime}`,
      studio: `ghcr.io/nylorun/studio:${pkg.nylorun!.studio}`,
    });
  });
});
