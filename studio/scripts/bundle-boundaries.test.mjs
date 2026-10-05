import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const studioRoot = fileURLToPath(new URL("..", import.meta.url));

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(dir, entry.name))
      : [join(dir, entry.name)],
  );
}

test("SD-I5: studio package deps stay admin and agents among @nylorun/*", () => {
  const pkg = JSON.parse(readFileSync(join(studioRoot, "package.json"), "utf8"));
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    for (const name of [
      "@nylorun/harness",
      "@nylorun/runtime",
      "@nylorun/cli",
      "@nylorun/core",
    ])
      assert.equal(
        pkg[field]?.[name],
        undefined,
        `Studio must not depend on ${name}`,
      );
  }
  const nylorun = Object.keys(pkg.dependencies ?? {})
    .filter((name) => name.startsWith("@nylorun/"))
    .sort();
  assert.deepEqual(nylorun, ["@nylorun/admin", "@nylorun/agents"]);
});

test("SD-I5: browser sources exclude engine, host and Action execution", () => {
  const webSrc = join(studioRoot, "web/src");
  const forbidden = [
    /@nylorun\/harness/,
    /@nylorun\/runtime/,
    /@nylorun\/core/,
    // Only the Management client, which loads no Node modules.
    /@nylorun\/admin(?!\/client["'])/,
    /agents\/(?:dist|src)\/(?:action-handler|execute-action)/,
    /from\s+["'][^"']*harness\/src\/flow/,
  ];
  for (const path of files(webSrc)) {
    if (!/\.(?:ts|tsx)$/.test(path)) continue;
    const source = readFileSync(path, "utf8");
    for (const pattern of forbidden)
      assert.equal(
        pattern.test(source),
        false,
        `${path} must not import engine/host/Action execution (${pattern})`,
      );
  }
});
