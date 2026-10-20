/**
 * What the agent folder compiler hands the code that compiles the folders inside a folder
 * (`nested.ts`, `flow.ts`, `plugins.ts`): the folder's entries and files, what it has read so far,
 * and its own ways to report, read and derive. Nothing here reads a file system: like the
 * compiler, it is pure.
 */
import type { AgentFolderDiagnostic, AgentFolderEntry, CompileAgentFolderInput, CompiledAgentFolder } from "./compile.js";
import { parseJson, pointerOf, type Located, type Position } from "./json.js";

/** A JSON Schema named by `/x` from a folder inside another: found, refused, or already reported. */
export type SchemaLookup = { readonly schema: Record<string, unknown> } | { readonly code: string; readonly message: string } | undefined;

/** How the folder that holds this one sees it. Set by the compiler for each folder inside another. */
export interface FolderScope {
  /** A subagent (`agents/<id>/` of an agent), a stage of a flow, or a plugin's skills and servers. */
  readonly role: "subagent" | "stage" | "plugin";
  /** For a stage: the flow root's `agents/`, which every `flow.json` under the root names. */
  readonly namespace?: FlowNamespaceLike;
  /** Derives a slot in the uploaded folder's runtime section; `file` is this folder's. */
  readonly deriveSlot: (credential: string, type: "bearer" | "headers", url: string, file: string, at: Position | undefined, header?: string) => void;
  /** `/x`: a JSON Schema file of the uploaded folder, by its path there. */
  readonly schema: (target: string) => SchemaLookup;
}

/** What a loop manifest embeds for an agent of a flow: agent manifest v7 or workflow manifest v3. */
export type EmbeddedAgent = Record<string, unknown>;

/** A flow root's `agents/`: the stages its flows name by id. */
export interface FlowNamespaceLike {
  readonly ids: readonly string[];
  readonly used: Set<string>;
  /** The stage's manifest, or why there is none: an unknown id, a cycle, or errors reported already. */
  resolve(id: string): EmbeddedAgent | "unknown" | "cycle" | "failed";
}

type Severity = AgentFolderDiagnostic["severity"];
export type ReportOptions = { key?: boolean; at?: Position; pointer?: string };
export type Report = (severity: Severity, code: string, message: string, file?: string, path?: readonly PropertyKey[], options?: ReportOptions) => void;
export type Origins = [readonly PropertyKey[], { readonly file: string; readonly path: readonly PropertyKey[] }][];

/** One folder's compile, as the parts inside it see it. */
export interface FolderContext {
  readonly scope: FolderScope | undefined;
  /** The folder's valid entries, by path. */
  readonly entries: ReadonlyMap<string, AgentFolderEntry>;
  /** The bytes of the files the compiler reads (`folderTextPaths`), by path. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  /** What each valid path is (`classify` in compile.ts). */
  readonly kinds: ReadonlyMap<string, string>;
  /** `AGENT.md`'s frontmatter, and its body. */
  readonly front: Record<string, unknown>;
  readonly agent: { readonly body: string; readonly bodyLine: number } | undefined;
  /** The harness section being built. */
  readonly harness: Record<string, unknown>;
  readonly origins: Origins;
  readonly diagnostics: AgentFolderDiagnostic[];
  readonly report: Report;
  readonly readJson: (path: string) => Record<string, unknown> | undefined;
  readonly schemaAt: (file: string, field: readonly PropertyKey[], value: unknown) => Record<string, unknown> | undefined;
  readonly deriveSlot: (
    credential: string,
    type: "bearer" | "headers",
    url: string,
    file: string,
    path: readonly PropertyKey[],
    header?: string,
    at?: Position,
  ) => void;
  readonly suggest: (name: string, known: readonly string[]) => string | undefined;
  readonly compile: (input: CompileAgentFolderInput, scope?: FolderScope) => CompiledAgentFolder;
  readonly folderTextPaths: (entries: readonly AgentFolderEntry[]) => string[];
}

export const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The folders directly under `top/` (`agents`, `plugins`), each with its paths inside it. */
export function foldersUnder(top: string, paths: Iterable<string>): Map<string, string[]> {
  const folders = new Map<string, string[]>();
  for (const path of paths) {
    const segments = path.split("/");
    if (segments[0] !== top || segments.length < 3) continue;
    const name = segments[1]!;
    folders.set(name, [...(folders.get(name) ?? []), segments.slice(2).join("/")]);
  }
  return new Map([...folders].sort(([a], [b]) => compare(a, b)));
}

/** A diagnostic of a folder inside this one, with its path from this folder; the manifest pointer is the inner folder's, so it is left out. */
export function addInner(ctx: FolderContext, prefix: string, inner: readonly AgentFolderDiagnostic[], file: (path: string) => string = (path) => prefix + path) {
  for (const item of inner) {
    const where = item.file === undefined ? (item.code === "agent_missing" ? `${prefix}AGENT.md` : prefix.replace(/\/$/, "")) : file(item.file);
    const moved: AgentFolderDiagnostic = {
      severity: item.severity,
      code: item.code,
      message: item.message,
      file: where,
      ...(item.line === undefined ? {} : { line: item.line, column: item.column }),
    };
    const key = JSON.stringify(moved);
    if (!ctx.diagnostics.some((existing) => JSON.stringify(existing) === key)) ctx.diagnostics.push(moved);
  }
}

const parsedJson = new WeakMap<Uint8Array, ReadonlyMap<string, Located> | null>();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Where `path` is in a JSON file of the folder this compile has not parsed itself (a plugin's, say). */
export function jsonPosition(ctx: FolderContext, file: string, path: readonly PropertyKey[], key = false): Position | undefined {
  const bytes = ctx.files.get(file);
  if (!bytes) return undefined;
  if (!parsedJson.has(bytes)) {
    let positions: ReadonlyMap<string, Located> | null = null;
    try {
      const result = parseJson(decoder.decode(bytes).replace(/^﻿/, ""));
      if (result.ok) positions = result.positions;
    } catch {
      positions = null;
    }
    parsedJson.set(bytes, positions);
  }
  const positions = parsedJson.get(bytes);
  if (!positions) return undefined;
  for (let length = path.length; length >= 0; length--) {
    const found = positions.get(pointerOf(path.slice(0, length)));
    if (found) return key && length === path.length ? (found.key ?? found.value) : found.value;
  }
  return undefined;
}

/** A JSON file's top-level value, read quietly: undefined when it is not a JSON object. */
export function quietJson(ctx: FolderContext, file: string): Record<string, unknown> | undefined {
  const bytes = ctx.files.get(file);
  if (!bytes) return undefined;
  try {
    const result = parseJson(decoder.decode(bytes).replace(/^﻿/, ""));
    return result.ok && isObject(result.value) ? result.value : undefined;
  } catch {
    return undefined;
  }
}

/** A deep copy of plain JSON data, so a manifest never shares objects with a constant. */
export const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
