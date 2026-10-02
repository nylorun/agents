import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { root, readJson } from "../lib/repo.mjs";
import {
  validatePlan,
  verifyReleaseCommit,
  promoteCandidates,
} from "./model.mjs";
import { isImageOnly } from "./pins.mjs";
import { registry } from "./registry.mjs";

const messages = [];
try {
  if (process.env.GITHUB_ACTIONS !== "true" || !process.env.RELEASE_SHA)
    throw new Error(
      "Promotion is only available through the GitHub release workflow.",
    );
  await verifyReleaseCommit(root, process.env.RELEASE_SHA);
  const plan = await readJson(join(root, ".release/plan.json"));
  await validatePlan(plan, root);
  const imageOnly = new Set();
  for (const name of Object.keys(plan.packages))
    if (await isImageOnly(root, name)) imageOnly.add(name);
  await promoteCandidates(
    plan,
    registry,
    (name) => imageOnly.has(name),
    (message) => {
      messages.push(message);
      console.log(message);
    },
  );
} catch (error) {
  messages.push(error.message);
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      messages.map((line) => `- ${line}`).join("\n") + "\n",
    );
}
