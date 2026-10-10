import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { nylorunHome } from "@nylorun/core/project";
import { CliError } from "../../errors.js";

/**
 * The pi-ai `nylo configure` loads; nylorun's devDependency has the same version
 * (scripts/check-package.mjs).
 */
export const PI_AI_VERSION = "0.99.1";
const PI_AI = "@earendil-works/pi-ai";

/** What `nylo configure` uses of pi-ai: its provider registry and login flows. */
export interface PiAi {
  createProvider: typeof import("@earendil-works/pi-ai").createProvider;
  builtinModels: typeof import("@earendil-works/pi-ai/providers/all").builtinModels;
  stream: typeof import("@earendil-works/pi-ai/api/openai-completions").stream;
  streamSimple: typeof import("@earendil-works/pi-ai/api/openai-completions").streamSimple;
}

/** The module written beside an on-demand install, which resolves pi-ai from there. */
const ENTRY = "pi-ai.js";
const ENTRY_SOURCE = `export { createProvider } from "${PI_AI}";
export { builtinModels } from "${PI_AI}/providers/all";
export { stream, streamSimple } from "${PI_AI}/api/openai-completions";
`;

async function fromPackages(): Promise<PiAi> {
  const [ai, all, completions] = await Promise.all([
    import("@earendil-works/pi-ai"),
    import("@earendil-works/pi-ai/providers/all"),
    import("@earendil-works/pi-ai/api/openai-completions"),
  ]);
  return {
    createProvider: ai.createProvider,
    builtinModels: all.builtinModels,
    stream: completions.stream,
    streamSimple: completions.streamSimple,
  };
}

const notInstalled = (error: unknown) =>
  (error as NodeJS.ErrnoException)?.code === "ERR_MODULE_NOT_FOUND" &&
  String((error as Error).message).includes(`'${PI_AI}'`);

/**
 * pi-ai, with its provider SDKs about 100 MB, is not a dependency of nylorun, so
 * `npx nylorun` stays small: only `nylo configure` needs it. It loads pi-ai from beside nylorun
 * when it resolves there (the workspace, or a project that installs it), else from
 * `<Nylorun home>/lib/pi-ai-<version>/`, which it installs with npm on first use.
 */
export async function loadPiAi(
  options: {
    home?: string;
    /** Import pi-ai from beside nylorun (tests). */
    packages?: () => Promise<PiAi>;
    /** Install `PI_AI_VERSION` into a directory holding its package.json (tests). */
    install?: (directory: string) => Promise<void>;
    log?: (line: string) => void;
  } = {},
): Promise<PiAi> {
  try {
    return await (options.packages ?? fromPackages)();
  } catch (error) {
    if (!notInstalled(error)) throw error;
  }
  const directory = join(nylorunHome(options.home), "lib", `pi-ai-${PI_AI_VERSION}`);
  if (!existsSync(join(directory, ENTRY))) {
    (options.log ?? ((line) => console.error(line)))(
      `nylo configure uses ${PI_AI}@${PI_AI_VERSION} for the model providers' sign-in, which nylorun does not install. Installing it once into ${directory}…`,
    );
    await installInto(directory, options.install ?? npmInstall);
  }
  return (await import(pathToFileURL(join(directory, ENTRY)).href)) as PiAi;
}

/** Install beside `directory`, then move it in place; a concurrent install that won is kept. */
async function installInto(
  directory: string,
  install: (directory: string) => Promise<void>,
): Promise<void> {
  const temporary = `${directory}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await mkdir(temporary, { recursive: true });
    await writeFile(
      join(temporary, "package.json"),
      `${JSON.stringify({ private: true, type: "module", dependencies: { [PI_AI]: PI_AI_VERSION } }, null, 2)}\n`,
    );
    await install(temporary);
    await writeFile(join(temporary, ENTRY), ENTRY_SOURCE);
    await rename(temporary, directory).catch((error: unknown) => {
      if (!existsSync(join(directory, ENTRY))) throw error;
    });
  } catch (error) {
    throw new CliError(
      `Could not install ${PI_AI}@${PI_AI_VERSION} for nylo configure: ${error instanceof Error ? error.message : String(error)}. Install it beside nylorun (npm install ${PI_AI}@${PI_AI_VERSION}), or set the model provider in Studio.`,
      1,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** The npm that runs this command (`npx` sets npm_execpath), else the one beside node, else PATH's. */
function npm(): { command: string; args: string[] } {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
  ];
  const cli = candidates.find((path) => path?.endsWith("npm-cli.js") && existsSync(path));
  return cli ? { command: process.execPath, args: [cli] } : { command: "npm", args: [] };
}

/** `npm install` without scripts; its output goes to stderr, so stdout stays the prompts'. */
function npmInstall(directory: string): Promise<void> {
  const { command, args } = npm();
  return new Promise((resolve, reject) => {
    const child = spawn(
      command,
      [
        ...args,
        "install",
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-update-notifier",
        "--loglevel=error",
      ],
      { cwd: directory, stdio: ["ignore", 2, 2] },
    );
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`npm install exited with ${code}`)),
    );
  });
}
