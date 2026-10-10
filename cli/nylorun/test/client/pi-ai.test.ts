import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CliError } from "../../src/errors.js";
import { loadPiAi, PI_AI_VERSION } from "../../src/client/model/pi-ai.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function home(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "nylorun-pi-ai-"));
  homes.push(directory);
  return directory;
}

/** What Node throws when pi-ai does not resolve beside nylorun. */
const notInstalled = () =>
  Promise.reject(
    Object.assign(
      new Error("Cannot find package '@earendil-works/pi-ai' imported from /x/nylorun/dist/client/model/pi-ai.js"),
      { code: "ERR_MODULE_NOT_FOUND" },
    ),
  );

/** A stand-in pi-ai package with the three entry points nylo configure loads. */
async function fakeInstall(directory: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  expect(manifest.dependencies).toEqual({ "@earendil-works/pi-ai": PI_AI_VERSION });
  const pkg = join(directory, "node_modules/@earendil-works/pi-ai");
  await mkdir(join(pkg, "api"), { recursive: true });
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-ai",
      type: "module",
      exports: {
        ".": "./index.js",
        "./providers/*": "./providers-*.js",
        "./api/*": "./api/*.js",
      },
    }),
  );
  await writeFile(join(pkg, "index.js"), 'export const createProvider = () => "installed";\n');
  await writeFile(join(pkg, "providers-all.js"), "export const builtinModels = () => ({});\n");
  await writeFile(
    join(pkg, "api/openai-completions.js"),
    "export const stream = () => {};\nexport const streamSimple = () => {};\n",
  );
}

it("loads pi-ai from beside nylorun when it resolves there, installing nothing", async () => {
  const install = vi.fn();
  const ai = await loadPiAi({ home: await home(), install });
  expect(typeof ai.builtinModels).toBe("function");
  expect(typeof ai.createProvider).toBe("function");
  expect(install).not.toHaveBeenCalled();
});

it("installs pi-ai once into the Nylorun home when it does not resolve, and loads it from there", async () => {
  const root = await home();
  const install = vi.fn(fakeInstall);
  const log: string[] = [];
  const first = await loadPiAi({ home: root, packages: notInstalled, install, log: (line) => log.push(line) });
  expect((first.createProvider as unknown as () => string)()).toBe("installed");
  expect(typeof first.streamSimple).toBe("function");
  expect(log).toEqual([expect.stringContaining(`@earendil-works/pi-ai@${PI_AI_VERSION}`)]);
  expect(existsSync(join(root, "lib", `pi-ai-${PI_AI_VERSION}`, "pi-ai.js"))).toBe(true);
  // Nothing is left beside it.
  expect(await readdir(join(root, "lib"))).toEqual([`pi-ai-${PI_AI_VERSION}`]);

  await loadPiAi({ home: root, packages: notInstalled, install, log: (line) => log.push(line) });
  expect(install).toHaveBeenCalledTimes(1);
  expect(log).toHaveLength(1);
});

it("a failed install names the fix and leaves nothing behind", async () => {
  const root = await home();
  const error = await loadPiAi({
    home: root,
    packages: notInstalled,
    install: () => Promise.reject(new Error("npm install exited with 1")),
    log: () => {},
  }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CliError);
  expect((error as CliError).message).toMatch(
    /npm install exited with 1\. Install it beside nylorun \(npm install @earendil-works\/pi-ai@.*\), or set the model provider in Studio\.$/,
  );
  expect(await readdir(join(root, "lib"))).toEqual([]);
});

it("any other failure to load pi-ai is not an install", async () => {
  const install = vi.fn();
  await expect(
    loadPiAi({
      home: await home(),
      packages: () => Promise.reject(new SyntaxError("broken")),
      install,
    }),
  ).rejects.toThrow("broken");
  expect(install).not.toHaveBeenCalled();
});
