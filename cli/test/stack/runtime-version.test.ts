import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runtimeVersion } from "../../src/stack/runtime-version.js";

describe("F1-1 runtimeVersion", () => {
  it('reads cli/package.json nylorun.runtime', () => {
    const pkgPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../package.json",
    );
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      nylorun?: { runtime?: string };
    };
    expect(pkg.nylorun?.runtime).toBeTruthy();
    expect(runtimeVersion()).toBe(pkg.nylorun!.runtime);
  });
});
