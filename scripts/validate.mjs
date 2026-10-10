import { join } from "node:path";
import { root, packages, npm, script, node, packagePath } from "./lib/repo.mjs";

async function build() {
  for (const name of packages) await script("build", name);
}
async function tests() {
  for (const name of ["core", "harness", "agents", "admin", "runtime", "nylorun", "cli", "create-agent"])
    await script("test", name);
  await script("test:tooling");
  await npm(["test"], { cwd: join(root, "examples") });
}
const [command, ...flags] = process.argv.slice(2);
try {
  if (
    !["build", "test", "check", "stack"].includes(command) ||
    flags.some((flag) => flag !== "--built")
  )
    throw new Error("Usage: validate.mjs build|test|check|stack [--built]");
  if (command !== "test" && !flags.includes("--built")) await build();
  if (command === "test") await tests();
  if (command === "check") {
    await node("scripts/check-boundaries.mjs");
    await node("scripts/check-ambient.mjs");
    await script("format:check", "harness");
    await script("test:types", "harness");
    await script("test:types", "create-agent");
    await tests();
    for (const name of packages)
      await node(`${packagePath(name)}/scripts/check-package.mjs`, [], {
        cwd: join(root, packagePath(name)),
      });
    await node("scripts/check-isolated.mjs");
    await node("cli/create-agent/scripts/examples.mjs", ["--check"]);
    await npm(["run", "check"], { cwd: join(root, "examples") });
    await npm(["run", "build"], { cwd: join(root, "examples") });
  }
  if (command === "stack") {
    if (!flags.includes("--built"))
      await npm(["run", "build"], { cwd: join(root, "examples") });
    await node("cli/create-agent/scripts/check-stack.mjs");
    await node("cli/create-agent/scripts/check-example-assets.mjs");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
