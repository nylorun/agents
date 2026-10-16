/**
 * Agent memory (track T5, D72): the one place memories change. The `memory` tool's commands
 * (Anthropic's memory tool: `create`, `str_replace`, `insert`, `delete`, `rename`) and the API's
 * writes both go through `applyMemoryCommand`, so paths, limits, versions and locks are the same
 * for a model and for a person. Reads are `viewMemory` (the tool's `view`) and the API's.
 *
 * Every change is a new row in `memory_versions` attributed to who made it; the Runtime never
 * rewrites what was written. A write takes a lock on each path it touches, in path order, so
 * writes to different memories never wait on each other. Answers to the model are Anthropic's
 * result strings; a refusal also carries a `memory.*` code.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  MEMORY_ROOT,
  memoryDescriptionOf,
  memoryPathOf,
  memoryPathWithin,
  type MemoryOperation,
  type MemorySummary,
  type MemoryVersion,
  type MemoryVersionDetail,
  type RuntimeLimits,
} from "@nylorun/core/contracts";
import type { MemoryRow, MemoryVersionRow, Tx } from "../store/types.js";

/** Who makes a write: `agent:<manifest>@<n>` with its session, turn and run, or an API caller. */
export interface MemoryAuthor {
  readonly actor: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly triggerRunId?: string;
}

/** One of the `memory` tool's write commands, with Anthropic's parameters. */
export type MemoryCommand =
  | { readonly command: "create"; readonly path: string; readonly fileText: string }
  | { readonly command: "str_replace"; readonly path: string; readonly oldStr: string; readonly newStr?: string }
  | { readonly command: "insert"; readonly path: string; readonly insertLine: number; readonly insertText: string }
  | { readonly command: "delete"; readonly path: string }
  | { readonly command: "rename"; readonly oldPath: string; readonly newPath: string };

/**
 * Why a command did not apply. `path_invalid`, `too_large` and `limit` are the Runtime's rules;
 * the rest are Anthropic's ordinary failures (a missing path, an `old_str` that is not there or
 * not unique, an `insert_line` out of range, a rename onto an existing path).
 */
export type MemoryRefusal =
  | "memory.path_invalid"
  | "memory.too_large"
  | "memory.limit"
  | "memory.not_found"
  | "memory.no_match"
  | "memory.not_unique"
  | "memory.invalid_line"
  | "memory.exists";

/** A memory a command changed: its path, what changed it and its version after. */
export interface MemoryChange {
  readonly path: string;
  readonly operation: MemoryOperation;
  readonly version: number;
}

/** A refused command or view: the code, and the text for the model. */
export interface MemoryRefused {
  readonly ok: false;
  readonly code: MemoryRefusal;
  readonly text: string;
}
/** What a command came to: the text for the model, and the changes, or why it was refused. */
export type MemoryResult = { readonly ok: true; readonly text: string; readonly changes: readonly MemoryChange[] } | MemoryRefused;
/** What a view came to: the listing or the text, or why it was refused. */
export type MemoryViewResult = { readonly ok: true; readonly text: string } | MemoryRefused;

