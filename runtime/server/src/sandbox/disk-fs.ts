/**
 * An Environment's disk as files (R2d step 3): what a version holds and how it is put back. A
 * disk is one or two roots, named by the first segment of every path: `workspace/…` (the
 * sandbox's `/workspace`) and, in a pod, `harness/…` (the engine's `/harness`, where a vendor
 * harness keeps its state). Both backends use this over their own directories: the pod's volume
 * (`adapters/sandbox/local.ts`) and the virtual workspace's host directory
 * (`adapters/sandbox/virtual.ts`).
 *
 * A listing has regular files (size, mode, modification time), symbolic links (their target as
 * stored) and empty directories; sockets, FIFOs and devices are skipped, and hard links are listed
 * as separate files. The engine's own files are never listed or cleared (`ENGINE_FILES`): a
 * restored volume keeps its own identity (`volume-id`), trust bundle and setup marker.
 *
 * Writes go to a temporary name and are renamed into place; a link replaces what is at its path.
 * Times are whole milliseconds, rounded: a time written back with `utimes` can read back a hair
 * under the millisecond it was, which rounding keeps and flooring would not.
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readlink, rename, rm, symlink, utimes, chmod, appendFile, writeFile } from "node:fs/promises";
import { posix } from "node:path";

/** One entry of a disk listing, its path relative to the volume. */
export interface DiskEntry {
  readonly path: string;
  readonly type: "file" | "dir" | "link";
  readonly size: number;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly target?: string;
}

export interface DiskListing {
  readonly entries: readonly DiskEntry[];
  /** More than `maxEntries` entries: `entries` holds `maxEntries + 1` of them. */
  readonly truncated: boolean;
}

/** One entry to write: a file's bytes (or a range to append), a directory or a link. */
export interface DiskPut {
  readonly path: string;
  readonly type: "file" | "dir" | "link";
  readonly mode?: number;
  readonly mtimeMs?: number;
  /** A file's bytes, or the next range of them with `append`. */
  readonly bytes?: Uint8Array;
  /** Appends `bytes` to what the file holds (a large file moves in ranges). */
  readonly append?: boolean;
  /** A link's target. */
  readonly target?: string;
}

/** The disk's roots: `workspace`, and in a pod `harness`, as absolute directories. */
export type DiskRoots = Readonly<Partial<Record<"workspace" | "harness", string>>>;

/** The engine's own files under `harness/`, which a disk version never holds. */
export const ENGINE_FILES: ReadonlySet<string> = new Set([
  "volume-id",
  "egress-ca-bundle.pem",
  "setup.json",
  "sandboxes",
]);

/** The absolute path of `path` (relative to the volume), refused when it leaves its root. */
export function diskPath(roots: DiskRoots, path: string): string {
  const [root, ...rest] = path.split("/");
  const base = roots[root as keyof DiskRoots];
  if (!base) throw new Error(`${path} is not under a root of this disk`);
  if (rest.some((segment) => segment === "" || segment === "." || segment === ".."))
    throw new Error(`${path} is not a plain relative path`);
  if (root === "harness" && ENGINE_FILES.has(rest[0] ?? "")) throw new Error(`${path} is the engine's own`);
  return rest.length === 0 ? base : posix.join(base, ...rest);
}

const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException)?.code === "ENOENT" || (error as NodeJS.ErrnoException)?.code === "ENOTDIR";

/** The disk's entries, in path order, at most `maxEntries + 1`. */
export async function listDisk(roots: DiskRoots, maxEntries: number): Promise<DiskListing> {
  const entries: DiskEntry[] = [];
  const full = () => entries.length > maxEntries;
  const walk = async (absolute: string, relative: string, top: boolean): Promise<void> => {
    let names: string[];
    try {
      names = (await readdir(absolute)).sort();
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    if (names.length === 0 && !top) {
      const info = await lstat(absolute);
      entries.push({ path: relative, type: "dir", size: 0, mode: info.mode & 0o7777, mtimeMs: Math.round(info.mtimeMs) });
      return;
    }
    for (const name of names) {
      if (full()) return;
      if (relative === "harness" && ENGINE_FILES.has(name)) continue;
      const path = `${relative}/${name}`;
      const child = posix.join(absolute, name);
      let info;
      try {
        info = await lstat(child);
      } catch (error) {
        if (missing(error)) continue;
        throw error;
      }
      const mode = info.mode & 0o7777;
      const mtimeMs = Math.round(info.mtimeMs);
      if (info.isSymbolicLink())
        entries.push({ path, type: "link", size: 0, mode, mtimeMs, target: await readlink(child) });
      else if (info.isDirectory()) await walk(child, path, false);
      else if (info.isFile()) entries.push({ path, type: "file", size: info.size, mode, mtimeMs });
    }
  };
  for (const [name, base] of Object.entries(roots)) if (base && !full()) await walk(base, name, true);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries: entries.slice(0, maxEntries + 1), truncated: full() };
}

