import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return [path];
  });
}

const IMPORT_RE =
  /(?:from\s*|import\s*\(|export\s*\*\s*from\s*)["']@nylorun\/runtime(?:\/[^"']*)?["']/;

const src = join(process.cwd(), "src");
/** Source files, relative to src/ with `/` separators. */
const sources = () =>
  files(src)
    .filter((path) => /\.(?:ts|js)$/.test(path) && statSync(path).isFile())
    .map((path) => relative(src, path).split(sep).join("/"));
const read = (path: string) => readFileSync(join(src, path), "utf8");

describe("nylorun does not import @nylorun/runtime", () => {
  it("nylorun/src, nylo's client/ included, has no import of @nylorun/runtime", () => {
    expect(sources().filter((path) => IMPORT_RE.test(read(path)))).toEqual([]);
  });

  it("the nylorun command loads none of nylo's client/, @nylorun/admin or pi-ai", () => {
    const offenders = sources().filter(
      (path) =>
        !path.startsWith("client/") &&
        path !== "nylo.ts" &&
        /["'](?:\.\.?\/)+client\/|["']@nylorun\/admin|["']@earendil-works\/pi-ai/.test(read(path)),
    );
    expect(offenders).toEqual([]);
  });

  it("only client/model/pi-ai.ts loads pi-ai, which nylo configure installs on demand", () => {
    // Type-only imports are erased; a value import or an import() loads the package.
    const importers = sources().filter((path) =>
      /^import\s+(?!type\b)[^;]*from\s*["']@earendil-works\/pi-ai|import\s*\(\s*["']@earendil-works\/pi-ai/m.test(
        read(path),
      ),
    );
    expect(importers).toEqual(["client/model/pi-ai.ts"]);
  });
});
