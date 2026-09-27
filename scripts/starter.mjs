import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  root,
  readJson,
  writeJson,
  node,
  npm,
  verifyToolchain,
} from "./lib/repo.mjs";
import {
  developmentOptions,
  develop,
  workspaceCommands,
} from "./lib/development.mjs";

/**
 * A fresh starter under .tmp/ whose @nylorun packages are the workspace's. Like
 * a developer's project it depends on the SDK only; the loop drives it with the
 * workspace nylorun and nylo (scripts/lib/development.mjs).
 */
export async function renderPreview({ repo = root } = {}) {
  const { starterFiles } = await import(
    pathToFileURL(join(repo, "create-agent/dist/scaffold.js")).href
  );
  await mkdir(join(repo, ".tmp"), { recursive: true });
  const project = await mkdtemp(join(repo, ".tmp/starter-"));
  const compatibility = await readJson(
    join(repo, "create-agent/compatibility.json"),
  );
  for (const [path, content] of Object.entries(
    await starterFiles(compatibility),
  )) {
    await mkdir(dirname(join(project, path)), { recursive: true });
    await writeFile(join(project, path), content);
  }
  const manifest = await readJson(join(project, "package.json"));
  const local = (name) => `file:${join(repo, name).replaceAll("\\", "/")}`;
  for (const name of ["core", "agents"])
    manifest.dependencies[`@nylorun/${name}`] = local(name);
  await writeJson(join(project, "package.json"), manifest);
  return project;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const options = developmentOptions(process.argv.slice(2));
    await verifyToolchain();
    await node("scripts/validate.mjs", ["build"]);
    const project = await renderPreview();
    console.log(
      `Starter preview: ${project}\nTemplate changes require a new preview; this directory will be retained.`,
    );
    await npm(["install"], { cwd: project });
    const controller = new AbortController();
    process.on("SIGINT", () => controller.abort());
    process.on("SIGTERM", () => controller.abort());
    // The same loop as npm run dev, with the preview as the application.
    const app = await develop(options, {
      signal: controller.signal,
      built: true,
      commands: workspaceCommands({ project }),
    });
    process.exitCode = await app.done;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
