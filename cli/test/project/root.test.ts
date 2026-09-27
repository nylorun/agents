import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { findProjectRoot, requireProjectRoot } from "../../src/project/root.js";

const roots: string[] = [];
async function temporary(prefix = "nylorun-project-") {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}
beforeEach(() => {
  vi.stubEnv("NYLORUN_HOME", "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("prefers the nearest .nylorun over a closer package.json", async () => {
  const root = await temporary();
  await mkdir(join(root, ".nylorun"), { recursive: true });
  const nested = join(root, "packages/app/src");
  await mkdir(nested, { recursive: true });
  await writeFile(join(root, "packages/app/package.json"), "{}");
  expect(findProjectRoot(nested)).toBe(root);
});

it("falls back to the nearest package.json", async () => {
  const root = await temporary();
  const nested = join(root, "packages/app/src");
  await mkdir(nested, { recursive: true });
  await writeFile(join(root, "package.json"), "{}");
  await writeFile(join(root, "packages/app/package.json"), "{}");
  expect(findProjectRoot(nested)).toBe(join(root, "packages/app"));
});

it("never treats the home directory as a Project", async () => {
  const home = await temporary("nylorun-home-");
  await writeFile(join(home, "package.json"), "{}");
  await mkdir(join(home, ".nylorun"), { recursive: true });
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  expect(findProjectRoot(home)).toBeUndefined();
  expect(() => requireProjectRoot(home)).toThrow("No Project found");
});

it("finds a new Project below the home directory without .nylorun", async () => {
  const home = await temporary("nylorun-home-");
  const project = join(home, "code/my-agent");
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, "package.json"), "{}");
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  expect(findProjectRoot(join(project, "src"))).toBe(project);
});
