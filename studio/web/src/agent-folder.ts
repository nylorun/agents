/**
 * Agent folders in Studio (track T7): Upload folder and a version's Source view. A folder picked
 * in the browser is hashed with WebCrypto, the files the Runtime does not hold are uploaded by
 * hash (`HEAD`, then `PUT /v1/files/sha256:<hex>`), and the folder is sent by hash to
 * `PUT /v1/agent-manifests/{name}` (`application/vnd.nylorun.folder+json`): first with
 * `?dryRun=true` for the plan and the compiler's diagnostics, then, on confirm, to save it. The
 * Runtime compiles it, as `nylorun apply` has it do. No React here, so
 * `scripts/agent-folder.test.mjs` runs it without a browser.
 */
import type {
  AgentFolderDiagnostic,
  AgentManifestChange,
  AgentManifestPlan,
  AgentManifestSource,
  AgentManifestSourceDiff,
  SaveAgentManifestResponse,
} from "@nylorun/agents";

/** The media type of an agent folder sent by hash (`AGENT_FOLDER_MEDIA_TYPE`). */
export const FOLDER_MEDIA_TYPE = "application/vnd.nylorun.folder+json";

/** Directories Upload folder leaves out, as `nylorun apply` does. */
export const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([".git", ".hg", ".svn", "node_modules"]);

