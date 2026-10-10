import { join } from "node:path";
import {
  root,
  readJson,
  writeJson,
  node,
  verifyToolchain,
} from "../lib/repo.mjs";
import { validatePlan, verifyReleaseCommit, releaseNotes } from "./model.mjs";
import { packRelease, readArtifacts } from "./artifacts.mjs";
import { assertRuntimePins, assertStudioImageOnly } from "./pins.mjs";

try {
  const args = process.argv.slice(2);
  const built = args[0] === "--built";
  if (args.length > 1 || (args.length && !built))
    throw new Error("Usage: npm run release:check [-- --built]");
  await verifyToolchain();
  if (process.env.RELEASE_SHA)
    await verifyReleaseCommit(root, process.env.RELEASE_SHA);
  const plan = await readJson(join(root, ".release/plan.json"));
  await validatePlan(plan, root);
  // The CLI's image pins name the Runtime and Studio this release ships.
  await assertRuntimePins(root, plan);
  await assertStudioImageOnly(root);
  for (const [name, version] of Object.entries(plan.packages))
    await releaseNotes(root, name, version);
  if (!built) await node("scripts/validate.mjs", ["check"]);
  const directory = join(root, ".tmp/release-artifacts");
  await packRelease(directory, plan);
  const artifacts = await readArtifacts(directory, plan);
  const input = join(directory, "stack-input.json");
  await writeJson(
    input,
    Object.fromEntries(
      Object.entries(artifacts)
        .filter(([, artifact]) => !artifact.image)
        .map(([name, artifact]) => [name, artifact.path]),
    ),
  );
  await node("cli/create-agent/scripts/check-stack.mjs");
  await node("cli/create-agent/scripts/smoke-starter.mjs", [], {
    env: { ...process.env, NYLORUN_STACK_TARBALLS: input },
  });
  await node("cli/create-agent/scripts/check-example-assets.mjs");
  console.log(
    `Exact release combination passed. Verified artifacts: ${directory}`,
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
