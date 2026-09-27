import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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

describe("the CLI does not import @nylorun/runtime", () => {
  it("cli/src has no import of @nylorun/runtime", () => {
    const src = join(process.cwd(), "src");
    const offenders: string[] = [];
    for (const path of files(src)) {
      if (!/\.(?:ts|js)$/.test(path)) continue;
      if (!statSync(path).isFile()) continue;
      if (IMPORT_RE.test(readFileSync(path, "utf8"))) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });

  it("the launcher wrappers (cli/src/host, cli/src/runtime) are gone", () => {
    expect(existsSync(join(process.cwd(), "src/host"))).toBe(false);
    expect(existsSync(join(process.cwd(), "src/runtime"))).toBe(false);
  });
});
