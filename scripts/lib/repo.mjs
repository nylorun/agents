import { existsSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export const packages = ["core", "harness", "agents", "admin", "runtime", "studio", "nylorun", "cli", "create-agent"];
/**
 * The npm name of a workspace directory. Every package is `@nylorun/<dir>`
 * except `nylorun`, the unscoped local Tenant command (`npx nylorun start`).
 */
export const packageName = (name) => (name === "nylorun" ? "nylorun" : `@nylorun/${name}`);
/** The workspace directory of an npm name (the inverse of packageName). */
export const packageDirectory = (npmName) =>
  npmName === "nylorun" ? "nylorun" : npmName.replace(/^@nylorun\//, "");
export const readJson = async (path) =>
  JSON.parse(await readFile(path, "utf8"));
export const writeJson = (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n");
export function npmCli() {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
    ...(process.env.PATH ?? "")
      .split(delimiter)
      .flatMap((path) => [
        join(path, "node_modules/npm/bin/npm-cli.js"),
        join(path, "npm"),
      ]),
  ];
  const found = candidates.find((path) => path && existsSync(path));
  if (!found)
    throw new Error(
      "npm is missing. Install the toolchain documented in CONTRIBUTING.md.",
    );
  return realpathSync(found);
}
export function run(
  command,
  args,
  { cwd = root, capture = false, env = process.env, timeout = 600_000 } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "",
      stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    let settled = false;
    const failTimeout = () => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* already exited */
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already exited */
        }
      }, 5_000).unref?.();
      reject(
        Object.assign(
          new Error(
            `${command} ${args.join(" ")} timed out after ${timeout}ms.`,
          ),
          { code: null, stdout, stderr, timedOut: true },
        ),
      );
    };
    const timer = setTimeout(failTimeout, timeout);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    // "close" fires after stdio drains, so captured JSON is never truncated.
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else
        reject(
          Object.assign(
            new Error(
              `${command} ${args.join(" ")} failed (${code}).${stderr ? `\n${stderr}` : ""}${stdout ? `\n${stdout}` : ""}`,
            ),
            { code, stdout, stderr },
          ),
        );
    });
  });
}
export const npm = (args, options) =>
  run(process.execPath, [npmCli(), ...args], options);
export const script = (name, workspace, options = {}) =>
  npm(
    [
      "run",
      name,
      ...(workspace ? ["--workspace", packageName(workspace)] : []),
    ],
    options,
  );
export const node = (path, args = [], options) =>
  run(process.execPath, [resolve(root, path), ...args], options);
const major = (version) => version.split(".")[0];

export async function verifyToolchain() {
  const manifest = await readJson(join(root, "package.json"));
  const expectedNpm = manifest.packageManager.slice(4);
  const expectedNode = (
    await readFile(join(root, ".node-version"), "utf8")
  ).trim();
  const actualNpm = await npm(["--version"], { capture: true });
  if (
    major(process.versions.node) !== major(expectedNode) ||
    major(actualNpm) !== major(expectedNpm)
  )
    throw new Error(
      `Use Node ${major(expectedNode)} and npm ${major(expectedNpm)}. Run nvm install && nvm use, then npm install --global npm@${expectedNpm}. Current: Node ${process.versions.node}, npm ${actualNpm}.`,
    );
}