/** A new version id: increasing with time, so versions page newest first by id. */
export function newMemoryVersionId(now = Date.now()): string {
  return `mv_${now.toString(36).padStart(9, "0")}${randomBytes(8).toString("hex")}`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const refused = (code: MemoryRefusal, text: string): MemoryRefused => ({ ok: false, code, text });
const missing = (path: string) => refused("memory.not_found", `The path ${path} does not exist. Please provide a valid path.`);

function pathOf(raw: string, kind: "file" | "any"): { path: string } | MemoryRefused {
  const parsed = memoryPathOf(raw, kind);
  return "error" in parsed ? refused("memory.path_invalid", parsed.error) : parsed;
}

/** A file's text with Anthropic's line numbers: six columns, a tab, the line. */
function numbered(text: string, start = 1): string {
  return text
    .split("\n")
    .map((line, index) => `${String(index + start).padStart(6, " ")}\t${line}`)
    .join("\n");
}

function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

/**
 * The tool's `view`: a memory's text with line numbers (`viewRange` `[start, end]`, 1-based,
 * `end` -1 for the last line), or a folder's listing two levels deep with sizes. `/memories`
 * lists even when the Agent has no memories.
 */
export async function viewMemory(
  t: Tx,
  agentId: string,
  rawPath: string,
  viewRange?: readonly [number, number],
): Promise<MemoryViewResult> {
  const parsed = pathOf(rawPath, "any");
  if (!("path" in parsed)) return parsed;
  const path = parsed.path;
  const row = path.endsWith(".md") ? await t.memory(agentId, path) : undefined;
  if (row) {
    const lines = row.content.split("\n");
    if (viewRange === undefined) return { ok: true, text: `Here's the content of ${path} with line numbers:\n${numbered(row.content)}` };
    const [start, end] = viewRange;
    const last = end === -1 ? lines.length : end;
    if (!Number.isInteger(start) || !Number.isInteger(last) || start < 1 || start > lines.length || last < start || last > lines.length)
      return refused("memory.invalid_line", `Invalid view_range [${start}, ${end}]: ${path} has ${lines.length} lines.`);
    return {
      ok: true,
      text: `Here's the content of ${path} with line numbers:\n${numbered(lines.slice(start - 1, last).join("\n"), start)}`,
    };
  }
  const rows = await t.memories(agentId, { folder: path });
  if (rows.length === 0 && path !== MEMORY_ROOT) return missing(path);
  // Folders are the prefixes of memory paths: list what is one or two levels below `path`.
  const sizes = new Map<string, number>();
  for (const memory of rows) {
    const rest = memory.path.slice(path.length + 1).split("/");
    for (let depth = 1; depth <= Math.min(2, rest.length); depth++) {
      const entry = `${path}/${rest.slice(0, depth).join("/")}`;
      sizes.set(entry, (sizes.get(entry) ?? 0) + memory.bytes);
    }
  }
  const total = rows.reduce((sum, memory) => sum + memory.bytes, 0);
  const lines = [`${sizeOf(total)}\t${path}`, ...[...sizes.keys()].sort().map((entry) => `${sizeOf(sizes.get(entry)!)}\t${entry}`)];
  return {
    ok: true,
    text: `Here're the files and directories up to 2 levels deep in ${path}, excluding hidden items and node_modules:\n${lines.join("\n")}`,
  };
}

interface Applied {
  readonly t: Tx;
  readonly agentId: string;
  readonly author: MemoryAuthor;
  readonly limits: Pick<RuntimeLimits, "memoryBytes" | "memoriesPerAgent">;
  readonly now: string;
}

function tooLarge(content: string, limits: Applied["limits"]): MemoryRefused | undefined {
  const bytes = Buffer.byteLength(content, "utf8");
  return bytes > limits.memoryBytes
    ? refused(
        "memory.too_large",
        `A memory is at most ${limits.memoryBytes} bytes (the Runtime limit memoryBytes); this one would be ${bytes}. Split it into smaller files.`,
      )
    : undefined;
}

/** Writes `content` at `path` (row `before`, locked, when it exists) and records the version. */
async function write(
  a: Applied,
  path: string,
  before: MemoryRow | undefined,
  content: string,
  operation: MemoryOperation,
  fromPath?: string,
): Promise<MemoryChange> {
  const contentSha256 = sha256(content);
  const bytes = Buffer.byteLength(content, "utf8");
  const version = (before?.version ?? 0) + 1;
  await a.t.putMemory({
    agentId: a.agentId,
    path,
    content,
    contentSha256,
    bytes,
    description: memoryDescriptionOf(content),
    version,
    updatedAt: a.now,
  });
  await a.t.insertMemoryVersion(versionRow(a, { path, fromPath: fromPath ?? null, operation, content, contentSha256, bytes }));
  return { path, operation, version };
}

function versionRow(
  a: Applied,
  change: Pick<MemoryVersionRow, "path" | "fromPath" | "operation" | "content" | "contentSha256" | "bytes">,
): MemoryVersionRow {
  return {
    id: newMemoryVersionId(Date.parse(a.now)),
    agentId: a.agentId,
    ...change,
    actor: a.author.actor,
    sessionId: a.author.sessionId ?? null,
    turnId: a.author.turnId ?? null,
    triggerRunId: a.author.triggerRunId ?? null,
    createdAt: a.now,
  };
}

/** Deletes `row` (locked) and records the delete. */
async function remove(a: Applied, row: MemoryRow): Promise<MemoryChange> {
  await a.t.deleteMemory(a.agentId, row.path);
  await a.t.insertMemoryVersion(
    versionRow(a, { path: row.path, fromPath: null, operation: "delete", content: null, contentSha256: null, bytes: null }),
  );
  return { path: row.path, operation: "delete", version: row.version + 1 };
}

/** Locks the memories at `paths` (in path order, so two writes never wait on each other's locks). */
async function lockPaths(t: Tx, agentId: string, paths: readonly string[]): Promise<Map<string, MemoryRow | undefined>> {
  const rows = new Map<string, MemoryRow | undefined>();
  for (const path of [...new Set(paths)].sort()) rows.set(path, await t.memory(agentId, path, { lock: true }));
  return rows;
}

/**
 * Applies one write command to Agent `agentId`'s memories in `t`, as `author`, within the
 * Runtime limits. Access is the caller's to check. A command that changes nothing (a `create`
 * with the same text) makes no version.
 */
export async function applyMemoryCommand(
  t: Tx,
  agentId: string,
  command: MemoryCommand,
  author: MemoryAuthor,
  limits: Applied["limits"],
  now = new Date().toISOString(),
): Promise<MemoryResult> {
  const a: Applied = { t, agentId, author, limits, now };
  switch (command.command) {
    case "create":
      return create(a, command.path, command.fileText);
    case "str_replace":
      return strReplace(a, command.path, command.oldStr, command.newStr ?? "");
    case "insert":
      return insert(a, command.path, command.insertLine, command.insertText);
    case "delete":
      return del(a, command.path);
    case "rename":
      return rename(a, command.oldPath, command.newPath);
  }
}

async function create(a: Applied, rawPath: string, content: string): Promise<MemoryResult> {
  const parsed = pathOf(rawPath, "file");
  if (!("path" in parsed)) return parsed;
  const path = parsed.path;
  const big = tooLarge(content, a.limits);
  if (big) return big;
  const before = (await lockPaths(a.t, a.agentId, [path])).get(path);
  // A memory can't share its path with a folder of memories.
  if (!before && (await a.t.memories(a.agentId, { folder: path, limit: 1 })).length > 0)
    return refused("memory.exists", `${path} is a folder of memories`);
  if (before?.content === content) return { ok: true, text: `File created successfully at: ${path}`, changes: [] };
  if (!before && (await a.t.countMemories(a.agentId)) >= a.limits.memoriesPerAgent)
    return refused(
      "memory.limit",
      `This Agent holds ${a.limits.memoriesPerAgent} memories, the most the Runtime limit memoriesPerAgent allows. Delete or merge some first.`,
    );
  const change = await write(a, path, before, content, "create");
  return { ok: true, text: `File created successfully at: ${path}`, changes: [change] };
}

async function strReplace(a: Applied, rawPath: string, oldStr: string, newStr: string): Promise<MemoryResult> {
  const parsed = pathOf(rawPath, "file");
  if (!("path" in parsed)) return parsed;
  const path = parsed.path;
  const before = (await lockPaths(a.t, a.agentId, [path])).get(path);
  if (!before) return missing(path);
  if (oldStr === "") return refused("memory.no_match", "old_str is empty: give the text to replace.");
  const lines: number[] = [];
  for (let at = before.content.indexOf(oldStr); at !== -1; at = before.content.indexOf(oldStr, at + 1))
    lines.push(before.content.slice(0, at).split("\n").length);
  if (lines.length === 0)
    return refused("memory.no_match", `No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${path}.`);
  if (lines.length > 1)
    return refused(
      "memory.not_unique",
      `No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines: ${lines.join(", ")}. Please ensure it is unique`,
    );
  const content = before.content.replace(oldStr, () => newStr);
  const big = tooLarge(content, a.limits);
  if (big) return big;
  const change = await write(a, path, before, content, "str_replace");
  // Anthropic answers with the edited lines around the change.
  const line = lines[0]!;
  const all = content.split("\n");
  const from = Math.max(1, line - 4);
  const to = Math.min(all.length, line + newStr.split("\n").length + 3);
  return {
    ok: true,
    text: `The memory file has been edited.\n${numbered(all.slice(from - 1, to).join("\n"), from)}`,
    changes: [change],
  };
}

async function insert(a: Applied, rawPath: string, insertLine: number, insertText: string): Promise<MemoryResult> {
  const parsed = pathOf(rawPath, "file");
  if (!("path" in parsed)) return parsed;
  const path = parsed.path;
  const before = (await lockPaths(a.t, a.agentId, [path])).get(path);
  if (!before) return missing(path);
  const lines = before.content.split("\n");
  if (!Number.isInteger(insertLine) || insertLine < 0 || insertLine > lines.length)
    return refused(
      "memory.invalid_line",
      `Invalid \`insert_line\` parameter: ${insertLine}. It should be within the range of lines of the file: [0, ${lines.length}]`,
    );
  const added = insertText.endsWith("\n") ? insertText.slice(0, -1) : insertText;
  lines.splice(insertLine, 0, ...added.split("\n"));
  const content = lines.join("\n");
  const big = tooLarge(content, a.limits);
  if (big) return big;
  const change = await write(a, path, before, content, "insert");
  return { ok: true, text: `The file ${path} has been edited.`, changes: [change] };
}

async function del(a: Applied, rawPath: string): Promise<MemoryResult> {
  const parsed = pathOf(rawPath, "any");
  if (!("path" in parsed)) return parsed;
  const path = parsed.path;
  if (path === MEMORY_ROOT) return refused("memory.path_invalid", `${MEMORY_ROOT} itself can't be deleted: delete what is in it.`);
  const file = path.endsWith(".md") ? (await lockPaths(a.t, a.agentId, [path])).get(path) : undefined;
  const rows = file ? [file] : await a.t.memories(a.agentId, { folder: path, lock: true });
  if (rows.length === 0) return missing(path);
  const changes: MemoryChange[] = [];
  for (const row of rows) changes.push(await remove(a, row));
  return { ok: true, text: `Successfully deleted ${path}`, changes };
}

async function rename(a: Applied, rawOld: string, rawNew: string): Promise<MemoryResult> {
  const from = pathOf(rawOld, "any");
  if (!("path" in from)) return from;
  const oldPath = from.path;
  if (oldPath === MEMORY_ROOT) return refused("memory.path_invalid", `${MEMORY_ROOT} itself can't be renamed.`);
  const isFile = oldPath.endsWith(".md") && (await a.t.memory(a.agentId, oldPath)) !== undefined;
  const to = pathOf(rawNew, isFile ? "file" : "any");
  if (!("path" in to)) return to;
  const newPath = to.path;
  if (newPath === MEMORY_ROOT || memoryPathWithin(newPath, oldPath))
    return refused("memory.path_invalid", `Can't rename ${oldPath} to ${newPath}: it would move into itself.`);
  if (isFile) {
    const rows = await lockPaths(a.t, a.agentId, [oldPath, newPath]);
    const row = rows.get(oldPath);
    if (!row) return missing(oldPath);
    if (rows.get(newPath) || (await a.t.memories(a.agentId, { folder: newPath, limit: 1 })).length > 0)
      return refused("memory.exists", `The destination ${newPath} already exists`);
    await a.t.deleteMemory(a.agentId, oldPath);
    const change = await write(a, newPath, { ...row, version: 0 }, row.content, "rename", oldPath);
    return { ok: true, text: `Successfully renamed ${oldPath} to ${newPath}`, changes: [change] };
  }
  const rows = await a.t.memories(a.agentId, { folder: oldPath, lock: true });
  if (rows.length === 0) return missing(oldPath);
  const targets = rows.map((row) => `${newPath}${row.path.slice(oldPath.length)}`);
  for (const target of targets)
    if ("error" in memoryPathOf(target, "file"))
      return refused("memory.path_invalid", `Renaming ${oldPath} to ${newPath} would make ${target}, which is too long or invalid.`);
  const taken = await lockPaths(a.t, a.agentId, [newPath, ...targets]);
  if ([...taken.values()].some(Boolean) || (await a.t.memories(a.agentId, { folder: newPath, limit: 1 })).length > 0)
    return refused("memory.exists", `The destination ${newPath} already exists`);
  const changes: MemoryChange[] = [];
  for (const [index, row] of rows.entries()) {
    await a.t.deleteMemory(a.agentId, row.path);
    changes.push(await write(a, targets[index]!, { ...row, version: 0 }, row.content, "rename", row.path));
  }
  return { ok: true, text: `Successfully renamed ${oldPath} to ${newPath}`, changes };
}

// --- views ---------------------------------------------------------------------

export function memorySummaryOf(row: MemoryRow): MemorySummary {
  return {
    path: row.path,
    bytes: row.bytes,
    contentSha256: row.contentSha256,
    description: row.description,
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

export function memoryVersionOf(row: MemoryVersionRow): MemoryVersion {
  return {
    id: row.id,
    path: row.path,
    fromPath: row.fromPath,
    operation: row.operation,
    bytes: row.bytes,
    contentSha256: row.contentSha256,
    actor: row.actor,
    sessionId: row.sessionId,
    turnId: row.turnId,
    triggerRunId: row.triggerRunId,
    createdAt: row.createdAt,
  };
}

export function memoryVersionDetailOf(row: MemoryVersionRow): MemoryVersionDetail {
  return { ...memoryVersionOf(row), content: row.content };
}
