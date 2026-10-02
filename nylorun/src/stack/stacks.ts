import { existsSync } from "node:fs";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { CliError } from "../errors.js";

/**
 * The machine's local stacks (tenancy.md §6): one installation per stack, each with its own
 * Host root `~/.nylorun/stacks/<name>/`, Compose project `nylorun-<name>`, ports and volumes.
 * `~/.nylorun` itself held the single stack of older releases (the legacy stack).
 */

/** A stack name: also part of its Compose project, so Compose's rules apply. */
export const STACK_NAME = /^[a-z0-9][a-z0-9_-]*$/;

/** `~/.nylorun`: the stacks, and the legacy stack's files. Tests pass another directory. */
export function defaultNylorunRoot(): string {
  return resolve(join(homedir(), ".nylorun"));
}

export function stacksDir(base: string): string {
  return join(base, "stacks");
}

export function stackRoot(base: string, name: string): string {
  return join(stacksDir(base), name);
}

export function assertStackName(name: string, source: string): string {
  if (!STACK_NAME.test(name))
    throw new CliError(
      `${source} must be lowercase letters, digits, "-" or "_", starting with a letter or digit: ${name}`,
      2,
    );
  return name;
}

/** A directory name as a stack name: lowercased, other characters as `-`, trimmed. */
export function sanitizeStackName(raw: string): string {
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return name === "" ? "stack" : name;
}

/** `stack.json` in a Host root: the stack's name and the project it was created for. */
export interface StackRecord {
  format: 1;
  name: string;
  /** The project directory `nylorun start` created the stack in; absent outside a project. */
  project?: string;
}

export function stackRecordPath(root: string): string {
  return join(root, "stack.json");
}

export async function readStackRecord(root: string): Promise<StackRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(stackRecordPath(root), "utf8")) as {
      name?: unknown;
      project?: unknown;
    };
    if (typeof value?.name !== "string" || !STACK_NAME.test(value.name)) return undefined;
    return {
      format: 1,
      name: value.name,
      ...(typeof value.project === "string" ? { project: value.project } : {}),
    };
  } catch {
    return undefined;
  }
}

export async function writeStackRecord(root: string, record: Omit<StackRecord, "format">): Promise<void> {
  const path = stackRecordPath(root);
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const body = { format: 1, name: record.name, ...(record.project ? { project: record.project } : {}) };
  await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export interface StackEntry {
  name: string;
  root: string;
  record?: StackRecord;
}

/** The stacks under `<base>/stacks`, by name. */
export async function listStacks(base: string): Promise<StackEntry[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(stacksDir(base), { withFileTypes: true });
  } catch {
    return [];
  }
  const stacks: StackEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !STACK_NAME.test(entry.name)) continue;
    const root = stackRoot(base, entry.name);
    const record = await readStackRecord(root);
    stacks.push({ name: entry.name, root, ...(record ? { record } : {}) });
  }
  return stacks.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The stack name for a project without a link: the directory's name, or the first `-2`,
 * `-3`, … suffix that no stack of another project directory holds. A stack this project
 * directory created keeps its name.
 */
export async function chooseStackName(base: string, projectDir: string): Promise<string> {
  const name = sanitizeStackName(basename(projectDir));
  const stacks = await listStacks(base);
  const candidate = new RegExp(`^${name}(?:-[0-9]+)?$`);
  const own = stacks.find((stack) => candidate.test(stack.name) && stack.record?.project === projectDir);
  if (own) return own.name;
  for (let suffix = 1; ; suffix += 1) {
    const next = suffix === 1 ? name : `${name}-${suffix}`;
    if (!existsSync(stackRoot(base, next))) return next;
  }
}

/** The single stack of older releases: Compose project `nylorun`, Host root `~/.nylorun`. */
export interface LegacyStack {
  root: string;
  project: "nylorun";
  compose: string;
  env: string;
}

export function legacyStack(base: string): LegacyStack | undefined {
  const compose = join(base, "stack", "compose.yaml");
  if (!existsSync(compose)) return undefined;
  return { root: base, project: "nylorun", compose, env: join(base, "stack", ".env") };
}

/** What `nylorun legacy delete` removes from `~/.nylorun`: the old layout only, never `stacks/`. */
export const LEGACY_ENTRIES = [
  "host.json",
  "host-credentials.json",
  "host-state.json",
  "stack",
  "tenants",
  "home",
  "tmp",
  "trash",
] as const;
