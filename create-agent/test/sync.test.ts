import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { synchronize } from "../src/sync.js";
const compatibility = {
  core: "5",
  cli: "6",
  harness: "1",
  agents: "4",
  admin: "7",
  runtime: "2",
};
const options = { creatorVersion: "1" };
const roots: string[] = [];
async function root() {
  const path = await mkdtemp(join(tmpdir(), "nylorun-sync-"));
  roots.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
it("updates, deletes and renames generated files without touching authored code or local state", async () => {
  const directory = await root();
  for (const path of [
    "agents/demo/agent.ts",
    ".env/auth.json",
    ".env/model.json",
    "config/model.json",
    ".data/session.json",
  ]) {
    await mkdir(join(directory, path, ".."), { recursive: true });
    await writeFile(join(directory, path), "preserved");
  }
  await synchronize(
    directory,
    { "nylorun.config.ts": "v1", "old.json": "old" },
    compatibility,
    options
  );
  const next = { "nylorun.config.ts": "v2", "new.json": "new" };
  expect(
    await synchronize(directory, next, compatibility, {
      ...options,
      check: true,
    })
  ).toContain("old.json");
  expect(await readFile(join(directory, "nylorun.config.ts"), "utf8")).toBe(
    "v1"
  );
  await synchronize(directory, next, compatibility, options);
  expect(await synchronize(directory, next, compatibility, options)).toEqual(
    []
  );
  await expect(readFile(join(directory, "old.json"))).rejects.toThrow();
  for (const path of [
    "agents/demo/agent.ts",
    ".env/auth.json",
    ".env/model.json",
    "config/model.json",
    ".data/session.json",
  ])
    expect(await readFile(join(directory, path), "utf8")).toBe("preserved");
});
it("preflights conflicts before making any edits", async () => {
  const directory = await root();
  await synchronize(
    directory,
    { "first.json": "v1", "second.json": "v1" },
    compatibility,
    options
  );
  await writeFile(join(directory, "second.json"), "manual edit");
  await expect(
    synchronize(
      directory,
      { "first.json": "v2", "second.json": "v2" },
      compatibility,
      options
    )
  ).rejects.toThrow("conflict");
  expect(await readFile(join(directory, "first.json"), "utf8")).toBe("v1");
});
it("rejects authored paths, traversal, and symlinks", async () => {
  const directory = await root();
  for (const path of [
    "agents/a.ts",
    "config/model.json",
    ".env/auth.json",
    ".env/model.json",
    "scripts/manual.mjs",
    "../escape.json",
  ])
    await expect(
      synchronize(directory, { [path]: "overwrite" }, compatibility, options)
    ).rejects.toThrow("unmanaged");
  const external = await root();
  await symlink(external, join(directory, "linked"));
  await expect(
    synchronize(
      directory,
      { "linked/config.json": "overwrite" },
      compatibility,
      options
    )
  ).rejects.toThrow("symlink");
});
it("preserves a legacy environment file and explains migration", async () => {
  const directory = await root();
  await writeFile(join(directory, ".env"), "secret");
  await expect(
    synchronize(directory, { ".env/README.md": "docs" }, compatibility, options)
  ).rejects.toThrow("relocate");
  expect(await readFile(join(directory, ".env"), "utf8")).toBe("secret");
});
