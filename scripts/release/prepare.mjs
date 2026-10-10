import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  root,
  npm,
  node,
  run,
  writeJson,
  verifyToolchain,
} from "../lib/repo.mjs";
import { prepareVersions } from "./model.mjs";

try {
  if (process.argv.length > 2)
    throw new Error(
      "Usage: npm run release:prepare (every release publishes on beta; Promote to latest moves the tag).",
    );
  await verifyToolchain();
  if (await run("git", ["status", "--porcelain"], { capture: true }))
    throw new Error(
      "Commit or set aside your changes before release preparation; use a clean branch.",
    );
  const branch = await run("git", ["branch", "--show-current"], {
    capture: true,
  });
  if (!branch || branch === "main")
    throw new Error("Prepare releases on a branch, not main or detached HEAD.");
  const plan = await prepareVersions(root);
  await npm(["install", "--package-lock-only", "--ignore-scripts"]);
  await npm(["run", "examples:sync"]);
  await npm(["install", "--package-lock-only", "--ignore-scripts"], {
    cwd: join(root, "examples"),
  });
  await mkdir(join(root, ".release"), { recursive: true });
  await writeJson(join(root, ".release/plan.json"), plan);
  await node("cli/create-agent/scripts/examples.mjs", ["--check"]);
  console.log(
    "Release prepared. Review versions, changelogs, compatibility, generated files and both lockfiles; commit them in a release PR. Nothing was published.",
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