/** `length` bytes of file `path` from `offset`, and whether that reached its end; undefined when gone. */
export async function readDisk(
  roots: DiskRoots,
  path: string,
  offset: number,
  length: number,
): Promise<{ bytes: Uint8Array; eof: boolean } | undefined> {
  let handle;
  try {
    handle = await open(diskPath(roots, path), "r");
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  try {
    const size = (await handle.stat()).size;
    const want = Math.max(0, Math.min(length, size - offset));
    const buffer = Buffer.alloc(want);
    let read = 0;
    while (read < want) {
      const { bytesRead } = await handle.read(buffer, read, want - read, offset + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return { bytes: new Uint8Array(buffer.subarray(0, read)), eof: offset + read >= size };
  } finally {
    await handle.close();
  }
}

/** Empties every root, keeping the engine's own files. */
export async function clearDisk(roots: DiskRoots): Promise<void> {
  for (const [name, base] of Object.entries(roots)) {
    if (!base) continue;
    await mkdir(base, { recursive: true });
    for (const child of await readdir(base)) {
      if (name === "harness" && ENGINE_FILES.has(child)) continue;
      await rm(posix.join(base, child), { recursive: true, force: true });
    }
  }
}

/** Writes `puts` in order: directories, files (or their next range) and links. */
export async function putDisk(roots: DiskRoots, puts: readonly DiskPut[]): Promise<void> {
  for (const put of puts) {
    const target = diskPath(roots, put.path);
    if (put.type === "dir") {
      await mkdir(target, { recursive: true });
      if (put.mode !== undefined) await chmod(target, put.mode);
      continue;
    }
    await mkdir(posix.dirname(target), { recursive: true });
    if (put.type === "link") {
      await rm(target, { force: true, recursive: true });
      await symlink(put.target ?? "", target);
      continue;
    }
    const bytes = put.bytes ?? new Uint8Array();
    if (put.append) await appendFile(target, bytes);
    else {
      const next = `${target}.${randomUUID()}.part`;
      await writeFile(next, bytes);
      await rm(target, { force: true, recursive: true });
      await rename(next, target);
    }
    if (put.mode !== undefined) await chmod(target, put.mode);
    if (put.mtimeMs !== undefined) await utimes(target, new Date(put.mtimeMs), new Date(put.mtimeMs));
  }
}

/** One disk operation, as core asks it of the workspace that holds the disk. */
export type DiskOp =
  | { readonly list: { readonly maxEntries: number } }
  | { readonly read: { readonly path: string; readonly offset: number; readonly length: number } }
  | { readonly clear: true }
  | { readonly put: readonly DiskPut[] };

/** Its answer. */
export type DiskAnswer =
  | ({ readonly kind: "listed" } & DiskListing)
  | { readonly kind: "read"; readonly bytes: Uint8Array; readonly eof: boolean }
  | { readonly kind: "missing" }
  | { readonly kind: "done" };

export async function runDiskOp(roots: DiskRoots, op: DiskOp): Promise<DiskAnswer> {
  if ("list" in op) return { kind: "listed", ...(await listDisk(roots, op.list.maxEntries)) };
  if ("read" in op) {
    const read = await readDisk(roots, op.read.path, op.read.offset, op.read.length);
    return read === undefined ? { kind: "missing" } : { kind: "read", ...read };
  }
  if ("clear" in op) await clearDisk(roots);
  else await putDisk(roots, op.put);
  return { kind: "done" };
}

/** A disk operation as it crosses the Harness API: bytes as base64. */
export type WireDiskOp =
  | { readonly list: { readonly maxEntries: number } }
  | { readonly read: { readonly path: string; readonly offset: number; readonly length: number } }
  | { readonly clear: true }
  | { readonly put: readonly (Omit<DiskPut, "bytes"> & { readonly base64?: string })[] };

export function toWireOp(op: DiskOp): WireDiskOp {
  if (!("put" in op)) return op;
  return {
    put: op.put.map(({ bytes, ...rest }) => ({
      ...rest,
      ...(bytes === undefined ? {} : { base64: Buffer.from(bytes).toString("base64") }),
    })),
  };
}

export function fromWireOp(op: WireDiskOp): DiskOp {
  if (!("put" in op)) return op;
  return {
    put: op.put.map(({ base64, ...rest }) => ({
      ...rest,
      ...(base64 === undefined ? {} : { bytes: new Uint8Array(Buffer.from(base64, "base64")) }),
    })),
  };
}

export function toWireAnswer(answer: DiskAnswer): Record<string, unknown> {
  return answer.kind === "read"
    ? { kind: "read", base64: Buffer.from(answer.bytes).toString("base64"), eof: answer.eof }
    : { ...answer };
}

export function fromWireAnswer(answer: Record<string, unknown>): DiskAnswer {
  if (answer.kind === "read")
    return { kind: "read", bytes: new Uint8Array(Buffer.from(String(answer.base64), "base64")), eof: answer.eof === true };
  return answer as DiskAnswer;
}
