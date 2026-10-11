/**
 * An Environment's disk as files (R2d step 3, `sandbox/disk-fs.ts`): a listing keeps modes,
 * modification times, links and empty directories and skips the engine's own files; a put writes
 * them back (a large file in ranges); a clear keeps the engine's files; no path leaves its root.
 */
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearDisk,
  diskPath,
  fromWireAnswer,
  fromWireOp,
  listDisk,
  putDisk,
  readDisk,
  runDiskOp,
  toWireAnswer,
  toWireOp,
  type DiskRoots,
} from "../../src/sandbox/disk-fs.js";

let base: string;
let roots: DiskRoots;
let copy: DiskRoots;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "nylorun-disk-fs-"));
  roots = { workspace: join(base, "a", "workspace"), harness: join(base, "a", "harness") };
  copy = { workspace: join(base, "b", "workspace"), harness: join(base, "b", "harness") };
  for (const dir of [...Object.values(roots), ...Object.values(copy)]) await mkdir(dir!, { recursive: true });
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const MTIME = Date.parse("2026-01-02T03:04:05.000Z");

describe("the disk as files", () => {
  it("lists files, links and empty directories with modes and times, and skips the engine's own files", async () => {
    await mkdir(join(roots.workspace!, "app", "empty"), { recursive: true });
    await writeFile(join(roots.workspace!, "app", "run.sh"), "#!/bin/sh\necho hi\n");
    await chmod(join(roots.workspace!, "app", "run.sh"), 0o755);
    await utimes(join(roots.workspace!, "app", "run.sh"), new Date(MTIME), new Date(MTIME));
    await symlink("run.sh", join(roots.workspace!, "app", "start"));
    await writeFile(join(roots.harness!, "volume-id"), "vol-1\n");
    await writeFile(join(roots.harness!, "setup.json"), "{}\n");
    await mkdir(join(roots.harness!, "sandboxes", "s1"), { recursive: true });
    await mkdir(join(roots.harness!, "codex"), { recursive: true });
    await writeFile(join(roots.harness!, "codex", "auth.json"), "{}");

    const listed = await listDisk(roots, 100);
    expect(listed.truncated).toBe(false);
    expect(listed.entries.map((entry) => [entry.path, entry.type])).toEqual([
      ["harness/codex/auth.json", "file"],
      ["workspace/app/empty", "dir"],
      ["workspace/app/run.sh", "file"],
      ["workspace/app/start", "link"],
    ]);
    const script = listed.entries.find((entry) => entry.path === "workspace/app/run.sh")!;
    expect(script).toMatchObject({ size: 18, mode: 0o755, mtimeMs: MTIME });
    expect(listed.entries.find((entry) => entry.type === "link")!.target).toBe("run.sh");

    expect((await listDisk(roots, 2)).truncated).toBe(true);
  });

  it("puts a listing back on another disk, a large file in ranges, and clears all but the engine's files", async () => {
    await mkdir(join(roots.workspace!, "app", "empty"), { recursive: true });
    await writeFile(join(roots.workspace!, "app", "run.sh"), "#!/bin/sh\n");
    await chmod(join(roots.workspace!, "app", "run.sh"), 0o750);
    await symlink("run.sh", join(roots.workspace!, "app", "start"));
    const big = Buffer.alloc(3000, 7);
    await writeFile(join(roots.workspace!, "big.bin"), big);

    // Copy through the wire form, reading in 1000-byte ranges.
    const listed = await runDiskOp(roots, fromWireOp(toWireOp({ list: { maxEntries: 100 } })));
    if (listed.kind !== "listed") throw new Error("not listed");
    await writeFile(join(copy.harness!, "volume-id"), "vol-2\n");
    await writeFile(join(copy.workspace!, "stale.txt"), "old");
    await runDiskOp(copy, { clear: true });
    expect(await readFile(join(copy.harness!, "volume-id"), "utf8")).toBe("vol-2\n");
    await expect(stat(join(copy.workspace!, "stale.txt"))).rejects.toThrow();
    for (const entry of listed.entries) {
      if (entry.type !== "file") {
        await runDiskOp(copy, fromWireOp(toWireOp({ put: [{ ...entry }] })));
        continue;
      }
      for (let offset = 0; ; offset += 1000) {
        const read = fromWireAnswer(toWireAnswer(await runDiskOp(roots, { read: { path: entry.path, offset, length: 1000 } })));
        if (read.kind !== "read") throw new Error("not read");
        await runDiskOp(
          copy,
          fromWireOp(
            toWireOp({
              put: [{ path: entry.path, type: "file", bytes: read.bytes, append: offset > 0, ...(read.eof ? { mode: entry.mode, mtimeMs: entry.mtimeMs } : {}) }],
            }),
          ),
        );
        if (read.eof) break;
      }
    }
    expect(await readFile(join(copy.workspace!, "big.bin"))).toEqual(big);
    expect((await stat(join(copy.workspace!, "app", "run.sh"))).mode & 0o777).toBe(0o750);
    expect(await readlink(join(copy.workspace!, "app", "start"))).toBe("run.sh");
    expect((await lstat(join(copy.workspace!, "app", "empty"))).isDirectory()).toBe(true);
    const again = await listDisk(copy, 100);
    // Files keep their bytes, modes and times; links and directories their paths and targets.
    const shape = (entry: (typeof listed.entries)[number]) =>
      entry.type === "file"
        ? { path: entry.path, type: entry.type, size: entry.size, mode: entry.mode, mtimeMs: entry.mtimeMs }
        : { path: entry.path, type: entry.type, target: entry.target };
    expect(again.entries.map(shape)).toEqual(listed.entries.map(shape));
  });

  it("refuses a path that leaves its root, names no root, or is the engine's own", async () => {
    expect(() => diskPath(roots, "workspace/../etc/passwd")).toThrow(/plain relative/);
    expect(() => diskPath(roots, "etc/passwd")).toThrow(/not under a root/);
    expect(() => diskPath(roots, "harness/volume-id")).toThrow(/engine's own/);
    expect(() => diskPath({ workspace: roots.workspace }, "harness/x")).toThrow(/not under a root/);
    expect(await readDisk(roots, "workspace/missing.txt", 0, 10)).toBeUndefined();
    await expect(putDisk(roots, [{ path: "workspace/a/../../x", type: "file", bytes: new Uint8Array() }])).rejects.toThrow();
    await clearDisk({ workspace: join(base, "fresh") });
    expect((await stat(join(base, "fresh"))).isDirectory()).toBe(true);
  });
});
