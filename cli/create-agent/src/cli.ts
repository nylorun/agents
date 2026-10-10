#!/usr/bin/env node
import { mkdir, rename, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Compatibility, CreatorDependencies } from "./contracts.js";
import { createProject, CreationError } from "./project.js";
import { parse, usage } from "./arguments.js";
import { CreationCancelled, runCommand } from "./process.js";
import { checkDocker } from "./docker.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0]!)) {
    console.log(usage);
    return;
  }
  if (process.platform === "win32")
    throw new Error(
      "Nylorun does not run on native Windows. Use WSL2: install Node 24 and Docker (Docker Desktop's WSL integration) inside your WSL distribution and create the project there (https://learn.microsoft.com/windows/wsl/install).",
    );
  const options = parse(argv);
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (!(major > 22 || (major === 22 && minor >= 19)))
    throw new Error(
      "Nylorun project creation requires Node.js 22.19 or newer.",
    );
  const controller = new AbortController();
  const onInt = () => controller.abort(new CreationCancelled("SIGINT"));
  const onTerm = () => controller.abort(new CreationCancelled("SIGTERM"));
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    const dependencies: CreatorDependencies = {
      currentDirectory: () => process.cwd(),
      isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
      log: (message) => console.log(message),
      signal: controller.signal,
      exists: async (path) => existsSync(path),
      makeDirectory: async (path) => {
        await mkdir(path, { recursive: true });
      },
      rename,
      remove: async (path) => rm(path, { recursive: true, force: true }),
      write: async (path, content) => writeFile(path, content),
      run: (command, args, directory) =>
        runCommand(command, args, directory, controller.signal),
      nodeVersion: process.versions.node,
      checkDocker,
    };
    const compatibility = JSON.parse(
      await readFile(
        join(dirname(fileURLToPath(import.meta.url)), "compatibility.json"),
        "utf8",
      ),
    ) as Compatibility;
    await createProject(options, compatibility, dependencies);
  } finally {
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
  }
}
void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode =
    error instanceof CreationError || error instanceof CreationCancelled
      ? error.exitCode
      : 1;
});
