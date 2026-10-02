import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Compatibility,
  CreateOptions,
  CreatorDependencies,
} from "./contracts.js";
import { starterFiles } from "./scaffold.js";
import { CreationCancelled } from "./process.js";

export class CreationError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
  }
}

export async function createProject(
  options: CreateOptions,
  compatibility: Compatibility,
  dependencies: CreatorDependencies
): Promise<void> {
  for (const note of options.notes ?? []) dependencies.log(note);
  const currentDirectory = resolve(dependencies.currentDirectory());
  const destination = resolve(currentDirectory, options.directory);
  const pathFromCurrentDirectory = relative(currentDirectory, destination);
  if (
    isAbsolute(options.directory) ||
    pathFromCurrentDirectory === "" ||
    pathFromCurrentDirectory === ".." ||
    pathFromCurrentDirectory.startsWith("../")
  )
    throw new Error(
      "Target directory must be a new child of the current directory."
    );
  if (await dependencies.exists(destination))
    throw new Error(`Target directory already exists: ${destination}`);
  dependencies.signal?.throwIfAborted();
  const temporary = join(
    dirname(destination),
    `.${basename(destination)}-${randomUUID()}`
  );
  await dependencies.makeDirectory(temporary);
  try {
    const files = {
      ...(await starterFiles(compatibility)),
    };
    const name = packageName(basename(destination));
    const manifest = JSON.parse(files["package.json"]!);
    manifest.name = name;
    files["package.json"] = JSON.stringify(manifest, null, 2) + "\n";
    files["README.md"] = files["README.md"]!.replace(/^# .+\n/u, `# ${name}\n`);
    for (const [relative, content] of Object.entries(files)) {
      const file = join(temporary, relative);
      await dependencies.makeDirectory(dirname(file));
      await dependencies.write(file, content);
      dependencies.signal?.throwIfAborted();
    }
    await dependencies.rename(temporary, destination);
  } catch (error) {
    await dependencies.remove(temporary);
    throw error;
  }
  dependencies.log("Installing dependencies...");
  await stage("Installation", ["install", ...(options.yes ? ["--yes"] : [])]);
  const next = nextSteps(destination);
  const missing = await missingPrerequisites(dependencies);
  if (missing.length)
    throw new CreationError(
      `Project created. Before starting it, set up the prerequisites:\n${missing
        .map((line) => `  ${line}`)
        .join("\n")}\nThen run:\n${next}`,
    );
  dependencies.log(`Project created. Next:\n${next}`);

  async function stage(name: string, args: readonly string[]): Promise<void> {
    try {
      dependencies.signal?.throwIfAborted();
      const result = await dependencies.run("npm", args, destination);
      dependencies.signal?.throwIfAborted();
      if (result.signal === "SIGINT" || result.status === 130)
        throw new CreationCancelled("SIGINT");
      if (result.signal === "SIGTERM" || result.status === 143)
        throw new CreationCancelled("SIGTERM");
      if (result.status !== 0 || result.signal)
        throw new Error(`${name} failed.`);
    } catch (error) {
      const cancelled = error instanceof CreationCancelled;
      throw new CreationError(
        `${
          cancelled ? error.message : `${name} failed.`
        } The generated project was kept.\nResume with:\ncd ${quote(destination)}\nnpm install\n${NEXT.join("\n")}`,
        cancelled ? error.exitCode : 1
      );
    }
  }
}

/**
 * After creation: `nylorun start` in the project creates and starts its
 * local stack, whose Runtime creates the stack's one Tenant, and links the
 * project to it; then develop. The creator runs neither; the project itself
 * depends only on @nylorun/agents.
 */
const NEXT = [
  "npx nylorun@beta start  # this project's stack, its Tenant and the link in .nylorun/ (Docker)",
  "npm run dev",
];

function nextSteps(destination: string): string {
  return [`cd ${quote(destination)}`, ...NEXT].join("\n");
}

/** The CLI and the generated application need Node 24 APIs. */
const MIN_NODE_MAJOR = 24;

/**
 * Prerequisites the developer installs before `npm run dev`: Node 24 and
 * Docker with Compose v2 (the local stack). The creator only reports them; it
 * never downloads or starts anything.
 */
async function missingPrerequisites(
  dependencies: CreatorDependencies,
): Promise<string[]> {
  const missing: string[] = [];
  if (!(Number(dependencies.nodeVersion.split(".")[0]) >= MIN_NODE_MAJOR))
    missing.push(
      `Node.js ${MIN_NODE_MAJOR} or newer (found ${dependencies.nodeVersion})`,
    );
  const docker = await dependencies.checkDocker();
  if (!docker.ok) missing.push(docker.problem);
  return missing;
}

function packageName(directory: string): string {
  const name = directory
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[-.]+|[-.]+$/gu, "")
    .replace(/-+/gu, "-");
  return name || "my-nylorun-agent";
}

function quote(value: string): string {
  if (/^[a-zA-Z0-9_./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}
