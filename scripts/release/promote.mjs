import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { root, packages, readJson, packagePath } from "../lib/repo.mjs";
import { promoteCandidates } from "./model.mjs";
import { isImageOnly } from "./pins.mjs";
import { registry } from "./registry.mjs";

const UNRELEASED = "0.0.0";

// Promote to latest: every npm package's version on this main checkout, each
// already published by a beta release. Image-only packages have no npm tag, and
// neither has a package that was never released (0.0.0, until the beta release
// that consumes its first changeset).
const messages = [];
try {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_REF !== "refs/heads/main"
  )
    throw new Error(
      "Promotion is only available through the Promote to latest workflow on main.",
    );
  const versions = {};
  for (const name of packages) {
    if (await isImageOnly(root, name)) continue;
    const { version } = await readJson(join(root, packagePath(name), "package.json"));
    if (version !== UNRELEASED) versions[name] = version;
  }
  await promoteCandidates(versions, registry, (message) => {
    messages.push(message);
    console.log(message);
  });
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
