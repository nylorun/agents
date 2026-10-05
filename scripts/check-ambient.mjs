import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

/**
 * The process entries may read ambient process/OS state: the Host (`host/main.ts`) and the
 * operator command (`host/operate.ts`). Nothing else under runtime/src may.
 */
const AMBIENT_ALLOWLIST = new Set(["host/main.ts", "host/operate.ts"]);

const AMBIENT_PATTERN =
  /process\.env|process\.cwd\s*\(|\bhomedir\s*\(|\btmpdir\s*\(/g;
const CONSOLE_PATTERN = /console\./g;

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function toPosix(path) {
  return path.split(sep).join("/");
}

function lineOf(source, index) {
  return source.slice(0, index).split(/\r?\n/).length;
}

function collectMatches(source, pattern) {
  const matches = [];
  for (const match of source.matchAll(pattern)) {
    matches.push({
      text: match[0].replace(/\s*\($/, "()"),
      line: lineOf(source, match.index),
    });
  }
  return matches;
}

/**
 * Fail on ambient process/OS reads under runtime/src (except the process entries)
 * and on console.* under runtime/src/tenant and runtime/src/api.
 *
 * @param {{ runtimeSrc?: string }} [options]
 * @returns {{ ok: true } | { ok: false, violations: string[] }}
 */
export function checkAmbient(options = {}) {
  const runtimeSrc = options.runtimeSrc ?? join(root, "runtime", "src");
  const violations = [];

  for (const path of walk(runtimeSrc)) {
    if (!path.endsWith(".ts")) continue;
    const rel = toPosix(relative(runtimeSrc, path));
    const source = readFileSync(path, "utf8");
    const ambientAllowed = AMBIENT_ALLOWLIST.has(rel);

    if (!ambientAllowed) {
      for (const match of collectMatches(source, AMBIENT_PATTERN)) {
        violations.push(
          `${rel}:${match.line}: ambient ${match.text} (allowed only in host/main.ts and host/operate.ts)`,
        );
      }
    }

    const area = rel.split("/")[0];
    if (area === "tenant" || area === "api") {
      for (const match of collectMatches(source, CONSOLE_PATTERN)) {
        violations.push(
          `${rel}:${match.line}: ${match.text} forbidden under runtime/src/${area}`,
        );
      }
    }
  }

  if (violations.length === 0) return { ok: true };
  return { ok: false, violations };
}

export function formatAmbientReport(result) {
  if (result.ok) return "ambient: runtime/src has no forbidden ambient or console reads.";
  return [
    "ambient: forbidden ambient environment or console usage:",
    ...result.violations.map((line) => `  ${line}`),
  ].join("\n");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const result = checkAmbient();
  console.log(formatAmbientReport(result));
  if (!result.ok) process.exitCode = 1;
}