/** What a browser gives for one file of a picked directory (`<input webkitdirectory>`). */
export type BrowserFile = Readonly<{
  /** `dir/sub/file.md`: the picked directory's name, then the path in it. */
  webkitRelativePath: string;
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** One file of a picked folder, by its path in the folder. */
export type FolderFile = Readonly<{ path: string; size: number; read(): Promise<Uint8Array> }>;

export type PickedFolder = Readonly<{
  /** The picked directory's name. */
  dir: string;
  /** Every file, sorted by path, with `/` between segments. */
  files: readonly FolderFile[];
  /** How many files a skipped directory held. */
  skipped: number;
}>;

/** One file of a folder as the Runtime takes it: path, size and SHA-256 (lowercase hex). */
export type FolderEntry = Readonly<{ path: string; size: number; sha256: string }>;

const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * The folder a browser picked: each file by its path in the directory (its `webkitRelativePath`
 * without the directory's own name), leaving out what `.git`, `.hg`, `.svn` and `node_modules`
 * hold, as `nylorun apply` does.
 */
export function pickedFolder(picked: Iterable<BrowserFile>): PickedFolder {
  let dir = "";
  let skipped = 0;
  const files: FolderFile[] = [];
  for (const file of picked) {
    const segments = (file.webkitRelativePath || file.name).split("/").filter(Boolean);
    if (segments.length > 1) dir ||= segments[0]!;
    const inside = segments.length > 1 ? segments.slice(1) : segments;
    if (inside.slice(0, -1).some((segment) => SKIPPED_DIRECTORIES.has(segment))) {
      skipped++;
      continue;
    }
    files.push({
      path: inside.join("/"),
      size: file.size,
      read: async () => new Uint8Array(await file.arrayBuffer()),
    });
  }
  return { dir, files: files.sort(byPath), skipped };
}

/** The SHA-256 of `bytes`, as 64 lowercase hex digits (WebCrypto). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A folder hashed: its entries, and each file's bytes by hash for the upload. */
export type HashedFolder = Readonly<{
  entries: readonly FolderEntry[];
  /** `AGENT.md`'s text, when the folder has one. */
  agentMd?: string;
  /** Reads a file's bytes by its hash. */
  bytesOf: ReadonlyMap<string, () => Promise<Uint8Array>>;
}>;

/** Hashes every file of `folder`, reporting each one done. */
export async function hashFolder(
  folder: PickedFolder,
  onProgress: (done: number, total: number) => void = () => {},
): Promise<HashedFolder> {
  const entries: FolderEntry[] = [];
  const bytesOf = new Map<string, () => Promise<Uint8Array>>();
  let agentMd: string | undefined;
  for (const file of folder.files) {
    const bytes = await file.read();
    const sha256 = await sha256Hex(bytes);
    entries.push({ path: file.path, size: bytes.byteLength, sha256 });
    bytesOf.set(sha256, file.read);
    if (file.path === "AGENT.md") agentMd = new TextDecoder().decode(bytes);
    onProgress(entries.length, folder.files.length);
  }
  return { entries, bytesOf, ...(agentMd === undefined ? {} : { agentMd }) };
}

/**
 * The name the manifest takes: `AGENT.md`'s frontmatter `name`, or else the directory's, which the
 * compiler then checks as the Runtime does.
 */
export function folderName(agentMd: string | undefined, dir: string): string {
  const front = agentMd?.replace(/^﻿/, "").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const line = front?.[1]!.split(/\r?\n/).find((item) => /^name\s*:/.test(item));
  const name = line
    ?.replace(/^name\s*:\s*/, "")
    .replace(/\s+#.*$/, "")
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2");
  return name || dir;
}

/** What Upload folder asks of the Runtime, through Studio's server. */
export type FolderRuntime = Readonly<{
  /** Whether the Runtime holds the file `sha256:<hex>` names (`HEAD /v1/files/...`). */
  has(sha256: string, signal?: AbortSignal): Promise<boolean>;
  /** Uploads one file by its hash (`PUT /v1/files/...`). */
  upload(bytes: Uint8Array, sha256: string, signal?: AbortSignal): Promise<unknown>;
  /** One request to the Runtime API, by path. */
  fetch(path: string, init: RequestInit): Promise<Response>;
}>;

/**
 * Uploads each file of `folder` the Runtime does not hold, once per hash; answers how many it
 * uploaded.
 */
export async function uploadMissing(
  runtime: FolderRuntime,
  folder: HashedFolder,
  onProgress: (done: number, total: number) => void = () => {},
  signal?: AbortSignal,
): Promise<number> {
  const hashes = [...new Set(folder.entries.map((entry) => entry.sha256))];
  let uploaded = 0;
  for (const [index, sha256] of hashes.entries()) {
    if (!(await runtime.has(`sha256:${sha256}`, signal))) {
      await runtime.upload(await folder.bytesOf.get(sha256)!(), `sha256:${sha256}`, signal);
      uploaded++;
    }
    onProgress(index + 1, hashes.length);
  }
  return uploaded;
}

/** A save or plan the Runtime refused: its status, code, message, and the compiler's diagnostics. */
export class FolderRefusedError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly diagnostics: readonly AgentFolderDiagnostic[];
  constructor(status: number, code: string | undefined, message: string, diagnostics: readonly AgentFolderDiagnostic[] = []) {
    super(message);
    this.name = "FolderRefusedError";
    this.status = status;
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

/**
 * Sends `entries` as agent folder `name` (`PUT /v1/agent-manifests/{name}`): the plan with
 * `dryRun`, else the save, under `If-Match` when `ifMatch` is given.
 */
export async function sendFolder(
  runtime: FolderRuntime,
  name: string,
  entries: readonly FolderEntry[],
  options: { dryRun: true; ifMatch?: number; signal?: AbortSignal },
): Promise<AgentManifestPlan>;
export async function sendFolder(
  runtime: FolderRuntime,
  name: string,
  entries: readonly FolderEntry[],
  options: { dryRun?: false; ifMatch?: number; signal?: AbortSignal },
): Promise<SaveAgentManifestResponse>;
export async function sendFolder(
  runtime: FolderRuntime,
  name: string,
  entries: readonly FolderEntry[],
  options: { dryRun?: boolean; ifMatch?: number; signal?: AbortSignal },
): Promise<AgentManifestPlan | SaveAgentManifestResponse> {
  const response = await runtime.fetch(
    `/v1/agent-manifests/${encodeURIComponent(name)}${options.dryRun ? "?dryRun=true" : ""}`,
    {
      method: "PUT",
      headers: {
        "content-type": FOLDER_MEDIA_TYPE,
        ...(options.ifMatch === undefined ? {} : { "if-match": String(options.ifMatch) }),
      },
      body: JSON.stringify({
        requestId: globalThis.crypto.randomUUID(),
        format: "nylorun.folder.v2",
        entries: entries.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  const body = (await response.json().catch(() => undefined)) as
    | { message?: unknown; code?: unknown; details?: { diagnostics?: unknown } }
    | undefined;
  if (!response.ok)
    throw new FolderRefusedError(
      response.status,
      typeof body?.code === "string" ? body.code : undefined,
      typeof body?.message === "string" && body.message ? body.message : `The Runtime refused the folder (${response.status}).`,
      Array.isArray(body?.details?.diagnostics) ? (body.details.diagnostics as AgentFolderDiagnostic[]) : [],
    );
  return body as AgentManifestPlan | SaveAgentManifestResponse;
}

// --- The plan ---------------------------------------------------------------------------------

const SEVERITY_ORDER: Record<AgentFolderDiagnostic["severity"], number> = { error: 0, warning: 1, info: 2, note: 3 };

/** Where a diagnostic is: `file:line:column`, or the file alone. */
export function diagnosticPlace(diagnostic: AgentFolderDiagnostic): string {
  if (!diagnostic.file) return "";
  return `${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}${diagnostic.column ? `:${diagnostic.column}` : ""}` : ""}`;
}

/** Diagnostics by severity (errors first), then file and line. */
export function sortedDiagnostics(diagnostics: readonly AgentFolderDiagnostic[]): AgentFolderDiagnostic[] {
  return [...diagnostics].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      (a.file ?? "").localeCompare(b.file ?? "") ||
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.column ?? 0) - (b.column ?? 0),
  );
}

/** A value in a change line: JSON, cut to `max` characters. */
export function shortValue(value: unknown, max = 80): string {
  const text = typeof value === "string" ? JSON.stringify(value) : (JSON.stringify(value) ?? "undefined");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** One change of the plan as a line of a diff: `+` added, `-` removed, `~` replaced. */
export type PlanChangeLine = Readonly<{
  mark: "+" | "-" | "~";
  /** The field, with its section: `harness.mcpServers.github`, or `description` at the top. */
  field: string;
  /** What it becomes, what it was, or both: `"virtual" → "pod"`. */
  text: string;
}>;

/** The plan's changes as the lines of a diff, in the order the Runtime gives them. */
export function planChangeLines(changes: readonly AgentManifestChange[]): PlanChangeLine[] {
  return changes.map((change) => {
    const field = change.section === "manifest" ? change.path : [change.section, change.path].filter(Boolean).join(".");
    if (change.op === "add") return { mark: "+", field, text: shortValue(change.to) };
    if (change.op === "remove") return { mark: "-", field, text: shortValue(change.from) };
    return { mark: "~", field, text: `${shortValue(change.from, 38)} → ${shortValue(change.to, 38)}` };
  });
}

/** What a plan says first: what a save would do, or why it would be refused. */
export function planHeadline(plan: Pick<AgentManifestPlan, "from" | "to" | "unchanged" | "errors" | "name">): string {
  if (plan.errors.length > 0)
    return `Not saved: ${plan.errors.length === 1 ? "1 error" : `${plan.errors.length} errors`}`;
  if (plan.unchanged) return `Unchanged: v${plan.to} already holds this manifest`;
  return plan.from === null ? `Saves ${plan.name} v${plan.to}, a new manifest` : `Saves v${plan.to} of ${plan.name}, over v${plan.from}`;
}

// --- The Source view --------------------------------------------------------------------------

/** One line of a version's source tree: a directory, or a file with its size. */
export type SourceRow = Readonly<{
  path: string;
  name: string;
  depth: number;
  kind: "dir" | "file";
  size?: number;
  /** Since the version compared with: a file `to` added or changed. */
  change?: "added" | "changed";
}>;

/**
 * A version's files as a tree, each directory before its files and both by name; with `diff`,
 * each file marked added or changed since the version it compares with.
 */
export function sourceTree(
  entries: AgentManifestSource["entries"],
  diff?: Pick<AgentManifestSourceDiff, "added" | "changed">,
): SourceRow[] {
  type Node = { dirs: Map<string, Node>; files: { name: string; path: string; size: number }[] };
  const root: Node = { dirs: new Map(), files: [] };
  for (const entry of entries) {
    const segments = entry.path.split("/");
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      let next = node.dirs.get(segment);
      if (!next) node.dirs.set(segment, (next = { dirs: new Map(), files: [] }));
      node = next;
    }
    node.files.push({ name: segments.at(-1)!, path: entry.path, size: entry.size });
  }
  const added = new Set(diff?.added.map((entry) => entry.path));
  const changed = new Set(diff?.changed.map((entry) => entry.path));
  const rows: SourceRow[] = [];
  const walk = (node: Node, prefix: string, depth: number) => {
    for (const name of [...node.dirs.keys()].sort()) {
      const path = `${prefix}${name}`;
      rows.push({ path: `${path}/`, name, depth, kind: "dir" });
      walk(node.dirs.get(name)!, `${path}/`, depth + 1);
    }
    for (const file of [...node.files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const change = added.has(file.path) ? "added" : changed.has(file.path) ? "changed" : undefined;
      rows.push({ path: file.path, name: file.name, depth, kind: "file", size: file.size, ...(change ? { change } : {}) });
    }
  };
  walk(root, "", 0);
  return rows;
}

/** "2 changed, 1 added and 1 removed since v2", or "Same files as v2". */
export function diffSummary(diff: AgentManifestSourceDiff): string {
  const parts = [
    ...(diff.changed.length ? [`${diff.changed.length} changed`] : []),
    ...(diff.added.length ? [`${diff.added.length} added`] : []),
    ...(diff.removed.length ? [`${diff.removed.length} removed`] : []),
  ];
  if (parts.length === 0) return `Same files as v${diff.from}`;
  return `${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`} since v${diff.from}`;
}

/**
 * A file's text, or undefined for one that is not UTF-8 text (it holds a NUL, or does not
 * decode). A preview cut short may end inside a character, which is not an error.
 */
export function fileText(bytes: Uint8Array, truncated = false): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: truncated });
  } catch {
    return undefined;
  }
}
